// node --test vscode/live.test.js: the live panel's session choice, state and connection.
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { liveModel, listSessions, pickSession, protocolProblem, statusBarText } = require('./panel-state');
const { liveHtml } = require('./views');
const { LiveConnection } = require('./live');

const session = (pid, cwd, startedAt = '2026-10-01T10:00:00.000Z', extra = {}) => ({ protocol: 1, pid, cwd, agent: 'claude', endpoint: `/tmp/hf-${pid}.sock`, startedAt, ...extra });

test('the session for this folder wins, the most specific folder first', () => {
  const sessions = [session(1, '/work/other'), session(2, '/work/app'), session(3, '/work/app/packages/api')];
  assert.equal(pickSession(sessions, ['/work/app']).pid, 2);
  assert.equal(pickSession(sessions, ['/work/app/packages/api']).pid, 3);
  assert.equal(pickSession(sessions, ['/work/other', '/elsewhere']).pid, 1);
});

test('a session started in a subfolder of the workspace counts', () => {
  assert.equal(pickSession([session(4, '/work/app/web')], ['/work/app']).pid, 4);
  assert.equal(pickSession([session(4, '/work/apple'), session(5, '/work/app')], ['/work/app']).pid, 5, 'a sibling with a shared prefix is not a subfolder');
});

test('two sessions for the same folder: the newest', () => {
  const sessions = [session(5, '/work/app', '2026-10-01T09:00:00.000Z'), session(6, '/work/app', '2026-10-01T11:00:00.000Z')];
  assert.equal(pickSession(sessions, ['/work/app']).pid, 6);
});

test('with no folder match, the only running session is used, otherwise none', () => {
  assert.equal(pickSession([session(7, '/somewhere')], ['/work/app']).pid, 7);
  assert.equal(pickSession([session(7, '/somewhere')], []).pid, 7);
  assert.equal(pickSession([session(7, '/a'), session(8, '/b')], ['/work/app']), null);
  assert.equal(pickSession([], ['/work/app']), null);
});

test('session files: dead processes and junk are skipped, a missing folder is no sessions', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hf-live-')), 'sessions');
  assert.deepEqual(listSessions(dir), []);
  mkdirSync(dir);
  writeFileSync(join(dir, '1.json'), JSON.stringify(session(1, '/a')));
  writeFileSync(join(dir, '2.json'), JSON.stringify(session(2, '/b')));
  writeFileSync(join(dir, 'x.json'), 'not json');
  writeFileSync(join(dir, 'y.json'), JSON.stringify({ pid: 'nope' }));
  assert.deepEqual(listSessions(dir, { isAlive: (pid) => pid === 2 }).map((s) => s.pid), [2]);
});

test('a protocol the panel does not speak is explained, not guessed at', () => {
  assert.equal(protocolProblem(1), null);
  assert.match(protocolProblem(0), /update hyperfocus/i);
  assert.match(protocolProblem(undefined), /update hyperfocus/i);
  assert.match(protocolProblem(2), /update the hyperfocus extension/i);
});

const state = {
  agent: { activity: 'editing src/retry.js', since: 0, busy: true, finished: false },
  run: { summary: 'Adds retry with backoff.', startedAt: 0, prompt: 'add retry', files: ['src/retry.js'] },
  question: { id: 3, number: 2, kind: 'bug', q: 'Which line drops the last retry?', options: ['attempts < 3', 'attempts <= 3'], code: 'for (…; attempts < 3; …)', file: 'src/retry.js' },
  queued: 1,
  feedback: null,
  thread: [],
  followUpFailed: false,
  score: { answered: 1, correct: 1, streak: 1 },
  result: null,
  quiet: false,
};

test('the live card: what the agent is doing, the question and what is queued', () => {
  const model = liveModel(state);
  assert.equal(model.status.text, 'Claude is editing src/retry.js');
  assert.equal(model.status.tone, 'busy');
  assert.equal(model.question.heading, 'Question 2 · spot the bug');
  assert.deepEqual(model.question.options.map((o) => [o.key, o.text, o.mark]), [['1', 'attempts < 3', ''], ['2', 'attempts <= 3', '']]);
  assert.equal(model.queued, '1 more question waiting');
  assert.equal(model.score, '1 of 1 right this run');
  assert.equal(model.summary, 'Adds retry with backoff.');
});

test('the live card after an answer marks yours and the right one, and shows why', () => {
  const answered = liveModel({ ...state, feedback: { chosen: 1, correct: false, answer: 0, why: 'The loop stops one short.', saved: false } });
  assert.deepEqual(answered.question.options.map((o) => o.mark), ['answer', 'chosen']);
  assert.deepEqual(answered.feedback, { verdict: 'Not quite', tone: 'bad', why: 'The loop stops one short.' });
  const right = liveModel({ ...state, feedback: { chosen: 0, correct: true, answer: 0, why: 'x', saved: false } });
  assert.deepEqual(right.question.options.map((o) => o.mark), ['answer', '']);
  assert.equal(right.feedback.verdict, 'Right');
});

