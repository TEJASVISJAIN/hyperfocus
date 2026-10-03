import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { copyProjectSettings, createQuizEngine } from '../src/quiz-engine.js';
import { LESSON_ASK } from '../src/quiz-prompt.js';

const fakeHaiku = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));

// A random source that makes the shuffle keep every option where it is.
const keepOrder = () => 0.999999;

function setup(mode = 'fenced', options = {}, env = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'focus-engine-'));
  const logPath = join(folder, 'calls.jsonl');
  const spawnPath = join(folder, 'spawns.jsonl');
  const engine = createQuizEngine({
    claudePath: fakeHaiku,
    env: { ...process.env, FAKE_HAIKU_MODE: mode, FAKE_HAIKU_LOG: logPath, FAKE_HAIKU_SPAWNS: spawnPath, HYPERFOCUS_SOCK: '/tmp/parent.sock', ...env },
    random: keepOrder,
    ...options,
  });
  const lines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { engine, calls: () => lines(logPath), spawns: () => lines(spawnPath) };
}

function makeRun(overrides = {}) {
  return {
    prompt: 'add retry to token refresh',
    startedAt: 1,
    finished: false,
    reads: ['src/auth.ts'],
    edits: [{ path: 'src/auth.ts', diff: '- return fetchToken();\n+ return withRetry(fetchToken);', anchors: ['return withRetry(fetchToken);'] }],
    commands: [],
    timeline: [],
    ...overrides,
  };
}

// Questions stream in one 'batch' at a time; the one with the summary ends the reply.
function finalBatch(engine) {
  return new Promise((resolve) => {
    const questions = [];
    const collect = (batch) => {
      questions.push(...batch.questions);
      if (!batch.summary) return;
      engine.off('batch', collect);
      resolve({ summary: batch.summary, questions });
    };
    engine.on('batch', collect);
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

test('turns the current run into a summary and multiple-choice questions', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  const batch = await batchArrived;

  assert.equal(batch.summary, 'Claude is wrapping refreshToken() in a retry helper.');
  assert.equal(batch.questions.length, 2);
  assert.deepEqual(batch.questions[0], {
    kind: 'why',
    q: 'Why retry refreshToken?',
    options: ['Rate limits', 'Token expiry races', 'Caching'],
    answer: 1,
    why: 'Concurrent requests can race.',
    anchor: { file: 'src/auth.ts', anchors: ['return withRetry(fetchToken);'] },
  });

  const [call] = calls();
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'haiku');
  assert.equal(call.argv[call.argv.indexOf('--tools') + 1], '', 'the quiz model gets no tools');
  assert.ok(call.argv.includes('-p'));
  assert.equal(call.child, '1', 'marks the session so hyperfocus hooks ignore it');
  assert.equal(call.sock, null, 'does not leak the parent socket');
  assert.equal(call.argv[call.argv.indexOf('--setting-sources') + 1], 'user,project,local', 'keeps auth setup such as apiKeyHelper');
  assert.equal(JSON.parse(call.argv[call.argv.indexOf('--settings') + 1]).disableAllHooks, true, 'but none of their hooks');
  assert.equal(call.maxThinking, '0', 'thinking off: it made each batch ~30s instead of ~6s');
  assert.match(call.stdin, /add retry to token refresh/);
  assert.match(call.stdin, /\+ return withRetry\(fetchToken\);/);
});

test('before anything changed, asks about the code being read and the goal', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun({ edits: [] }), { queuedQuestions: 0 });
  await batchArrived;
  const { stdin } = calls()[0];
  assert.match(stdin, /No changes yet/);
  assert.match(stdin, /src\/auth\.ts/);
});

test('retries once when the reply is not valid JSON', async () => {
  const { engine, calls } = setup('invalid-then-valid');
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.equal(calls().length, 2);
});

test('gives up quietly after a second bad reply or an API error', async () => {
  for (const mode of ['always-invalid', 'error']) {
    const { engine, calls } = setup(mode);
    let questions = 0;
    engine.on('batch', (batch) => (questions += batch.questions.length));
    engine.update(makeRun(), { queuedQuestions: 0 });
    await settle();
    assert.equal(questions, 0, mode);
    assert.equal(calls().length, mode === 'error' ? 1 : 2, mode);
  }
});

test('only one model call runs at a time', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await settle();
  assert.equal(calls().length, 1);
});

test('with questions still queued, waits for three new edits before asking again', async () => {
  const { engine, calls } = setup();
  const edit = (index) => ({ path: `f${index}.ts`, diff: `+ ${index}` });
  let batchArrived = finalBatch(engine);
  engine.update(makeRun({ edits: [edit(0)] }), { queuedQuestions: 0 });
  await batchArrived;

  engine.update(makeRun({ edits: [edit(0), edit(1)] }), { queuedQuestions: 2 });
  engine.update(makeRun({ edits: [edit(0), edit(1), edit(2)] }), { queuedQuestions: 2 });
  await settle();
  assert.equal(calls().length, 1);

  batchArrived = finalBatch(engine);
  engine.update(makeRun({ edits: [edit(0), edit(1), edit(2), edit(3)] }), { queuedQuestions: 2 });
  await batchArrived;
  assert.equal(calls().length, 2);
});

