import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';
import { colorAllowed } from '../src/styles.js';

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
  assert.match(text, /▸ 1 {2}Rate limits/, 'the first option starts selected');
  assert.match(text, / {3}2 {2}Token expiry races/);
  assert.match(text, / {3}3 {2}Caching/);
  assert.match(text, /↑↓ choose\s+enter answer\s+s skip/);
  assert.match(text, /╭─ Question 1 ─+╮/, 'in a card');
  assert.match(text, /╰─+╯/);
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
  assert.match(text, /✘ 1 {2}Rate limits/);
  assert.match(text, /✔ 2 {2}Token expiry races/);
  assert.match(text, /the answer is 2/);
  assert.equal(answers[0].correct, false);
});

test('any key after the explanation moves on and the score keeps count', () => {
  const { view, render } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('2');
  view.handleKey('x');
  const text = screenText(render());
  assert.match(text, /How many attempts\?/);
  assert.match(text, /Question 2 ─+ ● 1\/1 ─╮/, 'the score and a dot per answer sit on the card');
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
  for (const key of ['9', '0', 'x', '\x1b[C', '\x1b[D']) view.handleKey(key);
  assert.deepEqual(answers, []);
  assert.match(screenText(render()), /enter answer/);
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
  assert.match(screenText(render()), /Question 1 ─+ ● 0\/1 ─╮/);
  view.handleKey('x');
  assert.match(screenText(render()), /Question 2 ─+ ● 0\/1 ─╮/);
});

test('the summary sits under the card and is trimmed first, keeping its gap and the whole card', () => {
  const { view, render } = setup();
  view.setSummary('word '.repeat(200));
  view.addQuestions([retryQuestion]);
  const rendered = lines(render(60, 17));
  const heading = rendered.findIndex((line) => line.trim() === "What's happening");
  assert.ok(heading > rendered.findIndex((line) => line.includes('╰')), 'below the card');
  assert.equal(rendered[heading - 1], '');
  assert.ok(rendered.some((line) => line.includes('enter answer')), 'the key hints survive');
  assert.equal(rendered.length, 17);
});

test('arrow keys (normal or application mode) and j/k choose, Enter answers the chosen option', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion, retryQuestion]);
  view.handleKey('\x1b[B');
  assert.match(screenText(render()), /▸ 2 {2}Token expiry races/);
  view.handleKey('\x1b[A');
  view.handleKey('\x1b[A');
  assert.match(screenText(render()), /▸ 3 {2}Caching/, 'up from the first wraps to the last');
  view.handleKey('\x1bOB');
  view.handleKey('j');
  view.handleKey('k');
  assert.match(screenText(render()), /▸ 1 {2}Rate limits/);
  view.handleKey('j');
  view.handleKey('\r');
  assert.equal(answers[0].chosen, 1);
  assert.equal(answers[0].correct, true);
  view.handleKey('x');
  assert.match(screenText(render()), /▸ 1 {2}Rate limits/, 'the next question starts at the top again');
});

