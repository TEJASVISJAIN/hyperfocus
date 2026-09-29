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
function startFocus(args = [], { cols = 80, rows = 24, env = {} } = {}) {
  const terminal = pty.spawn(process.execPath, [focusBin, ...args], {
    cols,
    rows,
    env: { ...process.env, FOCUS_CLAUDE_BIN: fakeClaude, ...env },
  });
  const reports = [];
  const waiters = [];
  let output = '';
  let transcript = '';

  terminal.onData((data) => {
    output += data;
    transcript += data;
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

  // Resolves once everything the user's terminal has received so far matches `pattern`.
  const waitForScreen = (pattern) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), REPORT_TIMEOUT_MS);
      const check = () => {
        if (!pattern.test(transcript)) return;
        clearTimeout(timer);
        waiters.splice(waiters.indexOf(check), 1);
        resolve(transcript);
      };
      waiters.push(check);
      check();
    });

  return { terminal, nextReport, waitForScreen, exited, transcript: () => transcript };
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

const CTRL_RIGHT_BRACKET = '\x1d';
const ENTER_ALT_SCREEN = '\x1b[?1049h';

test('Ctrl-] switches to the focus view and back', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h[\s\S]*focus/);
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049l/);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('keys typed in the focus view never reach claude', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h/);
  focus.terminal.write('meant for the quiz\r');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049l/);
  focus.terminal.write('meant for claude\r');
  assert.equal((await focus.nextReport('line')).line, 'meant for claude');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('claude output produced while in the focus view appears after switching back', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('later 150 written while away\r');
  await focus.nextReport('line');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h/);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const sinceFocusOpened = () => focus.transcript().slice(focus.transcript().lastIndexOf(ENTER_ALT_SCREEN));
  assert.doesNotMatch(sinceFocusOpened(), /"later"/, 'must not draw over the focus view');

  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049l[\s\S]*"later"/);
  assert.equal((await focus.nextReport('later')).text, 'written while away');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('focus opens by itself while the agent works and hands back with a bell when it stops', async () => {
  const focus = startFocus([], { env: { FOCUS_DELAY_MS: '100' } });
  await focus.nextReport('start');
  focus.terminal.write('hook 0 UserPromptSubmit\r');
  focus.terminal.write('hook 2600 Stop\r'); // after the 2s typing grace
  await focus.waitForScreen(/\x1b\[\?1049h/);
  const screen = await focus.waitForScreen(/\x1b\[\?1049l[\s\S]*\x07/);
  assert.ok(screen.indexOf(ENTER_ALT_SCREEN) < screen.lastIndexOf('\x1b[?1049l'));
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('Ctrl-] works even when it arrives in the same chunk as other keys', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('typed fast\r' + CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h/);
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049l/);
  assert.equal((await focus.nextReport('line')).line, 'typed fast', 'the keys before Ctrl-] still reached claude');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});
