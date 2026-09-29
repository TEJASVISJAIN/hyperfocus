import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import pty from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const focusBin = fileURLToPath(new URL('../bin/hyperfocus.js', import.meta.url));
const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude.js', import.meta.url));
const REPORT_TIMEOUT_MS = 5000;

ensureSpawnHelperIsExecutable();

// Runs `focus` inside an outer pseudo-terminal, standing in for the user's real terminal.
function startFocus(args = [], { cols = 80, rows = 24, env = {} } = {}) {
  const terminal = pty.spawn(process.execPath, [focusBin, ...args], {
    cols,
    rows,
    // A throwaway data folder: the user's own config and history must neither affect nor collect test runs.
    env: { ...process.env, HYPERFOCUS_CLAUDE_BIN: fakeClaude, HYPERFOCUS_HOME: mkdtempSync(join(tmpdir(), 'focus-home-')), ...env },
  });
  const reports = [];
  const waiters = [];
  let output = '';
  let transcript = '';
  // What the user would actually see: everything focus sends, interpreted by a real terminal emulator.
  const userTerminal = new xtermHeadless.Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });

  terminal.onData((data) => {
    output += data;
    transcript += data;
    userTerminal.write(data);
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

  const userScreen = () =>
    new Promise((resolve) =>
      userTerminal.write('', () => {
        const buffer = userTerminal.buffer.active;
        const lines = [];
        for (let row = 0; row < userTerminal.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
        resolve({ type: buffer.type, text: lines.join('\n') });
      }),
    );

  return { terminal, nextReport, waitForScreen, userScreen, exited, transcript: () => transcript };
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

test('registers hyperfocus hooks with claude without touching the user args', async () => {
  const focus = startFocus(['--continue']);
  const start = await focus.nextReport('start');
  assert.deepEqual(start.args, ['--continue']);
  assert.deepEqual(start.hookEvents.sort(), ['Notification', 'PostToolUse', 'PreToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit']);
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
  const result = await runFocusWithoutTerminal({ HYPERFOCUS_CLAUDE_BIN: fakeClaude });
  assert.match(result.stdout, /"args":\["-p","hi"\]/);
  assert.match(result.stdout, /"isTTY":false/);
  assert.equal(result.code, 4);
});

test('explains clearly when claude is not installed', async () => {
  const result = await runFocusWithoutTerminal({ HYPERFOCUS_CLAUDE_BIN: 'definitely-not-claude', PATH: '/nonexistent' });
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

test('Esc in the focus view goes back to Claude, and keys reach Claude again', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h[\s\S]*enter or esc/);
  focus.terminal.write('\x1b');
  await focus.waitForScreen(/\x1b\[\?1049l/);
  focus.terminal.write('after esc\r');
  assert.equal((await focus.nextReport('line')).line, 'after esc');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('keys typed in the focus view never reach claude', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h/);
  focus.terminal.write('meant for the quiz');
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

test('the focus view opens by itself while the agent works and hands back with a bell when it stops', async () => {
  const focus = startFocus([], { env: { HYPERFOCUS_DELAY_MS: '100' } });
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

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls what the user sees until `accept` passes, so timing on a loaded machine can't fail the test.
async function screenWhen(focus, accept, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let screen = await focus.userScreen();
  while (!accept(screen) && Date.now() < deadline) {
    await pause(50);
    screen = await focus.userScreen();
  }
  return screen;
}

test('a flood of output while away is not replayed byte for byte, but the screen still ends up right', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('flood 3000\r');
  await focus.nextReport('line');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049h/);
  await pause(1500);
  const sentBeforeReturn = focus.transcript().length;
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await focus.waitForScreen(/\x1b\[\?1049l[\s\S]*FLOOD END/);
  await pause(200);
  const sentOnReturn = focus.transcript().length - sentBeforeReturn;
  assert.ok(sentOnReturn < 300_000, `sent ${sentOnReturn} bytes on return`);
  const screen = await focus.userScreen();
  assert.equal(screen.type, 'normal');
  assert.match(screen.text, /FLOOD END/);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('if claude leaves its alternate screen while focus is up, the user ends up on the main screen', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('raw 0 "\\u001b[?1049hCLAUDE FULLSCREEN VIEW"\r');
  focus.terminal.write('raw 1200 "\\u001b[?1049lBACK ON MAIN SCREEN\\r\\n"\r');
  const before = await screenWhen(focus, (screen) => screen.type === 'alternate' && /CLAUDE FULLSCREEN VIEW/.test(screen.text));
  assert.equal(before.type, 'alternate');
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await screenWhen(focus, (screen) => /hyperfocus ·/.test(screen.text));
  await pause(1600); // Claude leaves its alternate screen while the focus view is up
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  const screen = await screenWhen(focus, (screen) => screen.type === 'normal' && /BACK ON MAIN SCREEN/.test(screen.text));
  assert.equal(screen.type, 'normal', 'the real terminal left the alternate screen too');
  assert.match(screen.text, /BACK ON MAIN SCREEN/);
  assert.doesNotMatch(screen.text, /focus ·/, 'no leftovers of the focus view');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

test('returning while claude is still on its alternate screen repaints it exactly', async () => {
  const focus = startFocus();
  await focus.nextReport('start');
  focus.terminal.write('raw 0 "\\u001b[?1049h\\u001b[HPAGER LINE ONE\\r\\nPAGER LINE TWO"\r');
  focus.terminal.write('raw 1200 "\\r\\nWRITTEN WHILE AWAY"\r');
  await screenWhen(focus, (screen) => screen.type === 'alternate' && /PAGER LINE TWO/.test(screen.text));
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  await screenWhen(focus, (screen) => /hyperfocus ·/.test(screen.text));
  await pause(1600); // Claude writes more while the focus view is up
  focus.terminal.write(CTRL_RIGHT_BRACKET);
  const screen = await screenWhen(focus, (screen) => /WRITTEN WHILE AWAY/.test(screen.text) && !/hyperfocus ·/.test(screen.text));
  assert.equal(screen.type, 'alternate');
  // In order; the fake claude's own @@report@@ lines may land in between depending on timing.
  assert.match(screen.text, /PAGER LINE ONE\nPAGER LINE TWO[\s\S]*WRITTEN WHILE AWAY/);
  assert.doesNotMatch(screen.text, /focus ·/);
  focus.terminal.write('exit 0\r');
  await focus.exited;
});

const fakeClaudeWithQuiz = fileURLToPath(new URL('./fixtures/fake-claude-with-quiz.js', import.meta.url));

test('when Claude finishes mid-question, the quiz stays up and Enter goes back', async () => {
  const focus = startFocus([], { env: { HYPERFOCUS_DELAY_MS: '100', HYPERFOCUS_CLAUDE_BIN: fakeClaudeWithQuiz } });
  await focus.nextReport('start');
  focus.terminal.write('hook 0 UserPromptSubmit\r');
  focus.terminal.write('hook 3500 Stop\r'); // after the 2s typing grace and the first question
  await focus.waitForScreen(/Why retry refreshToken\?/);
  await focus.waitForScreen(/Claude finished/);
  const whileFinished = await focus.userScreen();
  assert.equal(whileFinished.type, 'alternate', 'still on the quiz');
  assert.match(whileFinished.text, /Why retry refreshToken\?/);
  assert.match(whileFinished.text, /enter\s+back to Claude/);

  focus.terminal.write('\r');
  await pause(300);
  assert.equal((await focus.userScreen()).type, 'normal', 'back on Claude');
  focus.terminal.write('exit 0\r');
  await focus.exited;
});
