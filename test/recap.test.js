import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';
import { buildRecap } from '../src/recap.js';

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const screenText = (rendered) => stripAnsi(rendered).split('\r\n').join('\n');

const run = {
  prompt: 'add retry to token refresh',
  startedAt: 0,
  finished: true,
  reads: ['src/auth.ts'],
  edits: [
    { path: 'src/auth.ts', diff: '+ a' },
    { path: 'src/retry.ts', diff: '+ b' },
    { path: 'src/auth.ts', diff: '+ c' },
  ],
  commands: ['npm test'],
};

test('no recap after a brief look with nothing answered', () => {
  assert.equal(buildRecap({ run, summary: 's', score: { answered: 0, correct: 0 }, visibleMs: 5000, answeredThisVisit: 0 }), null);
});

test('a recap after 15 seconds away, or after answering anything', () => {
  assert.ok(buildRecap({ run, summary: 's', score: { answered: 0, correct: 0 }, visibleMs: 15_000, answeredThisVisit: 0 }));
  assert.ok(buildRecap({ run, summary: 's', score: { answered: 1, correct: 1 }, visibleMs: 3000, answeredThisVisit: 1 }));
});

test('the recap lists each changed file once, the gist and the score', () => {
  const recap = buildRecap({
    run,
    summary: 'Claude wrapped refreshToken() in a retry helper.',
    score: { answered: 3, correct: 2 },
    visibleMs: 20_000,
    answeredThisVisit: 3,
    reason: 'done',
  });
  const view = createFocusView({ onAnswer: () => {} });
  view.showRecap(recap, () => {});
  const text = screenText(view.render({ cols: 80, rows: 30 }));
  assert.match(text, /While you were away/);
  assert.match(text, /2 files changed/);
  assert.match(text, /src\/auth\.ts/);
  assert.match(text, /src\/retry\.ts/);
  assert.equal(text.match(/src\/auth\.ts/g).length, 1);
  assert.match(text, /Claude wrapped refreshToken\(\) in a retry helper\./);
  assert.match(text, /2\/3 correct/);
  assert.match(text, /Claude finished/);
});

test('without a summary yet, the recap still says what changed', () => {
  const recap = buildRecap({ run, summary: '', score: { answered: 0, correct: 0 }, visibleMs: 20_000, answeredThisVisit: 0, reason: 'needs-input' });
  const view = createFocusView({ onAnswer: () => {} });
  view.showRecap(recap, () => {});
  const text = screenText(view.render({ cols: 80, rows: 30 }));
  assert.match(text, /2 files changed/);
  assert.match(text, /Claude needs your input/);
});

test('any key dismisses the recap and is not taken as an answer', () => {
  const answers = [];
  let dismissed = 0;
  const view = createFocusView({ onAnswer: (entry) => answers.push(entry) });
  view.addQuestions([{ q: 'Q?', options: ['a', 'b'], answer: 0, why: 'w' }]);
  view.showRecap(buildRecap({ run, summary: 's', score: { answered: 1, correct: 1 }, visibleMs: 20_000, answeredThisVisit: 1 }), () => dismissed++);
  view.handleKey('1');
  assert.equal(dismissed, 1);
  assert.deepEqual(answers, []);
  assert.match(screenText(view.render({ cols: 80, rows: 30 })), /Q\?/, 'back to the quiz underneath');
});
