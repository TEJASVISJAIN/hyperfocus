import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createQuizEngine } from '../src/quiz-engine.js';

const fakeHaiku = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));

function setup(mode = 'fenced') {
  const logPath = join(mkdtempSync(join(tmpdir(), 'focus-engine-')), 'calls.jsonl');
  const engine = createQuizEngine({
    claudePath: fakeHaiku,
    env: { ...process.env, FAKE_HAIKU_MODE: mode, FAKE_HAIKU_LOG: logPath, CLAUDE_FOCUS_SOCK: '/tmp/parent.sock' },
  });
  const calls = () => (existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { engine, calls };
}

function makeRun(overrides = {}) {
  return {
    prompt: 'add retry to token refresh',
    startedAt: 1,
    finished: false,
    reads: ['src/auth.ts'],
    edits: [{ path: 'src/auth.ts', diff: '- return fetchToken();\n+ return withRetry(fetchToken);' }],
    commands: [],
    ...overrides,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test('turns the current run into a summary and multiple-choice questions', async () => {
  const { engine, calls } = setup();
  const batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  const [batch] = await batchArrived;

  assert.equal(batch.summary, 'Claude is wrapping refreshToken() in a retry helper.');
  assert.equal(batch.questions.length, 2);
  assert.deepEqual(batch.questions[0], {
    q: 'Why retry refreshToken?',
    options: ['Rate limits', 'Token expiry races', 'Caching'],
    answer: 1,
    why: 'Concurrent requests can race.',
  });

  const [call] = calls();
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku');
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '', 'the quiz model gets no tools');
  assert.ok(call.argv.includes('-p'));
  assert.equal(call.child, '1', 'marks the session so focus hooks ignore it');
  assert.equal(call.sock, null, 'does not leak the parent socket');
  assert.equal(call.argv[call.argv.indexOf('--setting-sources') + 1], 'user,project,local', 'keeps auth setup such as apiKeyHelper');
  assert.equal(JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]).disableAllHooks, true, 'but none of their hooks');
  assert.equal(call.maxThinking, '0', 'thinking off: it made each batch ~30s instead of ~6s');
  assert.match(call.stdin, /add retry to token refresh/);
  assert.match(call.stdin, /\+ return withRetry\(fetchToken\);/);
});

test('before anything changed, asks about the code being read and the goal', async () => {
  const { engine, calls } = setup();
  const batchArrived = once(engine, 'batch');
  engine.update(makeRun({ edits: [] }), { queuedQuestions: 0 });
  await batchArrived;
  const { stdin } = calls()[0];
  assert.match(stdin, /No changes yet/);
  assert.match(stdin, /src\/auth\.ts/);
});

test('retries once when the reply is not valid JSON', async () => {
  const { engine, calls } = setup('invalid-then-valid');
  const batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.equal(calls().length, 2);
});

test('gives up quietly after a second bad reply or an API error', async () => {
  for (const mode of ['always-invalid', 'error']) {
    const { engine, calls } = setup(mode);
    let batches = 0;
    engine.on('batch', () => batches++);
    engine.update(makeRun(), { queuedQuestions: 0 });
    await settle();
    assert.equal(batches, 0, mode);
    assert.equal(calls().length, mode === 'error' ? 1 : 2, mode);
  }
});

test('only one model call runs at a time', async () => {
  const { engine, calls } = setup();
  const batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await settle();
  assert.equal(calls().length, 1);
});

test('with questions still queued, waits for three new edits before asking again', async () => {
  const { engine, calls } = setup();
  const edit = (index) => ({ path: `f${index}.ts`, diff: `+ ${index}` });
  let batchArrived = once(engine, 'batch');
  engine.update(makeRun({ edits: [edit(0)] }), { queuedQuestions: 0 });
  await batchArrived;

  engine.update(makeRun({ edits: [edit(0), edit(1)] }), { queuedQuestions: 2 });
  engine.update(makeRun({ edits: [edit(0), edit(1), edit(2)] }), { queuedQuestions: 2 });
  await settle();
  assert.equal(calls().length, 1);

  batchArrived = once(engine, 'batch');
  engine.update(makeRun({ edits: [edit(0), edit(1), edit(2), edit(3)] }), { queuedQuestions: 2 });
  await batchArrived;
  assert.equal(calls().length, 2);
});

test('when the queue runs dry, asks for more without repeating earlier questions', async () => {
  const { engine, calls } = setup();
  let batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;

  batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.match(calls()[1].stdin, /Why retry refreshToken\?/, 'earlier questions are listed so they are not repeated');
});

test('does not keep asking when nothing changed and the model had no questions', async () => {
  const { engine, calls } = setup('no-questions');
  const batchArrived = once(engine, 'batch');
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  engine.update(makeRun(), { queuedQuestions: 0 });
  await settle();
  assert.equal(calls().length, 1);
});

test('cancelling drops the in-flight call', async () => {
  const { engine } = setup('slow');
  let batches = 0;
  engine.on('batch', () => batches++);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  engine.cancel();
  await new Promise((resolve) => setTimeout(resolve, 3300));
  assert.equal(batches, 0);
});

test('a finished run or a run with nothing in it is left alone', async () => {
  const { engine, calls } = setup();
  engine.update(makeRun({ finished: true }), { queuedQuestions: 0 });
  engine.update(makeRun({ prompt: '', reads: [], edits: [] }), { queuedQuestions: 0 });
  engine.update(null, { queuedQuestions: 0 });
  await settle();
  assert.equal(calls().length, 0);
});

test('the first change refreshes questions written while the agent was only reading', async () => {
  const { engine, calls } = setup();
  let batchArrived = once(engine, 'batch');
  engine.update(makeRun({ edits: [] }), { queuedQuestions: 0 });
  await batchArrived;

  batchArrived = once(engine, 'batch');
  engine.update(makeRun({ edits: [{ path: 'retry.js', diff: '+ export function withRetry() {}' }] }), { queuedQuestions: 2 });
  await batchArrived;
  assert.equal(calls().length, 2);
  assert.match(calls()[1].stdin, /withRetry/);
});

test('a new prompt cancels the previous run\'s call instead of waiting for it', async () => {
  const { engine, calls } = setup('slow');
  engine.update(makeRun({ startedAt: 1 }), { queuedQuestions: 0 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  engine.update(makeRun({ startedAt: 2, prompt: 'a different task' }), { queuedQuestions: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls().length, 2, 'the new run got its own call straight away');
  assert.match(calls()[1].stdin, /a different task/);
  engine.cancel();
});
