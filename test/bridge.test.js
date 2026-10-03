import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { BRIDGE_PROTOCOL, listSessions, startBridge } from '../src/bridge.js';
import { createFocusSession } from '../src/focus-session.js';

const bugQuestion = {
  q: 'Which line drops the last retry?',
  options: ['attempts < 3', 'attempts <= 3', 'await sleep(ms)'],
  answer: 0,
  why: 'The loop stops one short.',
  kind: 'bug',
  file: 'src/retry.js',
  code: 'for (let attempts = 1; attempts < 3; attempts++)',
  anchor: { file: 'src/retry.js', anchors: ['for (let attempts = 1; attempts < 3; attempts++)'] },
};
const whyQuestion = { q: 'Why back off?', options: ['Rate limits', 'Style'], answer: 0, why: 'The API throttles.' };

const fakeModel = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));
const cleanups = [];
afterEach(() => cleanups.splice(0).forEach((cleanup) => cleanup()));

// A focus session the way the app builds one, with the callbacks recorded, and a bridge on it.
async function setup({ quiet = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hf-bridge-'));
  const calls = { answers: [], saves: [], followUps: [], back: 0, keepGoing: 0, quiet: 0, exit: 0 };
  let session;
  const bridgeRef = {};
  session = createFocusSession({
    claudePath: fakeModel,
    redraw: () => bridgeRef.bridge?.publish(),
    onAnswer: (entry) => calls.answers.push(entry),
    onSave: (entry) => (calls.saves.push(entry), true),
    onBack: () => calls.back++,
    onQuiet: () => calls.quiet++,
    onExit: () => calls.exit++,
  });
  const bridge = await startBridge({
    sessionsDir: join(home, 'sessions'),
    meta: { cwd: '/work/app', agent: 'claude' },
    state: () => ({ ...session.snapshot(), quiet }),
    act: (action) => session.act(action),
  });
  bridgeRef.bridge = bridge;
  cleanups.push(() => bridge.close());
  return { home, session, bridge, calls };
}

// A client the way the VS Code extension connects: reads JSON lines, writes JSON lines.
async function client(socketPath) {
  const socket = connect(socketPath);
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject));
  cleanups.push(() => socket.destroy());
  const messages = [];
  const waiters = [];
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
      waiters.splice(0).forEach((wake) => wake());
    }
  });
  let read = 0;
  /** The next message matching `predicate`, skipping the ones before it. @param {(message: any) => any} [predicate] */
  const next = async (predicate = (_message) => true) => {
    for (;;) {
      while (read < messages.length) {
        const message = messages[read++];
        if (predicate(message)) return message;
      }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no message within 2s')), 2000);
        waiters.push(() => (clearTimeout(timer), resolve(undefined)));
      });
    }
  };
  const send = (message) => socket.write(JSON.stringify(message) + '\n');
  return { next, send, socket };
}

const isState = (message) => message.type === 'state';

test('a client gets a hello and a snapshot of what the session shows', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion, whyQuestion]);
  session.view.setSummary('Adds retry with backoff to the token refresh.');
  const panel = await client(bridge.socketPath);

  const hello = await panel.next();
  assert.deepEqual({ ...hello, pid: typeof hello.pid }, { type: 'hello', protocol: BRIDGE_PROTOCOL, pid: 'number', cwd: '/work/app', agent: 'claude' });

  const state = await panel.next(isState);
  assert.equal(state.question.q, bugQuestion.q);
  assert.deepEqual(state.question.options, bugQuestion.options);
  assert.equal(state.question.kind, 'bug');
  assert.equal(state.question.code, bugQuestion.code);
  assert.deepEqual(state.question.anchor, bugQuestion.anchor);
  assert.equal(typeof state.question.id, 'number');
  assert.equal(state.question.answer, undefined, 'the answer is not sent before the user answers');
  assert.equal(state.queued, 1);
  assert.equal(state.run.summary, 'Adds retry with backoff to the token refresh.');
  assert.equal(state.feedback, null);
  assert.deepEqual(state.score, { answered: 0, correct: 0, streak: 0 });
  assert.equal(state.quiet, false);
});

test('answering from a client is the same as the key: feedback, history, and the terminal agrees', async () => {
  const { session, bridge, calls } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  const { question } = await panel.next(isState);

  panel.send({ type: 'answer', id: question.id, chosen: 1 });
  const state = await panel.next((message) => isState(message) && message.feedback);

  assert.deepEqual(state.feedback, { chosen: 1, correct: false, answer: 0, why: 'The loop stops one short.', saved: false });
  assert.deepEqual(state.score, { answered: 1, correct: 0, streak: 0 });
  assert.equal(calls.answers.length, 1);
  assert.equal(calls.answers[0].chosen, 1);
  assert.equal(calls.answers[0].correct, false);
  const terminal = session.view.render({ cols: 80, rows: 40, now: 0 }).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  assert.match(terminal, /The loop stops one short/, 'the terminal shows the same feedback');
});

