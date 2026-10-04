import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeAgent } from '../src/agents/claude.js';
import { statusFromSnapshot, statusLineText, userStatusLine, writeStatus } from '../src/status-line.js';

const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const script = fileURLToPath(new URL('../bin/hyperfocus-status.js', import.meta.url));

test('the status line says hyperfocus is running and how to reach the quiz', () => {
  assert.equal(plain(statusLineText({ ready: 0, answered: 0, correct: 0, quiet: false })), '◐ hyperfocus · Ctrl-] for the quiz');
});

test('the status line counts questions waiting to be answered', () => {
  assert.equal(plain(statusLineText({ ready: 1, answered: 0, correct: 0, quiet: false })), '◐ hyperfocus · 1 question ready · Ctrl-] to answer');
  assert.equal(plain(statusLineText({ ready: 3, answered: 0, correct: 0, quiet: false })), '◐ hyperfocus · 3 questions ready · Ctrl-] to answer');
});

test("the status line shows the session's score once something is answered", () => {
  assert.equal(plain(statusLineText({ ready: 0, answered: 4, correct: 3, quiet: false })), '◐ hyperfocus · 3/4 right · Ctrl-] for the quiz');
});

test('in quiet mode the status line says so, and that the quiz is still a key away', () => {
  assert.equal(plain(statusLineText({ ready: 2, answered: 0, correct: 0, quiet: true })), '◐ hyperfocus · quiet · 2 questions ready · Ctrl-] to answer');
});

test('questions ready come from the snapshot: the one on screen if unanswered, plus the queue', () => {
  const question = { id: 1 };
  assert.deepEqual(statusFromSnapshot({ question, feedback: null, queued: 2, score: { answered: 1, correct: 1 }, quiet: false }), { ready: 3, answered: 1, correct: 1, quiet: false });
  assert.deepEqual(statusFromSnapshot({ question, feedback: { chosen: 0 }, queued: 0, score: { answered: 2, correct: 1 }, quiet: true }), { ready: 0, answered: 2, correct: 1, quiet: true });
  assert.deepEqual(statusFromSnapshot({ question: null, feedback: null, queued: 0, score: { answered: 0, correct: 0 } }), { ready: 0, answered: 0, correct: 0, quiet: false });
});

test("the user's own status line is found the way Claude Code ranks settings: local, then project, then user", () => {
  const root = mkdtempSync(join(tmpdir(), 'hf-sl-'));
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(project, '.claude'), { recursive: true });
  const line = (command) => JSON.stringify({ statusLine: { type: 'command', command } });

  assert.equal(userStatusLine({ cwd: project, home }), null);
  writeFileSync(join(home, '.claude', 'settings.json'), line('user-line'));
  assert.equal(userStatusLine({ cwd: project, home }), 'user-line');
  writeFileSync(join(project, '.claude', 'settings.json'), line('project-line'));
  assert.equal(userStatusLine({ cwd: project, home }), 'project-line');
  writeFileSync(join(project, '.claude', 'settings.local.json'), line('local-line'));
  assert.equal(userStatusLine({ cwd: project, home }), 'local-line');
  writeFileSync(join(project, '.claude', 'settings.local.json'), '{ not json');
  assert.equal(userStatusLine({ cwd: project, home }), 'project-line');
});

test("Claude's launch adds hyperfocus's status line beside its hooks, and tells it where the session's status is", () => {
  const launch = claudeAgent.prepareLaunch({ socketPath: '/tmp/s.sock', statusFile: '/tmp/status.json', userStatusLine: 'my-line' });
  const settings = JSON.parse(launch.args[launch.args.indexOf('--settings') + 1]);
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.equal(settings.statusLine.type, 'command');
  assert.match(settings.statusLine.command, /hyperfocus-status\.js/);
  assert.equal(launch.env.HYPERFOCUS_STATUS, '/tmp/status.json');
  assert.equal(launch.env.HYPERFOCUS_USER_STATUSLINE, 'my-line');
});

const runScript = (env, stdin = '{}') =>
  new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [script], { env: { ...process.env, ...env }, timeout: 10_000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
    child.stdin.end(stdin);
  });

test("the status-line script prints the user's own line first, then hyperfocus's, from the session's status", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-sl-'));
  const statusFile = join(dir, 'status.json');
  writeStatus(statusFile, { ready: 2, answered: 0, correct: 0, quiet: false });
  // The user's command gets the same JSON Claude Code sends, on stdin.
  const userCommand = `"${process.execPath}" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log('MINE '+JSON.parse(s).model.display_name))"`;
  const out = await runScript({ HYPERFOCUS_STATUS: statusFile, HYPERFOCUS_USER_STATUSLINE: userCommand }, JSON.stringify({ model: { display_name: 'Opus' } }));
  assert.deepEqual(plain(out).trimEnd().split('\n'), ['MINE Opus', '◐ hyperfocus · 2 questions ready · Ctrl-] to answer']);
});

test("the status-line script still shows hyperfocus's line when the status is missing or the user's line fails", async () => {
  const out = await runScript({ HYPERFOCUS_STATUS: join(tmpdir(), 'hf-missing-status.json'), HYPERFOCUS_USER_STATUSLINE: 'exit 3' });
  assert.equal(plain(out).trim(), '◐ hyperfocus · Ctrl-] for the quiz');
});
