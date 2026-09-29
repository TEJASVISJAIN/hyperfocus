import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const lines = (rendered) => stripAnsi(rendered).split('\r\n');
const screenText = (rendered) => lines(rendered).join('\n');

const retryQuestion = {
  q: 'Why retry refreshToken?',
  options: ['Rate limits', 'Token expiry races', 'Caching'],
  answer: 1,
  why: 'Concurrent requests can race on an expired token.',
};
const attemptsQuestion = { q: 'How many attempts?', options: ['1', '3'], answer: 1, why: 'attempts: 3' };

function setup() {
  const answers = [];
  const view = createFocusView({ onAnswer: (entry) => answers.push(entry) });
  const render = (cols = 80, rows = 30) => view.render({ cols, rows, now: 74_000 });
  return { view, answers, render };
}

test('the status line shows what the agent is doing and for how long', () => {
  const { view, render } = setup();
  view.setActivity('editing src/auth.ts', 0);
  const [statusLine] = lines(render());
  assert.match(statusLine, /editing src\/auth\.ts/);
  assert.match(statusLine, /1:14/);
  assert.match(statusLine, /Esc back to Claude/);
});

test('while the first questions are being written, says so and shows the summary', () => {
  const { view, render } = setup();
  assert.match(screenText(render()), /Thinking of a question/);
  view.setSummary('Claude is wrapping refreshToken() in a retry helper.');
  assert.match(screenText(render()), /Claude is wrapping refreshToken\(\) in a retry helper\./);
});

test('a question shows numbered options and how to answer', () => {
  const { view, render } = setup();
  view.addQuestions([retryQuestion]);
  const text = screenText(render());
  assert.match(text, /Why retry refreshToken\?/);
  assert.match(text, /1\) Rate limits/);
  assert.match(text, /2\) Token expiry races/);
  assert.match(text, /3\) Caching/);
  assert.match(text, /1-3 to answer/);
});

test('a right answer is confirmed with the explanation', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('2');
  const text = screenText(render());
  assert.match(text, /✔/);
  assert.match(text, /Concurrent requests can race on an expired token\./);
  assert.deepEqual(answers, [{ question: retryQuestion, chosen: 1, correct: true, skipped: false }]);
});

test('a wrong answer shows the right one', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  const text = screenText(render());
  assert.match(text, /✘/);
  assert.match(text, /2\) Token expiry races/);
  assert.equal(answers[0].correct, false);
});

test('any key after the explanation moves on and the score keeps count', () => {
  const { view, render } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('2');
  view.handleKey('x');
  const text = screenText(render());
  assert.match(text, /How many attempts\?/);
  assert.match(text, /score 1\/1/);
  assert.equal(view.queuedQuestions, 1);
});

test('s skips a question', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('s');
  assert.match(screenText(render()), /How many attempts\?/);
  assert.deepEqual(answers, [{ question: retryQuestion, chosen: null, correct: null, skipped: true }]);
});

test('keys that are not an option are ignored', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('9');
  view.handleKey('\r');
  assert.deepEqual(answers, []);
  assert.match(screenText(render()), /1-3 to answer/);
});

test('long text wraps to the terminal width and never overflows it', () => {
  const { view, render } = setup();
  view.setActivity('editing ' + 'deeply/nested/'.repeat(10) + 'file.ts', 0);
  view.setSummary('word '.repeat(80));
  view.addQuestions([{ ...retryQuestion, q: 'Why '.repeat(50) + 'supercalifragilisticexpialidocious'.repeat(4) + '?' }]);
  for (const cols of [40, 60, 120]) {
    for (const line of lines(render(cols))) {
      assert.ok([...line].length <= cols, `${cols} cols: "${line}" is ${[...line].length} wide`);
    }
  }
  assert.ok(lines(render(60)).filter((line) => line.includes('word')).length > 1, 'summary wraps onto several lines');
});

test('never draws more rows than the terminal has', () => {
  const { view, render } = setup();
  view.setSummary('word '.repeat(200));
  view.addQuestions([retryQuestion]);
  assert.ok(lines(render(60, 12)).length <= 12);
});

test('a new run keeps the question the user had not answered yet, and resets the rest', () => {
  const { view, render } = setup();
  view.setSummary('old summary');
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.newRun(0);
  const text = screenText(render());
  assert.match(text, /Why retry refreshToken\?/);
  assert.doesNotMatch(text, /old summary/);
  assert.equal(view.queuedQuestions, 1);
});

test('the explanation stays under the number of the question it explains', () => {
  const { view, render } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('1');
  assert.match(screenText(render()), /Question 1 · score 0\/1/);
  view.handleKey('x');
  assert.match(screenText(render()), /Question 2 · score 0\/1/);
});

test('a trimmed summary still leaves a gap before the question', () => {
  const { view, render } = setup();
  view.setSummary('word '.repeat(200));
  view.addQuestions([retryQuestion]);
  const rendered = lines(render(60, 16));
  const questionHeading = rendered.findIndex((line) => line.startsWith('Question 1'));
  assert.equal(rendered[questionHeading - 1], '');
});
