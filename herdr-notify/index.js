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
 *      We use it when HERDR_ENV=1 points at a TUI binary.
 *
 * The hook's stdout belongs to CodeBuddy, so OSC is written to /dev/tty, never
 * to stdout. Anything unexpected is swallowed: a status reporter must never
 * block or fail an agent turn.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const APP = 'codebuddy';
const LABEL = 'CodeBuddy';
const SOURCE = 'codebuddy';
const AGENT = 'CodeBuddy';

const STATE_DIR = path.join(os.tmpdir(), 'herdr-notify');
const DEBUG_LOG = process.env.HERDR_NOTIFY_DEBUG || '';
// Overridable so tests and troubleshooting can capture the exact bytes.
const TTY_DEVICE = process.env.HERDR_NOTIFY_TTY || '/dev/tty';
const DRY_RUN = process.argv.indexOf('--dry-run') !== -1;

function debug(record) {
  if (!DEBUG_LOG) return;
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG), { recursive: true });
    fs.appendFileSync(
      DEBUG_LOG,
      JSON.stringify(Object.assign({ ts: new Date().toISOString() }, record)) + '\n'
    );
  } catch (_) {}
}

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    if (!raw.trim()) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return { __error: String(err) };
  }
}

function oneLine(value, max) {
  let s = String(value === undefined || value === null ? '' : value);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (max && s.length > max) s = s.slice(0, max - 1) + '…';
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
      return { state: 'working', msg: oneLine(input.prompt, 72) || 'working' };

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
      return { state: 'blocked', kind: 'question', msg: oneLine(input.message, 72) || 'waiting for input' };

    case 'ElicitationResult':
      return { state: 'working', msg: 'input received' };

    case 'Stop':
      return { state: 'done', msg: 'turn complete' };

    case 'StopFailure':
      return { state: 'error', msg: 'turn failed' };

    case 'SessionEnd':
      // /clear immediately starts a new session; keep the pane rather than
      // releasing it and flashing the agent out of the sidebar.
      if (input.reason === 'clear') return { state: 'idle', msg: 'ready' };
      return { state: 'clear' };

    default:
      return null;
  }
}

function sessionKey(input) {
  const raw = typeof input.session_id === 'string' ? input.session_id : 'default';
  const clean = raw.replace(/[^A-Za-z0-9_-]/g, '');
  return clean.slice(0, 16) || 'default';
}

/*
 * Herdr drops reports whose --seq is not greater than the last accepted one,
 * so keep a monotonic counter per session even when two hooks fire in the
 * same millisecond.
 */
function stateFile(key) {
  return path.join(STATE_DIR, key + '.json');
}

function readState(key) {
  try {
    const raw = fs.readFileSync(stateFile(key), 'utf8').trim();
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
  } catch (_) {
    return { seq: 0, state: null };
  }
}

function writeState(key, seq, state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(key), JSON.stringify({ seq: seq, state: state }));
  } catch (_) {}
}

function base64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function oscPayload(record, key) {
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

function writeToTerminal(payload) {
  let fd = -1;
  try {
    fd = fs.openSync(TTY_DEVICE, 'w');
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
  // The Herdr app's core binary (hc 0.1.x) has no 'pane report-agent'; the app
  // consumes OSC 7501 instead. The TUI binary is 'herdr'.
  return path.basename(bin) !== 'hc';
}

function cliReport(record, seq) {
  const bin = herdrBin();
  const pane = process.env.HERDR_PANE_ID || '';
  if (!bin || !pane) return { ok: false, error: 'missing HERDR_BIN_PATH/HERDR_PANE_ID' };

  let args;
  if (record.state === 'clear') {
    args = ['pane', 'release-agent', pane, '--source', SOURCE, '--agent', AGENT, '--seq', String(seq)];
  } else {
    // The TUI accepts idle/working/blocked. 'done' is inferred from a
    // working -> idle transition, and error has no CLI equivalent.
    const state = record.state === 'done' || record.state === 'error' ? 'idle' : record.state;
    args = ['pane', 'report-agent', pane, '--source', SOURCE, '--agent', AGENT, '--state', state, '--seq', String(seq)];
    if (record.msg) args.push('--message', record.msg);
  }

  const result = spawnSync(bin, args, { stdio: 'ignore', timeout: 1500 });
  if (result.error) return { ok: false, error: String(result.error) };
  return { ok: result.status === 0, status: result.status };
}

const input = readInput();
const event = input.hook_event_name || '';
const key = sessionKey(input);
const previous = DRY_RUN ? { seq: 0, state: null } : readState(key);
const record = mapEvent(event, input, previous.state);

if (!record) {
  debug({ event: event, session: key, skipped: true, previous: previous.state, reason: input.__error ? 'bad input: ' + input.__error : 'no state change' });
  process.exit(0);
}

// Millisecond precision plus the pid keeps parallel tool hooks from producing
// the same seq; Herdr drops anything not strictly increasing.
const seq = DRY_RUN
  ? Date.now()
  : Math.max(Date.now() * 1000 + (process.pid % 1000), previous.seq + 1);
if (!DRY_RUN) writeState(key, seq, record.state === 'clear' ? null : record.state);
const payload = oscPayload(record, key);

if (DRY_RUN) {
  process.stdout.write(
    JSON.stringify(
      { event: event, session: key, record: record, seq: seq, osc: payload, cli: canUseCli() },
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
  const cli = cliReport(record, seq);
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

debug({ event: event, session: key, record: record, seq: seq, mode: mode, delivered: delivered, detail: detail });
process.exit(0);
