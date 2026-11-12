#!/usr/bin/env node
'use strict';

/*
 * herdr-notify
 *
 * Reports CodeBuddy lifecycle state to Herdr.
 *
 * Two delivery paths, because the two Herdr products consume state differently:
 *   1. Herdr app (herdr-core / hc): reads OSC 7501 from the pane's pty.
 *      Over SSH the sequence simply travels with the rest of the terminal bytes,
 *      so this also works when CodeBuddy runs on a remote Linux box.
 *   2. Herdr TUI: speaks the socket API through 'herdr pane report-agent'.
 *      We use it when HERDR_ENV=1 points at the TUI binary.
 *
 * The hook's stdout belongs to CodeBuddy, so OSC is written to /dev/tty, never
 * to stdout. Anything unexpected is swallowed: a status reporter must never
 * block or fail an agent turn.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const APP = 'codebuddy';
const LABEL = 'CodeBuddy';
const SOURCE = 'codebuddy';
const AGENT = 'CodeBuddy';
const RESUME_COMMAND = 'codebuddy';

// CodeBuddy's --session-id accepts letters, digits, hyphens, underscores and
// colons, and must start with a letter or digit.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
// Herdr pane addresses look like w1:p1 or machine/t7; reject option-like values.
const PANE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:/_-]{0,127}$/;

const MAX_INPUT = 1024 * 1024;
const MAX_STATE = 4096;

const DEBUG_LOG = process.env.HERDR_NOTIFY_DEBUG || '';
const DRY_RUN = process.argv.indexOf('--dry-run') !== -1;
const O_NOFOLLOW = fs.constants.O_NOFOLLOW || 0;
const O_NONBLOCK = fs.constants.O_NONBLOCK || 0;

function stateBase() {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && path.isAbsolute(runtime)) return path.join(runtime, 'herdr-notify');
  let id = 'user';
  if (typeof process.getuid === 'function') {
    id = String(process.getuid());
  } else {
    try {
      id = os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_');
    } catch (_) {}
  }
  return path.join(os.tmpdir(), 'herdr-notify-' + id);
}

const STATE_DIR = stateBase();

function debug(record) {
  if (!DEBUG_LOG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true, mode: 0o700 });
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW;
    const fd = fs.openSync(DEBUG_LOG, flags, 0o600);
    try {
      try { fs.fchmodSync(fd, 0o600); } catch (_) {}
      fs.writeSync(fd, JSON.stringify(Object.assign({ ts: new Date().toISOString() }, record)) + '\n');
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {}
}

// A status reporter must never fail a turn, even on an unexpected throw.
process.on('uncaughtException', function (err) {
  try { debug({ fatal: String(err) }); } catch (_) {}
  process.exit(0);
});

function parseLoose(raw) {
  const grab = function (key) {
    const match = new RegExp('"' + key + '"\\\s*:\\\s*"([^"]*)"').exec(raw);
    return match ? match[1] : undefined;
  };
  const out = {};
  ['hook_event_name', 'session_id', 'tool_name', 'notification_type'].forEach(function (key) {
    const value = grab(key);
    if (value !== undefined) out[key] = value;
  });
  return out;
}

function readInput() {
  try {
    const chunks = [];
    let total = 0;
    let truncated = false;
    const buf = Buffer.alloc(65536);
    while (true) {
      const n = fs.readSync(0, buf, 0, buf.length, null);
      if (n <= 0) break;
      if (total + n > MAX_INPUT) {
        chunks.push(Buffer.from(buf.subarray(0, MAX_INPUT - total)));
        total = MAX_INPUT;
        truncated = true;
        break;
      }
      chunks.push(Buffer.from(buf.subarray(0, n)));
      total += n;
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      if (!truncated) return { __error: String(err) };
      const loose = parseLoose(raw);
      loose.__truncated = true;
      return loose;
    }
  } catch (err) {
    return { __error: String(err) };
  }
}

function oneLine(value, max) {
  let s = String(value === undefined || value === null ? '' : value);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (max) {
    // Cap the prefix before building an array, so a huge path cannot allocate
    // one entry per code unit just to be truncated.
    const limit = max * 4;
    if (s.length > limit) s = s.slice(0, limit);
    const chars = Array.from(s);
    if (chars.length > max) s = chars.slice(0, max - 1).join('') + '…';
  }
  return s;
}

function toolLabel(input) {
  const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const name = oneLine(input.tool_name || 'tool', 40);
  // Do not copy shell commands or URLs into terminal status: they can carry
  // secrets and end up in screenshots or the Herdr sidebar.
  const hint = ti.file_path || ti.path || '';
  const shortHint = oneLine(hint, 56);
  return shortHint ? name + ': ' + shortHint : name;
}

/*
 * Event -> semantic state. Keep this table boring and explicit: CodeBuddy's
 * permission events are the only ones that should ever surface as blocked.
 */