test('the card shows a dot per answer this run: right, wrong and skipped', () => {
  const { view, render } = setup();
  view.addQuestions([retryQuestion, retryQuestion, retryQuestion, retryQuestion]);
  view.handleKey('2');
  view.handleKey('x');
  view.handleKey('1');
  view.handleKey('x');
  view.handleKey('s');
  const rendered = render();
  assert.match(screenText(rendered), /●●○ 1\/2 ─╮/);
  assert.match(rendered, /\x1b\[32m●.*\x1b\[31m●.*\x1b\[2m○/, 'green, red, then dim');
});

test('the intro card comes before the first question and any key dismisses it', () => {
  const { view, answers, render } = setup();
  let dismissed = 0;
  view.showIntro(() => dismissed++);
  view.addQuestions([retryQuestion]);
  const text = screenText(render());
  assert.match(text, /╭─ Welcome to hyperfocus/);
  assert.match(text, /Esc/);
  assert.match(text, /Ctrl-\]/);
  assert.doesNotMatch(text, /Why retry refreshToken\?/);
  view.handleKey('2');
  assert.equal(dismissed, 1);
  assert.deepEqual(answers, [], 'the key that dismisses the intro answers nothing');
  assert.match(screenText(render()), /Why retry refreshToken\?/);
});

test('z twice asks for no more quizzes this session; anything else in between cancels', () => {
  let quiet = 0;
  const view = createFocusView({ onAnswer: () => {}, onQuiet: () => quiet++, onExit: () => {} });
  assert.match(screenText(view.render({ cols: 100, rows: 30 })), /z\s+quiet for this session/);
  view.handleKey('z');
  assert.match(screenText(view.render({ cols: 100, rows: 30 })), /z\s+again: no more automatic quizzes/);
  view.handleKey('x');
  view.handleKey('z');
  assert.equal(quiet, 0, 'a single stray z does nothing');
  view.handleKey('x');
  view.addQuestions([retryQuestion]);
  view.handleKey('z');
  view.handleKey('z');
  assert.equal(quiet, 1);
  view.handleKey('z');
  view.handleKey('1');
  assert.equal(quiet, 1);
  assert.match(screenText(view.render({ cols: 120, rows: 30 })), /▸ 1/, 'the key that cancels is not an answer');
});

test('b rates the question bad: unscored, reported, and the next question comes up', () => {
  const { view, answers, render } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion, retryQuestion]);
  assert.match(screenText(render(120)), /b\s+bad question/);
  view.handleKey('b');
  assert.deepEqual(answers, [{ question: retryQuestion, chosen: null, correct: null, skipped: true, rating: 'bad' }]);
  assert.match(screenText(render()), /How many attempts\?/);
  view.handleKey('2');
  view.handleKey('b'); // after answering, while the explanation is shown
  assert.equal(answers.length, 3);
  assert.deepEqual(answers[2], { question: attemptsQuestion, chosen: null, correct: null, skipped: true, rating: 'bad' });
  assert.match(screenText(render()), /Why retry refreshToken\?/);
  assert.match(screenText(render()), /○● 1\/1/, 'the bad question shows as skipped');
});

test('without colour, nothing is coloured and right and wrong still look different', () => {
  const answers = [];
  const view = createFocusView({ onAnswer: (entry) => answers.push(entry), color: false });
  view.addQuestions([retryQuestion, retryQuestion, retryQuestion]);
  view.handleKey('2');
  view.handleKey('x');
  view.handleKey('1');
  const rendered = view.render({ cols: 80, rows: 30, now: 74_000 });
  assert.doesNotMatch(rendered, /\x1b\[3[0-9]m/, 'no colour codes');
  assert.match(rendered, /\x1b\[1m/, 'bold is still allowed');
  assert.match(stripAnsi(rendered), /●✗ 1\/2/);
});

test('with animations off, the spinner stands still', () => {
  const view = createFocusView({ onAnswer: () => {}, animations: false });
  view.setActivity('editing a.ts', 0);
  const frames = new Set([0, 1000, 2000, 3000].map((now) => lines(view.render({ cols: 80, rows: 20, now }))[0].slice(0, 4)));
  assert.equal(frames.size, 1);
  assert.match([...frames][0], /·/);
});

test('colour is off with NO_COLOR set (and not empty) or TERM=dumb', () => {
  assert.equal(colorAllowed({}), true);
  assert.equal(colorAllowed({ NO_COLOR: '1' }), false);
  assert.equal(colorAllowed({ NO_COLOR: '' }), true);
  assert.equal(colorAllowed({ TERM: 'dumb' }), false);
});

test('the agent is named on screen, so another agent reads right', () => {
  const view = createFocusView({ onAnswer: () => {}, onExit: () => {}, agentName: 'Codex' });
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  view.showFinished({ reason: 'done', changedFiles: [], score: view.score });
  const text = screenText(view.render({ cols: 100, rows: 30 }));
  assert.match(text, /Esc back to Codex/);
  assert.match(text, /Codex finished/);
  assert.doesNotMatch(text, /Claude/);
});

test('w saves an answered question once, with the answer and how it went, and stays on the explanation', () => {
  const saved = [];
  const view = createFocusView({ onAnswer: () => {}, onSave: (entry) => void saved.push(entry) });
  view.addQuestions([retryQuestion, attemptsQuestion]);
  const render = () => screenText(view.render({ cols: 80, rows: 30, now: 0 }));
  view.handleKey('w'); // nothing answered yet: not saved
  assert.equal(saved.length, 0);
  view.handleKey('1');
  assert.match(render(), /w save/);
  view.handleKey('w');
  view.handleKey('w');
  assert.deepEqual(saved.map(({ question, chosen, correct }) => [question.q, chosen, correct]), [['Why retry refreshToken?', 0, false]]);
  assert.match(render(), /✓ saved/);
  assert.match(render(), /Concurrent requests can race/);
});
