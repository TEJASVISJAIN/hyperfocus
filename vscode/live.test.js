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
  assert.deepEqual(answered.feedback, { verdict: 'Not quite', tone: 'bad', why: 'The loop stops one short.', saved: false });
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
  assert.equal(liveModel(state, { agent: 'codex' }).status.text, 'Codex is editing src/retry.js');
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

// ── Controls, code locations, gutter marks, notebook, notifications, start ──
const { anchorRange, controlsFor, finishedNow, gutterMarks, notebookTree, startCommand, findOnPath, resolveInside } = require('./panel-state');

test('controls follow the same rules as the keys', () => {
  assert.deepEqual(controlsFor(state), { answer: true, skip: true, rate: true, next: false, save: false, followUp: false, keepGoing: false, back: false, exit: true });
  const answered = { ...state, feedback: { chosen: 0, correct: true, answer: 0, why: 'x', saved: false } };
  assert.deepEqual(controlsFor(answered), { answer: false, skip: false, rate: true, next: true, save: true, followUp: true, keepGoing: false, back: false, exit: true });
  assert.equal(controlsFor({ ...answered, feedback: { ...answered.feedback, saved: true } }).save, false);
  assert.equal(controlsFor({ ...answered, thread: [{ ask: 'why?', answer: null }] }).followUp, false, 'one follow-up at a time');
  const finished = { ...state, agent: { ...state.agent, finished: true } };
  assert.deepEqual(controlsFor(finished), { answer: true, skip: true, rate: false, next: false, save: false, followUp: false, keepGoing: true, back: true, exit: false });
  assert.deepEqual(Object.entries(controlsFor({ ...state, question: null })).filter(([, on]) => on).map(([name]) => name), ['exit'], 'back to the agent, like Esc, is always there');
  assert.equal(liveModel(state, { agent: 'staged' }).controls.exit, false, 'a staged review has no agent');
});

test('the live card carries its controls, and a staged review is named as one', () => {
  assert.equal(liveModel(state).controls.answer, true);
  assert.equal(liveModel(state, { agent: 'staged' }).status.text, 'Reviewing your staged change');
  assert.equal(liveModel({ ...state, question: null }, { agent: 'staged' }).status.text, 'Writing questions about your staged change…');
  assert.equal(liveModel(state, { agent: 'staged' }).staged, true);
  assert.equal(liveModel(state, { agent: 'codex' }).status.text, 'Codex is editing src/retry.js');
});

const FILE = ['import { sleep } from "./sleep.js";', '', 'export async function withRetry(fn) {', '  for (let attempts = 1; attempts < 3; attempts++) {', '    await sleep(base * 2 ** attempts);', '  }', '}'].join('\n');

test('an anchor is found where its lines are now, even after the file moved around', () => {
  const anchor = { file: 'src/retry.js', anchors: ['for (let attempts = 1; attempts < 3; attempts++) {', 'await sleep(base * 2 ** attempts);'] };
  assert.deepEqual(anchorRange(anchor, FILE), { start: 3, end: 4 });
  assert.deepEqual(anchorRange(anchor, '// a new header\n\n' + FILE), { start: 5, end: 6 });
});

test('an anchor that is mostly gone is not found, the same rule as hyperfocus uses', () => {
  const anchor = { file: 'src/retry.js', anchors: ['for (let attempts = 1; attempts < 3; attempts++) {', 'await sleep(base * 2 ** attempts);', 'this line was reverted away', 'and so was this one'] };
  assert.deepEqual(anchorRange(anchor, FILE), { start: 3, end: 4 }, 'half is enough');
  assert.equal(anchorRange({ ...anchor, anchors: [...anchor.anchors, 'a fifth line gone too'] }, FILE), null);
  assert.equal(anchorRange({ file: 'x', anchors: [] }, FILE), null);
  assert.equal(anchorRange(null, FILE), null);
});