function mapEvent(name, input, previousState) {
  switch (name) {
    case 'SessionStart':
      // A compact-triggered SessionStart is not a new user-visible session.
      if (input.source === 'compact') return null;
      // Headless sessions can announce SessionStart after the first prompt;
      // do not let that late event cancel a turn already in progress.
      if (input.source !== 'resume' && previousState === 'working') return null;
      return { state: 'idle', msg: 'ready' };

    case 'UserPromptSubmit':
      // Never copy the prompt: it is the most likely carrier of secrets.
      return { state: 'working', msg: 'working' };

    case 'PreToolUse':
      // These two tools stop and wait for the person, so the pane blocks
      // before the tool runs rather than after it answers.
      if (input.tool_name === 'AskUserQuestion') {
        return { state: 'blocked', kind: 'question', msg: 'waiting for your answer' };
      }
      if (input.tool_name === 'ExitPlanMode') {
        return { state: 'blocked', kind: 'permission', msg: 'approve the plan' };
      }
      return { state: 'working', msg: toolLabel(input) };

    case 'PostToolUse':
    case 'PostToolUseFailure':
      // A permission or question block ends when the tool actually runs.
      return previousState === 'blocked' ? { state: 'working', msg: 'resumed' } : null;

    case 'PermissionDenied':
      return { state: 'working', msg: 'permission denied' };

    case 'Notification':
      // This is the reliable "waiting on a person" signal. PermissionRequest
      // also fires for auto-approved tools, so it is deliberately not mapped.
      if (input.notification_type === 'permission_prompt') {
        return { state: 'blocked', kind: 'permission', msg: oneLine(input.message, 72) || 'needs permission' };
      }
      // An interrupted turn emits no Stop; let a long wait recover the pane.
      // Never overwrite done/error, which are meant to survive until seen.
      if (input.notification_type === 'idle_prompt' && previousState === 'working') {
        return { state: 'idle', msg: 'waiting for input' };
      }
      return null;

    case 'SubagentStart':
      return { state: 'working', msg: 'subagent running' };

    case 'Elicitation':
      // Do not copy MCP-provided text; it may contain user data or secrets.
      return { state: 'blocked', kind: 'question', msg: 'waiting for input' };

    case 'ElicitationResult':
      return { state: 'working', msg: 'input received' };

    case 'Stop':
      return { state: 'done', msg: 'turn complete' };

    case 'StopFailure':
      // Herdr's app only renders working/blocked/done/idle; an OSC 'error'
      // becomes an invisible dim dot. A failed turn needs the person, so
      // surface it as blocked instead.
      return { state: 'blocked', msg: 'turn failed' };

    case 'SessionEnd':
      // /clear should also drop the TUI resume command; the next SessionStart
      // (source=clear) re-adds the agent with the new session id.
      return { state: 'clear' };

    default:
      return null;
  }
}

function sessionKey(input) {
  const raw = typeof input.session_id === 'string' && input.session_id ? input.session_id : 'default';
  // Hash the full id so two sessions cannot collide in one state file.
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(STATE_DIR);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('unsafe state dir');
  if (typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) throw new Error('state dir owner mismatch');
    if ((st.mode & 0o077) !== 0) fs.chmodSync(STATE_DIR, 0o700);
  }
}

function stateFile(key) {
  return path.join(STATE_DIR, key + '.json');
}

