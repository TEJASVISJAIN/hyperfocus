import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { listSessions } from '../src/bridge.js';
import { claudeAgent } from '../src/agents/claude.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { parseUnifiedDiff, runStaged } from '../src/staged.js';

const fakeModel = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));

const DIFF = `diff --git a/src/retry.js b/src/retry.js
index 1111111..2222222 100644
--- a/src/retry.js
+++ b/src/retry.js
@@ -1,3 +1,4 @@
 export async function withRetry(fn) {
-  for (let attempts = 1; attempts <= 3; attempts++) {
+  for (let attempts = 1; attempts < 3; attempts++) {
+    await sleep(base * 2 ** attempts);
     try {
@@ -20,2 +21,2 @@ export async function withRetry(fn) {
-  throw lastError;
+  throw new RetryError(lastError);
 }
diff --git a/src/new.js b/src/new.js
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.js
@@ -0,0 +1,2 @@
+export const base = 100;
+export const limit = 3;
diff --git a/src/gone.js b/src/gone.js
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-export const old = true;
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`;

test('a staged diff becomes one edit per file, one change per hunk', () => {
  const edits = parseUnifiedDiff(DIFF);
  assert.deepEqual(edits.map((edit) => edit.path), ['src/retry.js', 'src/new.js', 'src/gone.js']);
  assert.deepEqual(edits[0].changes, [
    { before: '  for (let attempts = 1; attempts <= 3; attempts++) {', after: '  for (let attempts = 1; attempts < 3; attempts++) {\n    await sleep(base * 2 ** attempts);' },
    { before: '  throw lastError;', after: '  throw new RetryError(lastError);' },
  ]);
  assert.deepEqual(edits[1].changes, [{ before: '', after: 'export const base = 100;\nexport const limit = 3;' }]);
  assert.deepEqual(edits[2].changes, [{ before: 'export const old = true;', after: '' }]);
});

test('code lines that look like diff headers stay code', () => {
  const diff = `diff --git a/q.sql b/q.sql
--- a/q.sql
+++ b/q.sql
@@ -1,2 +1,2 @@
--- old comment about the join
+++ new comment about the join
 select 1;
diff --git a/r.js b/r.js
--- a/r.js
+++ b/r.js
@@ -1 +1 @@
-old
+new
`;
  assert.deepEqual(parseUnifiedDiff(diff), [
    { path: 'q.sql', changes: [{ before: '-- old comment about the join', after: '++ new comment about the join' }] },
    { path: 'r.js', changes: [{ before: 'old', after: 'new' }] },
  ]);
});

test('an empty diff has no edits', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n'), []);
});