test('an answer is shown to every connected client', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const first = await client(bridge.socketPath);
  const second = await client(bridge.socketPath);
  const { question } = await first.next(isState);
  await second.next(isState);

  first.send({ type: 'answer', id: question.id, chosen: 0 });
  const seen = await second.next((message) => isState(message) && message.feedback);
  assert.equal(seen.feedback.correct, true);
});

test('a key pressed in the terminal reaches the client too', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  await panel.next(isState);

  session.handleKey('1');
  const state = await panel.next((message) => isState(message) && message.feedback);
  assert.equal(state.feedback.chosen, 0);
});

test('an action for a question that is no longer up is refused as stale', async () => {
  const { session, bridge, calls } = await setup();
  session.view.addQuestions([bugQuestion, whyQuestion]);
  const panel = await client(bridge.socketPath);
  const { question: first } = await panel.next(isState);
  session.handleKey('1'); // answered in the terminal
  session.handleKey(' '); // and moved on

  panel.send({ type: 'answer', id: first.id, chosen: 2 });
  assert.deepEqual(await panel.next((message) => message.type === 'stale'), { type: 'stale', id: first.id });
  assert.equal(calls.answers.length, 1, 'only the terminal answer counted');
});

test('next, skip, save and bad-question behave like their keys', async () => {
  const { session, bridge, calls } = await setup();
  session.view.addQuestions([bugQuestion, whyQuestion, { ...whyQuestion, q: 'Third?' }]);
  const panel = await client(bridge.socketPath);
  let { question } = await panel.next(isState);

  panel.send({ type: 'answer', id: question.id, chosen: 0 });
  await panel.next((message) => isState(message) && message.feedback);
  panel.send({ type: 'save', id: question.id });
  const saved = await panel.next((message) => isState(message) && message.feedback?.saved);
  assert.equal(saved.feedback.saved, true);
  assert.equal(calls.saves.length, 1);
  assert.equal(calls.saves[0].question.q, bugQuestion.q);

  panel.send({ type: 'next', id: question.id });
  ({ question } = await panel.next((message) => isState(message) && message.question?.q === whyQuestion.q));

  panel.send({ type: 'skip', id: question.id });
  ({ question } = await panel.next((message) => isState(message) && message.question?.q === 'Third?'));
  assert.equal(calls.answers.at(-1).skipped, true);

  panel.send({ type: 'rate', id: question.id, rating: 'bad' });
  const after = await panel.next((message) => isState(message) && message.question === null);
  assert.equal(after.question, null);
  assert.equal(calls.answers.at(-1).rating, 'bad');
});

test('a follow-up asked from a client is answered by the question writer and lands in the thread', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  const { question } = await panel.next(isState);
  panel.send({ type: 'answer', id: question.id, chosen: 1 });
  await panel.next((message) => isState(message) && message.feedback);

  panel.send({ type: 'followUp', id: question.id, ask: 'why exclusive?' });
  const state = await panel.next((message) => isState(message) && message.thread[0]?.answer);
  // The stub model's follow-up reply.
  assert.deepEqual(state.thread, [{ ask: 'why exclusive?', answer: 'Because a request can still race the expiry window.' }]);
});

test('keep going and back act on the "agent finished" choice; quiet asks to go quiet', async () => {
  const { session, bridge, calls } = await setup();
  session.view.addQuestions([bugQuestion]);
  session.view.showFinished({ reason: 'done', changedFiles: ['src/retry.js'], score: session.view.score });
  const panel = await client(bridge.socketPath);
  const state = await panel.next(isState);
  assert.equal(state.agent.finished, true);

  panel.send({ type: 'back' });
  panel.send({ type: 'quiet' });
  await panel.next((message) => isState(message) || message.type === 'ack').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.back, 1);
  assert.equal(calls.quiet, 1);

  panel.send({ type: 'keepGoing' });
  const goingOn = await panel.next((message) => isState(message) && !message.agent.finished);
  assert.equal(goingOn.agent.finished, false);
});