function readState(key) {
  try {
    ensureStateDir();
    const file = stateFile(key);
    let lst;
    try {
      lst = fs.lstatSync(file);
    } catch (_) {
      return { seq: 0, state: null };
    }
    if (lst.isSymbolicLink() || !lst.isFile() || lst.size > MAX_STATE) {
      return { seq: 0, state: null };
    }
    const fd = fs.openSync(file, fs.constants.O_RDONLY | O_NOFOLLOW);
    try {
      const st = fs.fstatSync(fd);
      if (st.size > MAX_STATE) return { seq: 0, state: null };
      const raw = fs.readFileSync(fd, 'utf8').trim();
      if (!raw) return { seq: 0, state: null };
      if (raw.charAt(0) === '{') {
        const parsed = JSON.parse(raw);
        return {
          seq: Number(parsed.seq) || 0,
          state: typeof parsed.state === 'string' ? parsed.state : null
        };
      }
      // Legacy: the first build stored a bare sequence number.
      return { seq: Number(raw) || 0, state: null };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return { seq: 0, state: null };
  }
}

function writeState(key, seq, state) {
  try {
    ensureStateDir();
    const file = stateFile(key);
    const tmp = path.join(
      STATE_DIR,
      key + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp'
    );
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW;
    const fd = fs.openSync(tmp, flags, 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ seq: seq, state: state }));
    } finally {
      fs.closeSync(fd);
    }
    try {
      // rename replaces a symlink at the destination instead of following it.
      fs.renameSync(tmp, file);
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      throw err;
    }
    return true;
  } catch (_) {
    return false;
  }
}

function withStateLock(key, fn) {
  try {
    ensureStateDir();
  } catch (_) {
    return fn();
  }
  const lock = path.join(STATE_DIR, key + '.lock');
  const deadline = Date.now() + 100;
  while (true) {
    let fd = -1;
    try {
      fd = fs.openSync(
        lock,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW,
        0o600
      );
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      fd = -1;
      try {
        return fn();
      } finally {
        try { fs.unlinkSync(lock); } catch (_) {}
      }
    } catch (err) {
      if (fd >= 0) {
        try { fs.closeSync(fd); } catch (_) {}
      }
      if (err.code !== 'EEXIST') return fn();
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > 2000) {
          try { fs.unlinkSync(lock); } catch (_) {}
          continue;
        }
      } catch (_) {}
      if (Date.now() >= deadline) return fn();
      const until = Date.now() + 2;
      while (Date.now() < until) {}
    }
  }
}

function base64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function oscPayload(record) {
  const parts = ['state=' + record.state];
  if (record.kind) parts.push('kind=' + record.kind);
  // Every report replaces the whole record, so app/title are repeated.
  // No id: Herdr treats the root record as the pane's agent. A child id would
  // create a separate record that the app and 'hc get' do not surface.
  parts.push('app=' + APP);
  parts.push('title=' + base64(LABEL));
  if (record.msg) parts.push('msg=' + base64(record.msg));
  return '\u001b]7501;' + parts.join(':') + '\u001b\\';
}

function ttyAllowed(device) {
  const resolved = path.resolve(device);
  const tmpRoot = path.resolve(os.tmpdir()) + path.sep;
  try {
    const st = fs.lstatSync(device);
    if (st.isSymbolicLink()) return false;
    if (st.isCharacterDevice()) return true;
    if (st.isFile()) return resolved.startsWith(tmpRoot);
    return false;
  } catch (err) {
    // Tests create a plain file under the system temp directory.
    if (err.code === 'ENOENT') return resolved.startsWith(tmpRoot);
    return false;
  }
}

function writeToTerminal(payload) {
  const device = process.env.HERDR_NOTIFY_TTY || '/dev/tty';
  if (!ttyAllowed(device)) {
    return { ok: false, error: 'refusing unsafe tty path: ' + device };
  }
  let fd = -1;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND | O_NOFOLLOW | O_NONBLOCK;
    fd = fs.openSync(device, flags, 0o600);
    fs.writeSync(fd, payload);
    fs.closeSync(fd);
    return { ok: true };
  } catch (err) {
    if (fd >= 0) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    return { ok: false, error: String(err) };
  }
}

function herdrBin() {
  return process.env.HERDR_BIN_PATH || '';
}

