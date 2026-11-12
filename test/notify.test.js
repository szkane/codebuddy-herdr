'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'herdr-notify', 'index.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notify-test-'));
  return { dir: dir, tty: path.join(dir, 'tty'), log: path.join(dir, 'debug.log') };
}

function envFor(box, extra) {
  return Object.assign({}, process.env, {
    TMPDIR: box.dir,
    XDG_RUNTIME_DIR: box.dir,
    HERDR_NOTIFY_TTY: box.tty,
    HERDR_NOTIFY_DEBUG: box.log,
    HERDR_ENV: '',
    HERDR_BIN_PATH: '',
    HERDR_PANE_ID: ''
  }, extra || {});
}

function run(payload, box, extraEnv, args) {
  const result = spawnSync(process.execPath, [SCRIPT].concat(args || []), {
    input: JSON.stringify(payload),
    env: envFor(box, extraEnv),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || 'hook exited non-zero');
  return result;
}

function report(ttyPath) {
  const raw = fs.readFileSync(ttyPath, 'utf8');
  const match = raw.match(/\u001b\]7501;([^\u001b]*)\u001b\\/);
  assert.ok(match, 'expected one OSC 7501 sequence, got: ' + JSON.stringify(raw));
  const fields = {};
  for (const part of match[1].split(':')) {
    const eq = part.indexOf('=');
    fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  if (fields.title) fields.title = Buffer.from(fields.title, 'base64').toString('utf8');
  if (fields.msg) fields.msg = Buffer.from(fields.msg, 'base64').toString('utf8');
  return fields;
}

function logLines(box) {
  return fs.readFileSync(box.log, 'utf8').trim().split('\n').map(JSON.parse);
}

function mockHerdr(box) {
  const bin = path.join(box.dir, 'herdr');
  const cliLog = path.join(box.dir, 'cli.log');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERDR_CLI_LOG"\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  return {
    bin: bin,
    log: cliLog,
    env: { HERDR_ENV: '1', HERDR_BIN_PATH: bin, HERDR_PANE_ID: 'w1:p1', HERDR_CLI_LOG: cliLog }
  };
}