test('exit hands back to the agent mid-question, like Esc', async () => {
  const { session, bridge, calls } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  await panel.next(isState);
  panel.send({ type: 'exit' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls.exit, 1);
  assert.equal(calls.answers.length, 0, 'nothing answered');
});

test('a client sending an endless line is dropped, and the session carries on for others', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const rogue = await client(bridge.socketPath);
  const closed = new Promise((resolve) => rogue.socket.once('close', resolve));
  rogue.socket.write('x'.repeat(200 * 1024));
  await closed;
  const panel = await client(bridge.socketPath);
  const { question } = await panel.next(isState);
  panel.send({ type: 'answer', id: question.id, chosen: 0 });
  assert.equal((await panel.next((message) => isState(message) && message.feedback)).feedback.correct, true);
});

test('a follow-up from a client is cut to a sane length', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  const { question } = await panel.next(isState);
  panel.send({ type: 'answer', id: question.id, chosen: 1 });
  await panel.next((message) => isState(message) && message.feedback);
  panel.send({ type: 'followUp', id: question.id, ask: 'why '.repeat(1000) });
  const state = await panel.next((message) => isState(message) && message.thread.length);
  assert.ok(state.thread[0].ask.length <= 500);
});

test('the socket lives in a directory only this user can enter', async () => {
  if (process.platform === 'win32') return;
  const { statSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const { bridge } = await setup();
  assert.equal(statSync(dirname(bridge.socketPath)).mode & 0o777, 0o700);
});

test('the bridge knows whether a panel is on screen', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  await panel.next(isState);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(bridge.watcherCount, 0, 'connected is not the same as on screen');
  panel.send({ type: 'watching', visible: true });
  await settle();
  assert.equal(bridge.watcherCount, 1);
  panel.send({ type: 'watching', visible: false });
  await settle();
  assert.equal(bridge.watcherCount, 0);
  panel.send({ type: 'watching', visible: true });
  await settle();
  panel.socket.destroy();
  await settle();
  assert.equal(bridge.watcherCount, 0, 'a panel that goes away stops watching');
});

test('junk from a client is ignored and the session carries on', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([bugQuestion]);
  const panel = await client(bridge.socketPath);
  const { question } = await panel.next(isState);
  panel.socket.write('not json\n{"type":"nonsense"}\n');
  panel.send({ type: 'answer', id: question.id, chosen: 0 });
  const state = await panel.next((message) => isState(message) && message.feedback);
  assert.equal(state.feedback.correct, true);
});

test('state text goes through secret redaction', async () => {
  const { session, bridge } = await setup();
  session.view.addQuestions([{ ...whyQuestion, code: 'const key = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"' }]);
  const panel = await client(bridge.socketPath);
  const state = await panel.next(isState);
  assert.doesNotMatch(JSON.stringify(state), /sk-ant-api03-abcdefghij/);
});

test('the session file is written on start, removed on close, and dead sessions are ignored', async () => {
  const { home, bridge } = await setup();
  const sessionsDir = join(home, 'sessions');
  const file = join(sessionsDir, `${process.pid}.json`);
  assert.ok(existsSync(file));
  const written = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(written.protocol, BRIDGE_PROTOCOL);
  assert.equal(written.pid, process.pid);
  assert.equal(written.cwd, '/work/app');
  assert.equal(written.agent, 'claude');
  assert.equal(written.endpoint, bridge.socketPath);
  assert.match(written.startedAt, /^\d{4}-\d\d-\d\dT/);

  writeFileSync(join(sessionsDir, '999999999.json'), JSON.stringify({ ...written, pid: 999999999 }));
  writeFileSync(join(sessionsDir, 'junk.json'), 'not json');
  assert.deepEqual(listSessions(sessionsDir).map((session) => session.pid), [process.pid]);
  assert.ok(!existsSync(join(sessionsDir, '999999999.json')), 'a dead session file is cleaned up');

  bridge.close();
  assert.ok(!existsSync(file));
  assert.deepEqual(listSessions(sessionsDir), []);
});

test('listSessions copes with a missing directory', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'hf-bridge-')), 'nope');
  assert.deepEqual(listSessions(dir), []);
  mkdirSync(dir);
  assert.deepEqual(listSessions(dir), []);
});

test('on Windows the bridge would listen on a named pipe', async () => {
  const { localEndpoint } = await import('../src/local-endpoint.js');
  const pipe = localEndpoint('hyperfocus-bridge-1-0', 'win32');
  assert.equal(pipe.path, '\\\\.\\pipe\\hyperfocus-bridge-1-0');
  assert.equal(pipe.isPipe, true);
  assert.match(localEndpoint('x', 'linux').path, /x\.sock$/);
});