function canUseCli() {
  const bin = herdrBin();
  if (process.env.HERDR_ENV !== '1' || !bin || !process.env.HERDR_PANE_ID) return false;
  // The app's core binary is hc; only the TUI binary is herdr.
  if (!/^herdr(\.exe)?$/i.test(path.basename(bin))) return false;
  try {
    const st = fs.statSync(bin);
    if (!st.isFile()) return false;
    fs.accessSync(bin, fs.constants.X_OK);
  } catch (_) {
    return false;
  }
  return true;
}

function cliReport(record, seq, sessionId) {
  const bin = herdrBin();
  const pane = process.env.HERDR_PANE_ID || '';
  if (!bin || !pane || !PANE_ID_RE.test(pane)) {
    return { ok: false, error: 'invalid HERDR_BIN_PATH/HERDR_PANE_ID' };
  }

  let args;
  if (record.state === 'clear') {
    args = ['pane', 'release-agent', pane, '--source', SOURCE, '--agent', AGENT, '--seq', String(seq)];
  } else {
    // The TUI accepts idle/working/blocked. 'done' is inferred from a
    // working -> idle transition.
    const state = record.state === 'done' ? 'idle' : record.state;
    args = ['pane', 'report-agent', pane, '--source', SOURCE, '--agent', AGENT, '--state', state, '--seq', String(seq)];
    if (record.msg) args.push('--message', record.msg);
    // Native resume: after a Herdr server restart the pane reopens in the
    // same directory and runs this command. The first word must be a plain
    // command on PATH, and the id must be free of apostrophes/control chars.
    if (sessionId && SESSION_ID_RE.test(sessionId)) {
      args.push('--agent-session-id', sessionId, '--', RESUME_COMMAND, '--resume', sessionId);
    }
  }

  const result = spawnSync(bin, args, { stdio: 'ignore', timeout: 1500 });
  if (result.error) return { ok: false, error: String(result.error) };
  return { ok: result.status === 0, status: result.status };
}

const input = readInput();
const event = input.hook_event_name || '';
const key = sessionKey(input);
const sessionId = typeof input.session_id === 'string' ? input.session_id : '';

let record = null;
let previous = { seq: 0, state: null };
let seq = Date.now();

if (DRY_RUN) {
  record = mapEvent(event, input, null);
} else {
  const snapshot = withStateLock(key, function () {
    const prev = readState(key);
    const rec = mapEvent(event, input, prev.state);
    if (!rec) return { prev: prev, record: null, seq: 0 };
    // A per-session lock plus previous+1 keeps seq strictly increasing even
    // when several tool hooks fire in the same millisecond.
    const next = Math.max(Date.now(), prev.seq + 1);
    writeState(key, next, rec.state === 'clear' ? null : rec.state);
    return { prev: prev, record: rec, seq: next };
  });
  previous = snapshot.prev;
  record = snapshot.record;
  seq = snapshot.seq || Date.now();
}

if (!record) {
  debug({
    event: event,
    session: key,
    skipped: true,
    previous: previous.state,
    truncated: !!input.__truncated,
    reason: input.__error ? 'bad input: ' + input.__error : 'no state change'
  });
  process.exit(0);
}

const payload = oscPayload(record);

if (DRY_RUN) {
  process.stdout.write(
    JSON.stringify(
      {
        event: event,
        session: key,
        previous: previous.state,
        record: record,
        seq: seq,
        osc: payload,
        cli: canUseCli()
      },
      null,
      2
    ) + '\n'
  );
  process.exit(0);
}

let delivered = false;
let mode = 'none';
let detail = '';

if (canUseCli()) {
  const cli = cliReport(record, seq, sessionId);
  if (cli.ok) {
    delivered = true;
    mode = 'cli';
  } else {
    detail = cli.error || 'exit ' + cli.status;
  }
}

if (!delivered) {
  const tty = writeToTerminal(payload);
  delivered = tty.ok;
  mode = tty.ok ? 'osc' : 'none';
  if (!tty.ok) detail = detail ? detail + '; ' + tty.error : tty.error;
}

debug({
  event: event,
  session: key,
  record: record,
  seq: seq,
  mode: mode,
  delivered: delivered,
  truncated: !!input.__truncated,
  detail: detail
});
process.exit(0);