test('gutter marks: this file, this project, latest answer per question, nothing for skips, predictions or bad questions', () => {
  const anchor = { file: 'src/retry.js', anchors: ['for (let attempts = 1; attempts < 3; attempts++) {'] };
  const entry = (question, correct, extra = {}) => ({ ts: '2026-10-01T10:00:00Z', cwd: '/work/app', question, options: ['a', 'b'], answer: 0, chosen: correct ? 0 : 1, correct, anchor, ...extra });
  const marks = gutterMarks(
    [
      entry('Which line drops the last retry?', false),
      entry('Which line drops the last retry?', true, { ts: '2026-10-02T10:00:00Z' }),
      entry('Elsewhere?', false, { cwd: '/work/other' }),
      entry('Other file?', false, { anchor: { file: 'src/other.js', anchors: anchor.anchors } }),
      entry('Skipped?', null, { chosen: null, skipped: true }),
      entry('Bad?', false, { rating: 'bad' }),
      entry('Gone?', false, { anchor: { file: 'src/retry.js', anchors: ['not in the file any more at all'] } }),
    ],
    { cwd: '/work/app', file: 'src/retry.js', text: FILE },
  );
  assert.deepEqual(marks.map((mark) => [mark.line, mark.correct, mark.question]), [[3, true, 'Which line drops the last retry?']]);
  assert.match(marks[0].hover, /Which line drops the last retry\?/);
  assert.match(marks[0].hover, /✅/);
});

test('the notebook tree: project, then tag, then question, newest project first', () => {
  const saved = [
    { ts: '2026-10-01T10:00:00Z', cwd: '/work/app', question: 'One?', tags: ['async', 'errors'] },
    { ts: '2026-10-01T11:00:00Z', cwd: '/work/app', question: 'Two?', tags: ['async'] },
    { ts: '2026-10-02T09:00:00Z', cwd: '/work/web', question: 'Three?' },
  ];
  const tree = notebookTree(saved);
  assert.deepEqual(tree.map((project) => project.label), ['web', 'app']);
  assert.deepEqual(tree[0].children.map((tag) => tag.label), ['untagged']);
  assert.deepEqual(tree[1].children.map((tag) => [tag.label, tag.children.map((entry) => entry.label)]), [['async', ['Two?', 'One?']], ['errors', ['One?']]]);
  assert.equal(tree[1].children[0].children[0].entry, saved[1]);
});

test('the "agent finished" notice fires once, on the change, and never while quiet or for a staged review', () => {
  const busy = { ...state, agent: { ...state.agent, finished: false } };
  const done = { ...state, agent: { ...state.agent, finished: true } };
  assert.equal(finishedNow(busy, done), true);
  assert.equal(finishedNow(done, done), false);
  assert.equal(finishedNow(null, done), false, 'connecting to a session that had already finished is not news');
  assert.equal(finishedNow(busy, { ...done, quiet: true }), false);
  assert.equal(finishedNow(busy, { ...done, agent: { ...done.agent, activity: 'done' } }), true);
  assert.equal(finishedNow(busy, { ...state, agent: { activity: 'done', busy: false, finished: false } }), true, 'the run ending is finishing too');
  assert.equal(finishedNow(busy, done, { staged: true }), false);
});

test('the start command: hyperfocus if installed, else npx, plus the agent; a custom command is left alone', () => {
  const base = { configured: 'npx @ddalus/hyperfocus', defaultCommand: 'npx @ddalus/hyperfocus' };
  assert.equal(startCommand({ ...base, hyperfocusOnPath: true, agent: 'claude' }), 'hyperfocus');
  assert.equal(startCommand({ ...base, hyperfocusOnPath: false, agent: 'claude' }), 'npx @ddalus/hyperfocus');
  assert.equal(startCommand({ ...base, hyperfocusOnPath: true, agent: 'codex' }), 'hyperfocus codex');
  assert.equal(startCommand({ ...base, configured: 'hf --no-auto', hyperfocusOnPath: true, agent: 'codex' }), 'hf --no-auto');
  assert.equal(startCommand({ ...base, configured: 'hf codex', hyperfocusOnPath: true, extra: '--staged' }), 'hf codex --staged', 'a custom command still gets --staged');
  assert.equal(startCommand({ ...base, hyperfocusOnPath: false, agent: 'gemini', extra: '--staged' }), 'npx @ddalus/hyperfocus gemini --staged');
});