function panelClient(endpoint) {
  const socket = connect(endpoint);
  let received = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => (received += chunk));
  const messages = () => received.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const until = async (predicate) => {
    for (let waited = 0; waited < 5000; waited += 25) {
      const found = messages().findLast(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('no such message: ' + received.slice(-400));
  };
  return { socket, until, send: (message) => socket.write(JSON.stringify(message) + '\n') };
}

async function waitForSession(dir) {
  for (let waited = 0; waited < 5000; waited += 25) {
    const [session] = listSessions(dir);
    if (session) return session;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no session file');
}

function stagedRun(diff, extra = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hf-staged-'));
  const output = [];
  const done = runStaged({
    cwd: '/work/app',
    diff,
    config: DEFAULT_CONFIG,
    writer: { path: fakeModel, adapter: claudeAgent.writer, model: 'haiku' },
    sessionsDir: join(home, 'sessions'),
    historyPath: join(home, 'history.jsonl'),
    write: (text) => void output.push(text),
    ...extra,
  });
  return { home, output, done };
}

test('nothing staged: says so and starts nothing', async () => {
  const { home, output, done } = stagedRun('');
  assert.equal(await done, 0);
  assert.match(output.join(''), /Nothing staged/);
  assert.ok(!existsSync(join(home, 'sessions')));
});

test('a staged review: questions about the diff go to the panel, answers go to history as staged, and it ends after the last one', async () => {
  const { home, output, done } = stagedRun(DIFF);
  const session = await waitForSession(join(home, 'sessions'));
  assert.equal(session.agent, 'staged');
  assert.equal(session.cwd, '/work/app');
  const panel = panelClient(session.endpoint);

  let state = await panel.until((message) => message.type === 'state' && message.question);
  assert.equal(state.question.q, 'Why retry refreshToken?');
  assert.equal(state.queued, 1, 'one batch, two questions from the stub model');

  panel.send({ type: 'answer', id: state.question.id, chosen: state.question.options.indexOf('Token expiry races') });
  await panel.until((message) => message.type === 'state' && message.feedback?.correct === true);
  panel.send({ type: 'next', id: state.question.id });
  state = await panel.until((message) => message.type === 'state' && message.question?.q === 'How many attempts?');
  panel.send({ type: 'skip', id: state.question.id });

  assert.equal(await done, 0);
  const history = readFileSync(join(home, 'history.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(history.map((entry) => [entry.source, entry.cwd, entry.correct, entry.skipped]), [['staged', '/work/app', true, false], ['staged', '/work/app', null, true]]);
  assert.ok(!existsSync(join(home, 'sessions', `${process.pid}.json`)), 'the session file is gone');
  assert.match(output.join(''), /1 of 1 right/);
  panel.socket.destroy();
});

test('a staged review waits for the whole reply: questions that stream in slowly all arrive', async () => {
  process.env.FAKE_HAIKU_STREAM_DELAY_MS = '800';
  try {
    const { home, done } = stagedRun(DIFF);
    const session = await waitForSession(join(home, 'sessions'));
    const panel = panelClient(session.endpoint);
    const first = await panel.until((message) => message.type === 'state' && message.question);
    assert.equal(first.question.q, 'Why retry refreshToken?');
    await panel.until((message) => message.type === 'state' && message.queued === 1);
    panel.send({ type: 'back' });
    assert.equal(await done, 0);
    panel.socket.destroy();
  } finally {
    delete process.env.FAKE_HAIKU_STREAM_DELAY_MS;
  }
});

test('a staged review ends when the panel that was following it goes away', async () => {
  const { home, done } = stagedRun(DIFF);
  const session = await waitForSession(join(home, 'sessions'));
  const panel = panelClient(session.endpoint);
  await panel.until((message) => message.type === 'state' && message.question);
  panel.socket.destroy();
  assert.equal(await done, 0);
});

test('a staged review ends when the panel asks to end it', async () => {
  const { home, done } = stagedRun(DIFF);
  const session = await waitForSession(join(home, 'sessions'));
  const panel = panelClient(session.endpoint);
  await panel.until((message) => message.type === 'state' && message.question);
  panel.send({ type: 'back' });
  assert.equal(await done, 0);
  panel.socket.destroy();
});

test('a staged review gives up when no questions come', async () => {
  const { output, done } = stagedRun(DIFF, {
    writer: { path: '/nonexistent/model', adapter: claudeAgent.writer, model: 'haiku' },
    noQuestionMs: 300,
  });
  assert.equal(await done, 1);
  assert.match(output.join(''), /No questions/);
});

test('hyperfocus --staged reviews what git has staged and ends when the panel leaves', async () => {
  const { execFileSync, spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const repo = mkdtempSync(join(tmpdir(), 'hf-staged-repo-'));
  const home = mkdtempSync(join(tmpdir(), 'hf-staged-home-'));
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  writeFileSync(join(repo, 'retry.js'), 'export const attempts = 3;\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'first');
  writeFileSync(join(repo, 'retry.js'), 'export const attempts = 3;\nexport const backoffBaseMs = 250;\n');
  git('add', '.');

  const bin = fileURLToPath(new URL('../bin/hyperfocus.js', import.meta.url));
  const fakeClaude = fileURLToPath(new URL('./fixtures/fake-claude-with-quiz.js', import.meta.url));
  const child = spawn(process.execPath, [bin, '--staged'], { cwd: repo, env: { ...process.env, HYPERFOCUS_HOME: home, HYPERFOCUS_CLAUDE_BIN: fakeClaude } });
  let stdout = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  const exited = new Promise((resolve) => child.on('exit', resolve));

  const session = await waitForSession(join(home, 'sessions'));
  assert.equal(session.agent, 'staged');
  const panel = panelClient(session.endpoint);
  await panel.until((message) => message.type === 'state' && message.question);
  panel.socket.destroy();
  assert.equal(await exited, 0);
  assert.match(stdout, /Writing questions about 1 staged file/);
});
