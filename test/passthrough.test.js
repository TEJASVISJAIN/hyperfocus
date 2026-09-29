import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pty from 'node-pty';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const focusBin = fileURLToPath(new URL('../bin/focus.js', import.meta.url));
const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
const REPORT_TIMEOUT_MS = 5000;

ensureSpawnHelperIsExecutable();

// Runs `focus` inside an outer pseudo-terminal, standing in for the user's real terminal.
function startFocus(args = [], { cols = 80, rows = 24 } = {}) {
  const terminal = pty.spawn(process.execPath, [focusBin, ...args], {
    cols,
    rows,
    env: { ...process.env, FOCUS_CLAUDE_BIN: fakeClaude },
  });
  const reports = [];
  const waiters = [];
  let output = '';

  terminal.onData((data) => {
    output += data;
    for (const match of output.matchAll(/@@(.*?)@@/g)) reports.push(JSON.parse(match[1]));
    output = output.slice(output.lastIndexOf('@@') + 2 || 0);
    for (const waiter of [...waiters]) waiter();
  });

  const exited = new Promise((resolve) => terminal.onExit(resolve));

  const nextReport = (event) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), REPORT_TIMEOUT_MS);
      const check = () => {
        const index = reports.findIndex((report) => report.event === event);
        if (index === -1) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        resolve(reports.splice(index, 1)[0]);
      };
      waiters.push(check);
      check();
    });

  return { terminal, nextReport, exited };
}

test('passes arguments through and gives claude a real terminal of the same size', async () => {
  const focus = startFocus(['--model', 'haiku', 'hello world'], { cols: 91, rows: 33 });
  const start = await focus.nextReport('start');
  assert.deepEqual(start.args, ['--model', 'haiku', 'hello world']);
  assert.equal(start.isTTY, true);
  assert.equal(start.cols, 91);
  assert.equal(start.rows, 33);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('registers focus hooks with claude without touching the user args', async () => {
  const focus = startFocus(['--continue']);
  const start = await focus.nextReport('start');
  assert.deepEqual(start.args, ['--continue']);
  assert.deepEqual(start.hookEvents.sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(start.hasFocusSocket, true);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('forwards keystrokes and propagates the exit code', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('typed by user\r');
  assert.equal((await focus.nextReport('line')).line, 'typed by user');
  focus.terminal.write('exit 7\r');
  assert.equal((await focus.exited).exitCode, 7);
});

test('propagates terminal resizes to claude', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.resize(120, 40);
  const resize = await focus.nextReport('resize');
  assert.deepEqual([resize.cols, resize.rows], [120, 40]);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

function runFocusWithoutTerminal(env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [focusBin, '-p', 'hi'], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
    child.stdin.end('exit 4\n');
  });
}

test('without a terminal, hands stdio straight to claude', async () => {
  const result = await runFocusWithoutTerminal({ FOCUS_CLAUDE_BIN: fakeClaude });
  assert.match(result.stdout, /"args":\["-p","hi"\]/);
  assert.match(result.stdout, /"isTTY":false/);
  assert.equal(result.code, 4);
});

test('explains clearly when claude is not installed', async () => {
  const result = await runFocusWithoutTerminal({ FOCUS_CLAUDE_BIN: 'definitely-not-claude', PATH: '/nonexistent' });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /could not find `claude`/);
});
