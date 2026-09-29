import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildQuizPrompt, parseQuizReply, shuffleOptions } from '../src/quiz-prompt.js';

const run = {
  prompt: 'add retry to token refresh',
  startedAt: 1,
  finished: false,
  reads: ['src/auth.ts', 'src/http.ts'],
  edits: [
    {
      path: 'src/retry.ts',
      diff: '+ export async function withRetry(fn, { attempts = 3, backoffMs = 200 } = {}) {\n+   for (let i = 0; i < attempts; i++) {\n+     try { return await fn(); } catch (error) { await sleep(backoffMs); }\n+   }\n+ }',
      anchors: [],
    },
    { path: 'src/auth.ts', diff: '-   return fetchToken();\n+   return withRetry(fetchToken);', anchors: [] },
  ],
  commands: [],
  timeline: [],
};
const reply = (questions) => JSON.stringify({ summary: 'Adding retries.', questions });
const why = { kind: 'why', q: 'Why retry?', options: ['Races', 'Caching', 'Logging'], answer: 0, why: 'Tokens expire mid-flight.' };

test('the prompt asks only for the configured kinds and count', () => {
  const prompt = buildQuizPrompt(run, [], { kinds: ['why', 'bug'], count: 2 });
  assert.match(prompt, /1-2 questions/);
  assert.match(prompt, /"why"/);
  assert.match(prompt, /"bug"/);
  assert.doesNotMatch(prompt, /"predict"/);
  assert.doesNotMatch(prompt, /"output"/);
});

test('prediction questions are only asked for while the agent is still working', () => {
  assert.match(buildQuizPrompt(run, [], { kinds: ['why', 'predict'], count: 3 }), /"predict"/);
  assert.doesNotMatch(buildQuizPrompt({ ...run, finished: true }, [], { kinds: ['why', 'predict'], count: 3 }), /"predict"/);
});

test('difficulty follows how the developer has been doing', () => {
  const doingWell = buildQuizPrompt(run, [], { kinds: ['why'], count: 3, accuracy: { answered: 10, correct: 9 } });
  const struggling = buildQuizPrompt(run, [], { kinds: ['why'], count: 3, accuracy: { answered: 10, correct: 3 } });
  const tooFewToTell = buildQuizPrompt(run, [], { kinds: ['why'], count: 3, accuracy: { answered: 2, correct: 2 } });
  assert.match(doingWell, /harder/);
  assert.match(struggling, /easier/);
  assert.doesNotMatch(tooFewToTell, /harder|easier/);
});

test('questions come back with their kind, and "why" when the model leaves it out', () => {
  const { kind, ...withoutKind } = why;
  const batch = parseQuizReply(reply([withoutKind]), { run, kinds: ['why', 'bug'] });
  assert.equal(batch.questions[0].kind, 'why');
});

test('a question may name the file it is about, if the run touched it', () => {
  const batch = parseQuizReply(reply([{ ...why, file: 'src/retry.ts' }, { ...why, q: 'Other?', file: 'src/made-up.ts' }]), { run, kinds: ['why'] });
  assert.equal(batch.questions[0].file, 'src/retry.ts');
  assert.equal(batch.questions[1].file, undefined);
});

test('a code excerpt is kept only if it really comes from the diff', () => {
  const real = { ...why, code: '  for (let i = 0; i < attempts; i++) {\n    try { return await fn(); } catch (error) { await sleep(backoffMs); }' };
  const invented = { ...why, q: 'Invented?', code: 'while (true) retry();' };
  const [kept, dropped] = parseQuizReply(reply([real, invented]), { run, kinds: ['why'] }).questions;
  assert.equal(kept.code, 'for (let i = 0; i < attempts; i++) {\n  try { return await fn(); } catch (error) { await sleep(backoffMs); }', 'the common indentation is removed');
  assert.equal(dropped.code, undefined);
});

test('spot-the-bug and output questions need a real excerpt, or they are dropped', () => {
  const bug = { ...why, kind: 'bug', q: 'What is wrong here?', code: 'try { return await fn(); } catch (error) { await sleep(backoffMs); }' };
  const output = { ...why, kind: 'output', q: 'What does it return?' };
  const { questions } = parseQuizReply(reply([bug, output]), { run, kinds: ['why', 'bug', 'output'] });
  assert.deepEqual(questions.map((question) => question.kind), ['bug']);
});

test('kinds the user turned off are dropped', () => {
  const bug = { ...why, kind: 'bug', code: 'return withRetry(fetchToken);' };
  assert.deepEqual(parseQuizReply(reply([bug, why]), { run, kinds: ['why'] }).questions.map((question) => question.kind), ['why']);
});

test('predictions offer files and have no answer until Claude acts', () => {
  const predict = { kind: 'predict', q: 'Which file will the agent edit next?', options: ['src/http.ts', 'src/auth.ts', 'README.md'], answer: 1, why: '' };
  const [question] = parseQuizReply(reply([predict]), { run, kinds: ['predict'] }).questions;
  assert.equal(question.kind, 'predict');
  assert.equal(question.answer, null);
  assert.deepEqual(question.options, ['src/http.ts', 'src/auth.ts', 'README.md']);
});

test('predictions are dropped once the run is over', () => {
  const predict = { kind: 'predict', q: 'Which file next?', options: ['src/http.ts', 'src/auth.ts'], why: '' };
  assert.deepEqual(parseQuizReply(reply([predict]), { run: { ...run, finished: true }, kinds: ['predict'] }).questions, []);
});

test('shuffling moves the options and keeps the answer pointing at the same text', () => {
  const question = { ...why, options: ['Right', 'Wrong 1', 'Wrong 2', 'Wrong 3'], answer: 0 };
  const shuffled = shuffleOptions(question, () => 0); // always pick the first remaining slot
  assert.notDeepEqual(shuffled.options, question.options);
  assert.equal(shuffled.options[shuffled.answer], 'Right');
  assert.deepEqual([...shuffled.options].sort(), [...question.options].sort());
  assert.deepEqual(question.options, ['Right', 'Wrong 1', 'Wrong 2', 'Wrong 3'], 'the original is untouched');
});

test('shuffling a prediction keeps it unanswered', () => {
  const shuffled = shuffleOptions({ kind: 'predict', q: 'Next?', options: ['a', 'b', 'c'], answer: null, why: '' }, () => 0);
  assert.equal(shuffled.answer, null);
});

test('with only predictions allowed and the run over, "why" questions are asked for and accepted', () => {
  const finished = { ...run, finished: true };
  assert.match(buildQuizPrompt(finished, [], { kinds: ['predict'], count: 3 }), /"why"/);
  assert.equal(parseQuizReply(reply([why]), { run: finished, kinds: ['predict'] }).questions.length, 1);
});
