import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';
import { widthOf } from '../src/text-layout.js';

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const lines = (rendered) => stripAnsi(rendered).split('\r\n');
const screenText = (rendered) => lines(rendered).join('\n');

const why = { kind: 'why', q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races', 'Caching'], answer: 1, why: 'Races.' };
const bug = {
  kind: 'bug',
  q: 'What does this retry loop miss?',
  options: ['Jitter between attempts', 'A return value', 'A loop counter'],
  answer: 0,
  why: 'Fixed backoff synchronises clients.',
  code: 'for (let i = 0; i < attempts; i++) {\n  await sleep(200);',
  codeMarks: ['+', '-'],
};
const predict = { kind: 'predict', q: 'Which file will the agent edit next?', options: ['src/http.ts', 'src/auth.ts', 'README.md'], answer: null, why: '' };

function setup(options = {}) {
  const answers = [];
  const view = createFocusView({ onAnswer: (entry) => answers.push(entry), ...options });
  const render = (cols = 80, rows = 40, now = 0) => view.render({ cols, rows, now });
  return { view, answers, render, text: (...args) => screenText(render(...args)) };
}

test('a code excerpt is shown with the question, added and removed lines marked', () => {
  const { view, render } = setup();
  view.addQuestions([bug]);
  const rendered = render();
  const screen = screenText(rendered);
  assert.match(screen, /Question 1 · spot the bug/);
  assert.match(screen, /\+ for \(let i = 0; i < attempts; i\+\+\) \{/);
  assert.match(screen, /- {3}await sleep\(200\);/);
  assert.match(rendered, /\x1b\[32m\+ for/, 'added lines are green');
  assert.match(rendered, /\x1b\[31m- {3}await/, 'removed lines are red');
});

test('a prediction is locked in, and scored when Claude edits a file', () => {
  const { view, answers, text } = setup();
  view.addQuestions([predict, why]);
  assert.match(text(), /Question 1 · predict/);
  view.handleKey('2');
  assert.match(text(), /Locked in: src\/auth\.ts/);
  assert.deepEqual(answers, [], 'not scored until Claude acts');

  view.handleKey('x');
  assert.match(text(), /Why retry refreshToken\?/, 'the quiz carries on meanwhile');
  view.resolvePredictions('src/auth.ts', 0);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].correct, true);
  assert.match(text(), /✔ Prediction right: Claude edited src\/auth\.ts/);
  assert.deepEqual(view.score, { answered: 1, correct: 1 });
});

test('a wrong prediction says what Claude did instead', () => {
  const { view, answers, text } = setup();
  view.addQuestions([predict]);
  view.handleKey('1');
  view.resolvePredictions('src/auth.ts', 0);
  assert.equal(answers[0].correct, false);
  assert.match(text(), /✘ Prediction missed: Claude edited src\/auth\.ts, not src\/http\.ts/);
});

test('an edit outside the options, or the run ending, leaves a prediction unscored', () => {
  const { view, answers, text } = setup();
  view.addQuestions([predict]);
  view.handleKey('1');
  view.resolvePredictions('docs/other.md', 0);
  assert.deepEqual(answers, []);
  assert.match(text(), /Claude edited docs\/other\.md, which wasn't an option/);
  view.addQuestions([{ ...predict, q: 'And next?' }]);
  view.handleKey('x');
  view.handleKey('1');
  view.expirePredictions();
  assert.deepEqual(answers, []);
  assert.deepEqual(view.score, { answered: 0, correct: 0 });
});

test('the prediction result fades after a while', () => {
  const { view, text } = setup();
  view.addQuestions([predict]);
  view.handleKey('1');
  view.resolvePredictions('src/http.ts', 1000);
  assert.match(text(80, 40, 5000), /Prediction right/);
  assert.doesNotMatch(text(80, 40, 20_000), /Prediction right/);
});

test('a streak of right answers is shown', () => {
  const { view, text } = setup();
  view.addQuestions([why, why, why]);
  view.handleKey('2');
  assert.doesNotMatch(text(), /streak/);
  view.handleKey('x');
  view.handleKey('2');
  assert.match(text(), /streak 2/);
  view.handleKey('x');
  view.handleKey('1');
  assert.doesNotMatch(text(), /streak/);
});

test('a spinner shows the agent is still working, and stops when it is done', () => {
  const { view, render } = setup();
  view.setActivity('editing src/auth.ts', 0);
  const frames = new Set([0, 1000, 2000, 3000].map((now) => lines(render(80, 40, now))[0].slice(0, 3)));
  assert.equal(frames.size, 4, 'a different frame every second');
  view.setActivity('done', 0);
  assert.doesNotMatch(lines(render(80, 40, 0))[0], /[◐◓◑◒]/);
});

test("Claude's plan shows as progress under the status line", () => {
  const { view, text } = setup();
  view.setProgress({ done: 2, total: 5, current: 'Writing the retry helper' });
  assert.match(text(), /Plan 2\/5 ▰▰▱▱▱ Writing the retry helper/);
  view.setProgress(null);
  assert.doesNotMatch(text(), /Plan/);
});

test('the live feed lists what the agent just did, newest last', () => {
  const { view, text } = setup({ live: true });
  view.addQuestions([why]);
  view.setFeed([
    { kind: 'read', text: 'src/auth.ts' },
    { kind: 'edit', text: 'src/auth.ts', added: 12, removed: 3 },
    { kind: 'command', text: 'npm test' },
    { kind: 'subagent', text: 'Find callers' },
  ]);
  const screen = text();
  assert.match(screen, /── Live ─+/);
  assert.match(screen, /⌕ src\/auth\.ts\n.*✎ src\/auth\.ts \+12 −3\n.*\$ npm test\n.*◆ Find callers/);
  assert.ok(screen.indexOf('Why retry') < screen.indexOf('Live'), 'below the question');
});

test("the peek shows the last lines of Claude's own screen", () => {
  const { view, text } = setup({ live: true });
  view.addQuestions([why]);
  view.setPeek(['⏺ I will add a retry helper.', '✻ Pondering… (12s)']);
  assert.match(text(), /── Claude ─+\n {2}│ ⏺ I will add a retry helper\.\n {2}│ ✻ Pondering/);
});

test('the live panel is drawn in color, not dimmed out', () => {
  const { view, render } = setup({ live: true });
  view.addQuestions([why]);
  view.setFeed([{ kind: 'edit', text: 'src/auth.ts', added: 12, removed: 3 }]);
  view.setPeek(['⏺ I will add a retry helper.']);
  const rendered = render().split('\r\n');
  const feedRow = rendered.find((line) => line.includes('src/auth.ts'));
  const peekRow = rendered.find((line) => line.includes('retry helper.'));
  assert.match(feedRow, /\x1b\[33m✎/, 'the edit icon is yellow');
  assert.match(feedRow, /\x1b\[32m \+12.*\x1b\[31m −3/, 'added in green, removed in red');
  assert.match(peekRow, /\x1b\[36m│ /, 'the peek has a cyan gutter');
  for (const row of [feedRow, peekRow]) assert.doesNotMatch(row, /\x1b\[2m/, 'no dimmed text');
});

test('on a short terminal the question wins over the feed and the peek', () => {
  const { view, text } = setup({ live: true });
  view.addQuestions([why]);
  view.setFeed([{ kind: 'command', text: 'npm test' }]);
  view.setPeek(['⏺ working']);
  const screen = text(80, 14);
  assert.match(screen, /Why retry refreshToken\?/);
  assert.match(screen, /press 1-3 to answer/);
  assert.doesNotMatch(screen, /Live|working/);
});

test('on a narrow terminal nothing overflows', () => {
  const { view, render } = setup({ live: true });
  view.setActivity('editing src/some/very/long/path/to/a/file.ts', 0);
  view.setProgress({ done: 1, total: 9, current: 'Refactoring the entire authentication layer' });
  view.addQuestions([bug]);
  view.setFeed([{ kind: 'edit', text: 'src/some/very/long/path/to/a/file.ts', added: 100, removed: 200 }]);
  view.setPeek(['⏺ '.padEnd(90, 'x')]);
  for (const line of lines(render(32, 60))) assert.ok(widthOf(line) <= 32, `too wide: "${line}"`);
});

// SGR mouse report for a left click at 1-based column x, row y.
const click = (x, y) => `\x1b[<0;${x};${y}M`;
const rowOf = (screen, pattern) => screen.split('\n').findIndex((line) => pattern.test(line)) + 1;

test('clicking an option answers it', () => {
  const { view, answers, text } = setup();
  view.addQuestions([why, why]);
  const row = rowOf(text(), /2\) Token expiry races/);
  view.handleKey(click(8, row));
  assert.equal(answers[0].chosen, 1);
  assert.equal(answers[0].correct, true);
  view.handleKey(click(8, row));
  assert.match(text(), /✔ Correct/, 'a click is never "any key": focusing the window must not skip the explanation');
});

test('clicks away from the options, releases and the scroll wheel do nothing', () => {
  const { view, answers } = setup();
  view.addQuestions([why]);
  view.handleKey(click(8, 1));
  view.handleKey('\x1b[<0;8;9m');
  view.handleKey('\x1b[<64;8;9M');
  assert.deepEqual(answers, []);
});

test('the title, back hint and empty text can be changed, for review mode', () => {
  const { text } = setup({ title: 'hyperfocus review', backHint: 'q to quit', idleText: 'All caught up.', summaryHeading: 'Review' });
  const screen = text();
  assert.match(screen, /hyperfocus review/);
  assert.match(screen, /q to quit/);
  assert.match(screen, /All caught up\./);
  assert.match(screen, /^Review$/m);
});

test('a line that merely looks like an option (in the peek or the summary) is not clickable', () => {
  const { view, answers, text } = setup();
  view.addQuestions([why]);
  view.setSummary('2) the agent is on step two');
  view.setPeek(['1) Update the retry helper']);
  const screen = text();
  view.handleKey(click(8, rowOf(screen, /^ {2}1\) Update the retry helper/)));
  view.handleKey(click(8, rowOf(screen, /^ {2}2\) the agent/)));
  assert.deepEqual(answers, []);
});

test('once the run is over, prediction questions still waiting in the queue are dropped', () => {
  const { view, answers, text } = setup();
  view.addQuestions([predict, why]);
  view.expirePredictions();
  assert.match(text(), /Why retry refreshToken\?/);
  view.handleKey('2');
  assert.equal(answers.length, 1);
});

test('the live panel is hidden until the user asks for it with l', () => {
  const { view, text } = setup();
  view.addQuestions([why]);
  view.setFeed([{ kind: 'command', text: 'npm test' }]);
  view.setPeek(['⏺ working on it']);
  assert.doesNotMatch(text(), /Live|working on it/);
  assert.match(text(), /l live view/, 'the hint says how to open it');
  view.handleKey('l');
  assert.match(text(), /── Live ─+\n.*\$ npm test/);
  assert.match(text(), /working on it/);
  assert.equal(view.liveShown, true);
  view.handleKey('l');
  assert.doesNotMatch(text(), /Live|working on it/);
});

test('l works while waiting for the first question and after an answer, and is text in a follow-up', () => {
  const { view, answers, text } = setup();
  view.setFeed([{ kind: 'command', text: 'npm test' }]);
  assert.match(text(), /l shows what Claude is doing/);
  view.handleKey('l');
  assert.match(text(), /\$ npm test/);
  view.handleKey('l');
  view.addQuestions([why, why]);
  view.handleKey('2');
  view.handleKey('l');
  assert.match(text(), /✔ Correct/, 'toggling does not move on to the next question');
  assert.match(text(), /\$ npm test/);
  view.handleKey('f');
  view.handleKey('l');
  assert.match(text(), /> l█/);
  assert.equal(answers.length, 1);
});

test('while it is thinking of a question, Enter or Esc go back to Claude, and the screen says so', () => {
  for (const key of ['\r', '\x1b', '\x1b[27u', '\x1b[13u']) {
    let exits = 0;
    const { view, text } = setup({ onExit: () => exits++ });
    assert.match(text(), /Enter or Esc\s+back to Claude/);
    view.handleKey(key);
    assert.equal(exits, 1, JSON.stringify(key));
  }
});

test('Esc goes back to Claude from a question too, without answering or skipping it', () => {
  let exits = 0;
  const { view, answers, text } = setup({ onExit: () => exits++ });
  view.addQuestions([why]);
  assert.match(text(), /Esc back to Claude/);
  view.handleKey('\x1b');
  assert.equal(exits, 1);
  assert.deepEqual(answers, []);
  assert.match(text(), /Why retry refreshToken\?/, 'the question is still there next time');
});

test('Esc in a follow-up cancels the draft instead of leaving', () => {
  let exits = 0;
  const { view, text } = setup({ onExit: () => exits++ });
  view.addQuestions([why]);
  view.handleKey('2');
  view.handleKey('f');
  view.handleKey('\x1b');
  assert.equal(exits, 0);
  assert.match(text(), /f\s+ask a follow-up/);
});

test('other keys while idle do nothing, and without an exit callback (review mode) there is no hint', () => {
  let exits = 0;
  const idle = setup({ onExit: () => exits++ });
  for (const key of 'q x 1s') idle.view.handleKey(key);
  assert.equal(exits, 0, 'stray typing never throws the user out');
  const { view, text } = setup();
  view.handleKey('\r');
  assert.doesNotMatch(text(), /Enter or Esc/);
});

test('every screen names the way out in the status bar', () => {
  let exits = 0;
  const { view, render } = setup({ onExit: () => exits++, onBack: () => {} });
  const statusBar = () => lines(render())[0];
  assert.match(statusBar(), /Esc back to Claude/, 'while thinking');
  view.addQuestions([why, why]);
  assert.match(statusBar(), /Esc back to Claude/, 'at a question');
  view.handleKey('1');
  assert.match(statusBar(), /Esc back to Claude/, 'after an answer');
  view.showFinished({ reason: 'done', changedFiles: [], score: { answered: 1, correct: 0 } });
  assert.match(statusBar(), /Esc back to Claude/, 'when Claude has finished');
  view.handleKey('\x1b');
  assert.equal(exits, 1, 'and Esc works there too');
});