test('maps CodeBuddy lifecycle events to Herdr states', () => {
  const cases = [
    [{ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, 'idle', 'ready'],
    [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'fix the tests' }, 'working', 'working'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' }, 'working', 'Bash'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion' }, 'blocked', 'waiting for your answer'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'ExitPlanMode' }, 'blocked', 'approve the plan'],
    [{ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt', message: 'needs permission' }, 'blocked', 'needs permission'],
    [{ hook_event_name: 'PermissionDenied', session_id: 's1', tool_name: 'Bash' }, 'working', 'permission denied'],
    [{ hook_event_name: 'Elicitation', session_id: 's1', message: 'pick one' }, 'blocked', 'waiting for input'],
    [{ hook_event_name: 'ElicitationResult', session_id: 's1' }, 'working', 'input received'],
    [{ hook_event_name: 'SubagentStart', session_id: 's1' }, 'working', 'subagent running'],
    [{ hook_event_name: 'Stop', session_id: 's1' }, 'done', 'turn complete'],
    [{ hook_event_name: 'StopFailure', session_id: 's1' }, 'blocked', 'turn failed'],
    [{ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' }, 'clear', null],
    [{ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' }, 'clear', null]
  ];

  for (const entry of cases) {
    const payload = entry[0];
    const box = sandbox();
    run(payload, box);
    const got = report(box.tty);
    assert.equal(got.state, entry[1], payload.hook_event_name + ' state');
    if (entry[2] === null) assert.equal(got.msg, undefined, payload.hook_event_name + ' msg');
    else assert.equal(got.msg, entry[2], payload.hook_event_name + ' msg');
  }
});

test('frames a single root OSC 7501 record', () => {
  const box = sandbox();
  run({ hook_event_name: 'Stop', session_id: 'framing' }, box);

  const raw = fs.readFileSync(box.tty, 'utf8');
  assert.ok(raw.startsWith('\u001b]7501;'), 'starts with OSC 7501');
  assert.ok(raw.endsWith('\u001b\\'), 'ends with ST');
  assert.equal(raw.includes('\u001b]7501;', 1), false, 'one sequence per report');

  const got = report(box.tty);
  assert.equal(got.app, 'codebuddy');
  assert.equal(got.title, 'CodeBuddy');
  assert.equal(got.state, 'done');
  assert.equal(got.id, undefined, 'root record, no child id');
});

test('does not copy the prompt or MCP text into status', () => {
  const box = sandbox();
  run({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'secret',
    prompt: 'curl https://example.com/x?token=SECRET12345'
  }, box);
  const got = report(box.tty);
  assert.equal(got.msg, 'working');
  assert.equal(JSON.stringify(got).includes('SECRET12345'), false);
});

test('recovers from blocked and preserves done', () => {
  const box = sandbox();

  run({ hook_event_name: 'PreToolUse', session_id: 'seq', tool_name: 'Bash' }, box);
  run({ hook_event_name: 'Notification', session_id: 'seq', notification_type: 'permission_prompt', message: 'needs permission' }, box);
  run({ hook_event_name: 'PostToolUse', session_id: 'seq', tool_name: 'Bash' }, box);
  run({ hook_event_name: 'Notification', session_id: 'seq', notification_type: 'permission_prompt', message: 'needs permission' }, box);
  run({ hook_event_name: 'PostToolUseFailure', session_id: 'seq', tool_name: 'Bash' }, box);
  run({ hook_event_name: 'Stop', session_id: 'seq' }, box);
  run({ hook_event_name: 'Notification', session_id: 'seq', notification_type: 'idle_prompt' }, box);

  const lines = logLines(box);
  assert.deepEqual(
    lines.filter(function (line) { return line.record; }).map(function (line) { return line.record.state; }),
    ['working', 'blocked', 'working', 'blocked', 'working', 'done']
  );
  assert.equal(lines[lines.length - 1].skipped, true, 'idle_prompt must not overwrite done');

  const seqs = lines.filter(function (line) { return line.seq; }).map(function (line) { return line.seq; });
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], 'seq must be strictly increasing');
  }
});

test('ignores a late startup SessionStart', () => {
  const box = sandbox();

  run({ hook_event_name: 'PreToolUse', session_id: 'late', tool_name: 'Read' }, box);
  run({ hook_event_name: 'SessionStart', session_id: 'late', source: 'startup' }, box);
  run({ hook_event_name: 'SessionStart', session_id: 'late', source: 'resume' }, box);

  const lines = logLines(box);
  assert.equal(lines[1].skipped, true);
  assert.equal(lines[2].record.state, 'idle');
});

test('skips a compact SessionStart', () => {
  const box = sandbox();
  run({ hook_event_name: 'SessionStart', session_id: 'compact', source: 'compact' }, box);
  assert.equal(fs.existsSync(box.tty), false);
});

test('ignores unrelated notification types', () => {
  const box = sandbox();
  run({ hook_event_name: 'Notification', session_id: 'notify', notification_type: 'auth_success' }, box);
  assert.equal(fs.existsSync(box.tty), false);
});

test('dry-run prints the sequence without delivering or writing state', () => {
  const box = sandbox();
  const result = run({ hook_event_name: 'Stop', session_id: 'dry' }, box, {}, ['--dry-run']);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.record.state, 'done');
  assert.ok(parsed.osc.startsWith('\u001b]7501;'));
  assert.equal(fs.existsSync(box.tty), false);
  assert.equal(fs.existsSync(path.join(box.dir, 'herdr-notify')), false);
});

test('uses the TUI CLI and maps done to idle', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const mock = mockHerdr(box);

  run({ hook_event_name: 'Stop', session_id: 'tui' }, box, mock.env);
  run({ hook_event_name: 'SessionEnd', session_id: 'tui', reason: 'other' }, box, mock.env);

  const calls = fs.readFileSync(mock.log, 'utf8').trim().split('\n');
  assert.match(calls[0], /^pane report-agent w1:p1 /);
  assert.match(calls[0], /--state idle/);
  assert.match(calls[0], /--message turn complete/);
  assert.match(calls[0], /--agent-session-id tui -- codebuddy --resume tui/);
  assert.match(calls[1], /^pane release-agent w1:p1 /);
  assert.doesNotMatch(calls[1], /--agent-session-id/);
  assert.equal(fs.existsSync(box.tty), false, 'CLI success must not also write OSC');
});