test('when the queue runs dry, asks for more without repeating earlier questions', async () => {
  const { engine, calls } = setup();
  let batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;

  batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.match(calls()[1].stdin, /Why retry refreshToken\?/, 'earlier questions are listed so they are not repeated');
});

test('does not keep asking when nothing changed and the model had no questions', async () => {
  const { engine, calls } = setup('no-questions');
  const batchArrived = finalBatch(engine);
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
  let batchArrived = finalBatch(engine);
  engine.update(makeRun({ edits: [] }), { queuedQuestions: 0 });
  await batchArrived;

  batchArrived = finalBatch(engine);
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

test('after Claude finishes, keeps writing questions only if the user chose to keep going', async () => {
  const { engine, calls } = setup();
  engine.update(makeRun({ finished: true }), { queuedQuestions: 0 });
  await settle();
  assert.equal(calls().length, 0);

  const batchArrived = finalBatch(engine);
  engine.update(makeRun({ finished: true }), { queuedQuestions: 0, keepGoing: true });
  await batchArrived;
  assert.equal(calls().length, 1);
});

const question = { q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races'], answer: 1, why: 'Concurrent requests race.' };

test('answers a follow-up in plain text, with the change, the question and the thread as context', async () => {
  const { engine, calls } = setup();
  const answer = await engine.askFollowUp(makeRun(), {
    question,
    chosen: 0,
    ask: 'why not refresh early?',
    thread: [{ ask: 'is 3 attempts enough?', answer: 'Usually.' }],
  });
  assert.equal(answer, 'Because a request can still race the expiry window.');
  const [call] = calls();
  assert.match(call.argv[call.argv.indexOf('--system-prompt') + 1], /follow-up/i);
  assert.match(call.stdin, /why not refresh early\?/);
  assert.match(call.stdin, /Why retry refreshToken\?/);
  assert.match(call.stdin, /Token expiry races/, 'the right answer is given');
  assert.match(call.stdin, /Rate limits/, 'and what the user picked');
  assert.match(call.stdin, /is 3 attempts enough\?[\s\S]*Usually\./, 'earlier follow-ups are included');
  assert.match(call.stdin, /\+ return withRetry\(fetchToken\);/, 'the diff is included');
});

test('a follow-up does not wait behind, or block, question generation', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  const answer = await engine.askFollowUp(makeRun(), { question, chosen: 1, ask: 'why?', thread: [] });
  await batchArrived;
  assert.ok(answer);
  assert.equal(calls().length, 2);
});

test('a failed follow-up resolves to null', async () => {
  const { engine } = setup('error');
  assert.equal(await engine.askFollowUp(makeRun(), { question, chosen: 1, ask: 'why?', thread: [] }), null);
});

test('options arrive shuffled, with the answer still pointing at the right one', async () => {
  const { engine } = setup('fenced', { random: () => 0 });
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  const { questions } = await batchArrived;
  assert.notDeepEqual(questions[0].options, ['Rate limits', 'Token expiry races', 'Caching']);
  assert.equal(questions[0].options[questions[0].answer], 'Token expiry races');
});

test('uses the configured model, kinds and batch size', async () => {
  const { engine, calls } = setup('fenced', { model: 'sonnet', kinds: ['why', 'bug'], questionsPerBatch: 2 });
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  const [call] = calls();
  assert.equal(call.argv[call.argv.indexOf('--model') + 1], 'sonnet');
  assert.match(call.stdin, /1-2 questions/);
  assert.match(call.stdin, /"bug"/);
  assert.doesNotMatch(call.stdin, /"predict"/);
});

test('asks for harder questions when the developer keeps getting them right', async () => {
  const { engine, calls } = setup('fenced', { accuracy: () => ({ answered: 12, correct: 11 }) });
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.match(calls()[0].stdin, /harder/);
});

test('question calls run in an empty folder, so the project\'s CLAUDE.md and the agent\'s memory stay out', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await engine.askFollowUp(makeRun(), { question, chosen: 0, ask: 'why?', thread: [] });
  for (const call of calls()) {
    assert.notEqual(call.cwd, process.cwd());
    assert.deepEqual(readdirSync(call.cwd).filter((name) => name !== '.claude'), [], 'nothing in it to discover');
    assert.ok(readdirSync(join(call.cwd, '.claude')).every((name) => /^settings(\.local)?\.json$/.test(name)), 'only settings');
  }
  assert.equal(calls().length, 2);
});

test('the project brief goes into question and follow-up prompts once it is ready', async () => {
  let brief = null;
  const { engine, calls } = setup('fenced', { brief: () => brief });
  let batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.doesNotMatch(calls()[0].stdin, /<project>/, 'not ready yet: asked without it');

  brief = 'A retry library for token refresh.';
  batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.match(calls()[1].stdin, /<project>\nA retry library for token refresh\.\n<\/project>/);
  await engine.askFollowUp(makeRun(), { question, chosen: 0, ask: 'why?', thread: [] });
  assert.match(calls()[2].stdin, /A retry library for token refresh\./);
});

test('before any edit, questions are about the plan and say which prompt they are about', async () => {
  const { engine, calls } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun({ edits: [], reads: [] }), { queuedQuestions: 0 });
  const { questions } = await batchArrived;
  assert.match(calls()[0].stdin, /plan for the request/);
  assert.deepEqual(questions.map((question) => question.plan), ['add retry to token refresh', 'add retry to token refresh']);
  assert.ok(questions.every((question) => !question.anchor));
});

