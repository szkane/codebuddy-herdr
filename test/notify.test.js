'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'herdr-notify', 'index.js');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-notify-test-'));
  return { dir: dir, tty: path.join(dir, 'tty'), log: path.join(dir, 'debug.log') };
}

function envFor(box, extra) {
  return Object.assign({}, process.env, {
    TMPDIR: box.dir,
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

test('maps CodeBuddy lifecycle events to Herdr states', () => {
  const cases = [
    [{ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, 'idle', 'ready'],
    [{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'fix the tests' }, 'working', 'fix the tests'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash' }, 'working', 'Bash'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'AskUserQuestion' }, 'blocked', 'waiting for your answer'],
    [{ hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'ExitPlanMode' }, 'blocked', 'approve the plan'],
    [{ hook_event_name: 'Notification', session_id: 's1', notification_type: 'permission_prompt', message: 'needs permission' }, 'blocked', 'needs permission'],
    [{ hook_event_name: 'PermissionDenied', session_id: 's1', tool_name: 'Bash' }, 'working', 'permission denied'],
    [{ hook_event_name: 'Elicitation', session_id: 's1', message: 'pick one' }, 'blocked', 'pick one'],
    [{ hook_event_name: 'ElicitationResult', session_id: 's1' }, 'working', 'input received'],
    [{ hook_event_name: 'SubagentStart', session_id: 's1' }, 'working', 'subagent running'],
    [{ hook_event_name: 'Stop', session_id: 's1' }, 'done', 'turn complete'],
    [{ hook_event_name: 'StopFailure', session_id: 's1' }, 'error', 'turn failed'],
    [{ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' }, 'clear', null],
    [{ hook_event_name: 'SessionEnd', session_id: 's1', reason: 'clear' }, 'idle', 'ready']
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

test('recovers from blocked and preserves done', () => {
  const box = sandbox();

  run({ hook_event_name: 'PreToolUse', session_id: 'seq', tool_name: 'Bash' }, box);
  run({ hook_event_name: 'Notification', session_id: 'seq', notification_type: 'permission_prompt', message: 'needs permission' }, box);
  run({ hook_event_name: 'PostToolUse', session_id: 'seq', tool_name: 'Bash' }, box);
  run({ hook_event_name: 'Stop', session_id: 'seq' }, box);
  run({ hook_event_name: 'Notification', session_id: 'seq', notification_type: 'idle_prompt' }, box);

  const lines = logLines(box);
  assert.deepEqual(lines.filter(function (line) { return line.record; }).map(function (line) { return line.record.state; }), ['working', 'blocked', 'working', 'done']);
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

test('dry-run prints the sequence without delivering it', () => {
  const box = sandbox();
  const result = run({ hook_event_name: 'Stop', session_id: 'dry' }, box, {}, ['--dry-run']);

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.record.state, 'done');
  assert.ok(parsed.osc.startsWith('\u001b]7501;'));
  assert.equal(fs.existsSync(box.tty), false);
});

test('uses the TUI CLI and maps done to idle', { skip: process.platform === 'win32' }, () => {
  const box = sandbox();
  const bin = path.join(box.dir, 'herdr');
  const cliLog = path.join(box.dir, 'cli.log');
  fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERDR_CLI_LOG"\nexit 0\n');
  fs.chmodSync(bin, 0o755);

  const env = { HERDR_ENV: '1', HERDR_BIN_PATH: bin, HERDR_PANE_ID: 'w1:p1', HERDR_CLI_LOG: cliLog };
  run({ hook_event_name: 'Stop', session_id: 'tui' }, box, env);
  run({ hook_event_name: 'SessionEnd', session_id: 'tui', reason: 'other' }, box, env);

  const calls = fs.readFileSync(cliLog, 'utf8').trim().split('\n');
  assert.match(calls[0], /^pane report-agent w1:p1 /);
  assert.match(calls[0], /--state idle/);
  assert.match(calls[0], /--message turn complete/);
  assert.match(calls[1], /^pane release-agent w1:p1 /);
  assert.equal(fs.existsSync(box.tty), false, 'CLI success must not also write OSC');
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