test('finding programs on PATH, with Windows extensions', () => {
  const files = new Set(['/usr/bin/claude', 'C:\\tools\\codex.cmd']);
  const isFile = (path) => files.has(path);
  assert.equal(findOnPath('claude', { env: { PATH: '/bin:/usr/bin' }, platform: 'darwin', isFile }), '/usr/bin/claude');
  assert.equal(findOnPath('gemini', { env: { PATH: '/bin:/usr/bin' }, platform: 'darwin', isFile }), null);
  assert.equal(findOnPath('codex', { env: { Path: 'C:\\x;C:\\tools', PATHEXT: '.EXE;.CMD' }, platform: 'win32', isFile }), 'C:\\tools\\codex.cmd');
});

test('the live card offers exactly the controls the state allows', () => {
  const html = (s, opts) => liveHtml(liveModel(s, opts));
  const asking = html(state);
  assert.equal((asking.match(/data-act="answer"/g) ?? []).length, 2);
  assert.match(asking, /data-act="skip"/);
  assert.doesNotMatch(asking, /data-act="next"|data-act="save"|class="follow-up"/);

  const answered = html({ ...state, feedback: { chosen: 1, correct: false, answer: 0, why: 'x', saved: false } });
  assert.doesNotMatch(answered, /data-act="answer"/);
  assert.match(answered, /data-act="next"/);
  assert.match(answered, /data-act="save"/);
  assert.match(answered, /class="follow-up"/);
  assert.match(html({ ...state, feedback: { chosen: 1, correct: false, answer: 0, why: 'x', saved: true } }), /✓ saved/);

  const finished = html({ ...state, agent: { ...state.agent, finished: true } });
  assert.match(finished, /data-act="back"[^>]*>Back to the agent/);
  assert.match(finished, /data-act="keepGoing"/);
  assert.match(html(state, { agent: 'staged' }), />End review</, 'a staged review can be ended any time');
  assert.match(asking, /data-open="question"/, 'the file opens the code');
});

test('a staged review is never adopted by a window for another folder', () => {
  assert.equal(pickSession([session(9, '/elsewhere', undefined, { agent: 'staged' })], ['/work/app']), null);
  assert.equal(pickSession([session(9, '/work/app', undefined, { agent: 'staged' })], ['/work/app']).pid, 9);
});

test('code is only opened inside the session folder', () => {
  assert.equal(resolveInside('/work/app', 'src/retry.js'), '/work/app/src/retry.js');
  assert.equal(resolveInside('/work/app', '/work/app/src/retry.js'), '/work/app/src/retry.js');
  assert.equal(resolveInside('/work/app', '../../home/me/.ssh/id_rsa'), null);
  assert.equal(resolveInside('/work/app', '/home/me/.ssh/id_rsa'), null);
  assert.equal(resolveInside('/work/app', ''), null);
  assert.equal(resolveInside(null, 'src/x.js'), null);
});

test('the dashboard copes with a history entry without a timestamp', () => {
  const { render } = require('./views');
  const data = { answered: 1, correct: 0, last30: { answered: 1, correct: 0 }, streak: 0, weakSpots: [], missed: [{ question: 'Q?', options: ['a'], answer: 0, chosen: 0, correct: false, ts: 12 }], saved: [] };
  assert.match(render(data, { scope: 'project', project: 'x', nonce: 'n' }), /Q\?/);
});