test('a question with nowhere it comes from (no file, no prompt) is dropped', async () => {
  const { engine } = setup();
  let batches = 0;
  engine.on('batch', (batch) => (batches += batch.questions.length));
  const batchArrived = finalBatch(engine);
  engine.update(makeRun({ prompt: '', edits: [], reads: ['src/auth.ts'] }), { queuedQuestions: 0 });
  await batchArrived;
  assert.equal(batches, 0);
});

test('questions over two lines or with long options are dropped', async () => {
  const { engine } = setup('long-question');
  const { questions } = await (async () => {
    const batchArrived = finalBatch(engine);
    engine.update(makeRun(), { queuedQuestions: 0 });
    return batchArrived;
  })();
  assert.deepEqual(questions.map((question) => question.q), ['How many attempts?']);
});

test('the first question shows as soon as it is written, before the rest of the reply', async () => {
  const { engine } = setup('fenced', {}, { FAKE_HAIKU_STREAM_DELAY_MS: '1500' });
  const startedAt = Date.now();
  const first = new Promise((resolve) => engine.once('batch', (batch) => resolve({ batch, at: Date.now() })));
  const whole = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  const { batch, at } = await first;
  assert.deepEqual(batch.questions.map((question) => question.q), ['Why retry refreshToken?']);
  assert.equal(batch.summary, '', 'the summary comes at the end');
  assert.ok(at - startedAt < 1200, `first question after ${at - startedAt}ms`);
  const rest = await whole;
  assert.deepEqual(rest.questions.map((question) => question.q), ['Why retry refreshToken?', 'How many attempts?'], 'each question once');
  assert.equal(rest.summary, 'Claude is wrapping refreshToken() in a retry helper.');
});

test('after a batch the next call is started and waiting; the next batch uses it', async () => {
  const { engine, calls, spawns } = setup();
  let batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await until(() => spawns().length === 2);
  assert.ok(engine.isWarm());

  batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  assert.equal(calls().length, 2);
  assert.equal(calls()[1].pid, spawns()[1].pid, 'the second call went to the waiting process');
  engine.close();
});

test('a warm call that is never needed is closed without sending a prompt', async () => {
  const { engine, calls, spawns } = setup();
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await until(() => spawns().length === 2);
  engine.idle(); // the run ended
  assert.equal(engine.isWarm(), false);
  await settle();
  assert.equal(calls().length, 1, 'the warm process never got a prompt');
});

test('a warm call left waiting too long is closed', async () => {
  const { engine, spawns } = setup('fenced', { warmIdleMs: 200 });
  const batchArrived = finalBatch(engine);
  engine.update(makeRun(), { queuedQuestions: 0 });
  await batchArrived;
  await until(() => spawns().length === 2);
  await until(() => !engine.isWarm());
});

test('a lesson after a miss explains the idea with the question and its code', async () => {
  const { engine, calls } = setup();
  const answer = await engine.askFollowUp(makeRun(), { question, chosen: 0, ask: LESSON_ASK, thread: [] });
  assert.equal(answer, 'A race happens when two requests refresh at once; here withRetry absorbs it.');
  const [call] = calls();
  assert.match(call.argv[call.argv.indexOf('--system-prompt') + 1], /lesson/i);
  assert.match(call.stdin, /Why retry refreshToken\?/);
});

async function until(predicate) {
  for (let waited = 0; waited < 5000; waited += 25) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting');
}

test('the project\'s Claude settings files go along (they can hold the login), and nothing else does', () => {
  const project = mkdtempSync(join(tmpdir(), 'hf-project-'));
  mkdirSync(join(project, '.claude'));
  writeFileSync(join(project, '.claude', 'settings.local.json'), '{"apiKeyHelper": "./key.sh"}');
  writeFileSync(join(project, '.claude', 'notes.md'), 'not for the writer');
  writeFileSync(join(project, 'CLAUDE.md'), 'project notes');
  const folder = mkdtempSync(join(tmpdir(), 'hf-writer-test-'));
  copyProjectSettings(project, folder);
  assert.deepEqual(readdirSync(folder), ['.claude']);
  assert.deepEqual(readdirSync(join(folder, '.claude')), ['settings.local.json']);
});

test('--doctor\'s probe says why there was no reply', async () => {
  const { probeQuestionWriter } = await import('../src/quiz-engine.js');
  const missing = await probeQuestionWriter({ claudePath: '/nonexistent/claude-binary', timeoutMs: 5000 });
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /ENOENT|nonexistent/);
});