test('clears the TUI resume command on /clear', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const mock = mockHerdr(box);

  run({ hook_event_name: 'SessionEnd', session_id: 'old-session', reason: 'clear' }, box, mock.env);

  const call = fs.readFileSync(mock.log, 'utf8').trim();
  assert.match(call, /^pane release-agent w1:p1 /);
  assert.doesNotMatch(call, /--agent-session-id/);
  assert.equal(fs.existsSync(box.tty), false);
});

test('omits resume args when the session id is not a safe command word', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const mock = mockHerdr(box);

  run({ hook_event_name: 'Stop', session_id: 'bad id with spaces' }, box, mock.env);

  const call = fs.readFileSync(mock.log, 'utf8').trim();
  assert.match(call, /^pane report-agent w1:p1 /);
  assert.doesNotMatch(call, /--agent-session-id/);
});

test('never calls the app binary (hc) for reporting', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const bin = path.join(box.dir, 'hc');
  const cliLog = path.join(box.dir, 'cli.log');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERDR_CLI_LOG"\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  run({ hook_event_name: 'Stop', session_id: 'app' }, box, {
    HERDR_ENV: '1',
    HERDR_BIN_PATH: bin,
    HERDR_PANE_ID: 'w1:p1',
    HERDR_CLI_LOG: cliLog
  });

  assert.equal(fs.existsSync(cliLog), false, 'hc has no pane report-agent in 0.1.x');
  assert.equal(report(box.tty).state, 'done');
});

test('refuses a symlinked tty path', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const target = path.join(box.dir, 'tty-target');
  fs.writeFileSync(target, 'keep');
  const link = path.join(box.dir, 'tty-link');
  fs.symlinkSync(target, link);

  run({ hook_event_name: 'Stop', session_id: 'tty-link' }, box, { HERDR_NOTIFY_TTY: link });

  assert.equal(fs.readFileSync(target, 'utf8'), 'keep');
});

test('refuses a FIFO as the tty path', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const fifo = path.join(box.dir, 'tty-fifo');
  const made = spawnSync('mkfifo', [fifo]);
  if (made.status !== 0) return;

  const result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'tty-fifo' }),
    env: envFor(box, { HERDR_NOTIFY_TTY: fifo }),
    encoding: 'utf8',
    timeout: 2000
  });
  assert.equal(result.status, 0);
  assert.equal(result.signal, null, 'must not block on a FIFO');
});

test('refuses a symlinked state directory', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const stateDir = path.join(box.dir, 'herdr-notify');
  const target = path.join(box.dir, 'state-target');
  fs.mkdirSync(target);
  fs.symlinkSync(target, stateDir);

  run({ hook_event_name: 'Stop', session_id: 'state-link' }, box);

  assert.deepEqual(fs.readdirSync(target), []);
  assert.equal(report(box.tty).state, 'done');
});

test('caps oversized hook input and still reports the event', () => {
  const box = sandbox();
  const big = 'x'.repeat(2 * 1024 * 1024);

  run({
    hook_event_name: 'PreToolUse',
    session_id: 'big',
    tool_name: 'Bash',
    tool_input: { command: big }
  }, box);

  assert.equal(report(box.tty).state, 'working');
});

test('serializes state updates across parallel hooks', async () => {
  const box = sandbox();
  const payload = { hook_event_name: 'PreToolUse', session_id: 'parallel', tool_name: 'Bash' };

  await Promise.all([0, 1, 2, 3].map(function () {
    return new Promise(function (resolve, reject) {
      const child = spawn(process.execPath, [SCRIPT], {
        env: envFor(box),
        stdio: ['pipe', 'ignore', 'ignore']
      });
      child.on('error', reject);
      child.on('exit', function (code) {
        if (code === 0) resolve();
        else reject(new Error('hook exited ' + code));
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }));

  const seqs = logLines(box).filter(function (line) { return line.seq; }).map(function (line) { return line.seq; });
  assert.equal(new Set(seqs).size, seqs.length, 'seq must be unique');
  assert.ok(seqs.length >= 4);
});