test('the live card when the agent has finished, is waiting, or there is no question yet', () => {
  assert.equal(liveModel({ ...state, agent: { ...state.agent, finished: true } }).status.text, 'Claude finished');
  assert.equal(liveModel({ ...state, agent: { activity: 'waiting for you', busy: false, finished: false } }).status.tone, 'waiting');
  const empty = liveModel({ ...state, question: null, queued: 0 });
  assert.equal(empty.question, null);
  assert.equal(empty.queued, '');
  assert.equal(liveModel(state, { agentName: 'Codex' }).status.text, 'Codex is editing src/retry.js');
});

test('the status bar text', () => {
  assert.equal(statusBarText(null), '$(circle-outline) hyperfocus');
  assert.equal(statusBarText(state), '$(circle-filled) hyperfocus · 2 waiting · streak 1');
  assert.equal(statusBarText({ ...state, question: null, queued: 0, score: { answered: 0, correct: 0, streak: 0 } }), '$(circle-filled) hyperfocus');
});

test('the live card is escaped HTML', () => {
  const html = liveHtml(liveModel({ ...state, question: { ...state.question, q: '<img src=x onerror=alert(1)>' } }));
  assert.ok(!html.includes('<img'));
  assert.match(html, /&lt;img/);
  assert.match(html, /Claude is editing src\/retry\.js/);
});

// The connection, against the CLI's real bridge, so the two can't drift apart unnoticed.
async function realBridge(dir, current) {
  const { startBridge } = await import('../src/bridge.js');
  return startBridge({ sessionsDir: dir, meta: { cwd: '/work/app', agent: 'claude' }, state: () => current.state, act: () => 'ok' });
}

const until = async (check, what) => {
  for (let waited = 0; waited < 3000; waited += 20) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for ' + what);
};

test('the connection finds the session for the folder, follows its state, and notices it end', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hf-live-')), 'sessions');
  const current = { state };
  const live = new LiveConnection({ sessionsDir: dir, folders: () => ['/work/app'], pollMs: 50 });
  const changes = [];
  live.on('change', (snapshot) => changes.push(snapshot));
  live.start();
  try {
    assert.equal(live.snapshot().status, 'none');
    const bridge = await realBridge(dir, current);
    await until(() => live.snapshot().status === 'live' && live.snapshot().state, 'live');
    assert.equal(live.snapshot().session.cwd, '/work/app');
    assert.equal(live.snapshot().state.question.q, state.question.q);

    current.state = { ...state, queued: 0, question: { ...state.question, q: 'Next one?' } };
    bridge.publish();
    await until(() => live.snapshot().state?.question.q === 'Next one?', 'the next state');

    bridge.close();
    await until(() => live.snapshot().status === 'none', 'the end of the session');
    assert.equal(live.snapshot().state, null);
    assert.ok(changes.length >= 3);
  } finally {
    live.dispose();
  }
});

test('the connection refuses a protocol it does not know and says why', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hf-live-')), 'sessions');
  const net = require('node:net');
  const socketPath = join(tmpdir(), `hf-live-${process.pid}-${Date.now()}.sock`);
  const server = net.createServer((socket) => socket.write(JSON.stringify({ type: 'hello', protocol: 2, pid: process.pid, cwd: '/work/app', agent: 'claude' }) + '\n'));
  await new Promise((resolve) => server.listen(socketPath, resolve));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify({ ...session(process.pid, '/work/app'), protocol: 2, endpoint: socketPath }));
  const live = new LiveConnection({ sessionsDir: dir, folders: () => ['/work/app'], pollMs: 50 });
  live.start();
  try {
    await until(() => live.snapshot().status === 'mismatch', 'mismatch');
    assert.match(live.snapshot().problem, /update the hyperfocus extension/i);
  } finally {
    live.dispose();
    server.close();
  }
});

test('the connection comes back after the bridge restarts', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hf-live-')), 'sessions');
  const current = { state };
  const live = new LiveConnection({ sessionsDir: dir, folders: () => ['/work/app'], pollMs: 50, backoffMs: [20, 40] });
  live.start();
  try {
    let bridge = await realBridge(dir, current);
    await until(() => live.snapshot().status === 'live', 'first connect');
    bridge.close();
    await until(() => live.snapshot().status === 'none', 'disconnect');
    bridge = await realBridge(dir, current);
    await until(() => live.snapshot().status === 'live' && live.snapshot().state, 'reconnect');
    bridge.close();
  } finally {
    live.dispose();
  }
});
