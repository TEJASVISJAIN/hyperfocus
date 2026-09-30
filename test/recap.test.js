import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';
import { buildRecap, reviewChecklist } from '../src/recap.js';

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

test('terminal reports (focus in/out, mouse, bracketed paste markers) are not key presses', () => {
  let dismissed = 0;
  const answers = [];
  const view = createFocusView({ onAnswer: (entry) => answers.push(entry) });
  view.addQuestions([{ q: 'Q?', options: ['a', 'b'], answer: 0, why: 'w' }]);
  view.handleKey('1');
  view.showRecap(buildRecap({ run, summary: 's', score: { answered: 1, correct: 1 }, visibleMs: 20_000, answeredThisVisit: 1 }), () => dismissed++);
  for (const report of ['\x1b[I', '\x1b[O', '\x1b[<0;10;5M', '\x1b[<0;10;5m', '\x1b[M !!', '\x1b[200~', '\x1b[201~']) view.handleKey(report);
  assert.equal(dismissed, 0);
  view.handleKey('x');
  assert.equal(dismissed, 1);
});

const missed = (q, file, anchors) => ({ question: { kind: 'why', q, anchor: { file, anchors } } });
const codeOnDisk = { '/repo/src/retry.ts': 'export async function withRetry(fn, attempts = 3) {\n' };
const readFile = (path) => {
  const key = path.replaceAll('\\', '/'); // keyed with /, joined with the platform separator
  if (!(key in codeOnDisk)) throw new Error('ENOENT');
  return codeOnDisk[key];
};

test('the checklist keeps missed questions whose code is still there, and drops discarded ones', () => {
  const items = reviewChecklist(
    [
      missed('Why three attempts?', 'src/retry.ts', ['export async function withRetry(fn, attempts = 3) {']),
      missed('Why a circuit breaker?', 'src/breaker.ts', ['export class CircuitBreaker extends Base {']),
      missed('Why three attempts?', 'src/retry.ts', ['export async function withRetry(fn, attempts = 3) {']),
      missed('What about the plan?', undefined, []),
    ],
    { cwd: '/repo', readFile },
  );
  assert.deepEqual(items, [{ file: 'src/retry.ts', question: 'Why three attempts?' }]);
});

test('the recap lists what is worth a look before merging', () => {
  const view = createFocusView({ onAnswer: () => {} });
  const checklist = [{ file: 'src/retry.ts', question: 'Why three attempts?' }];
  const recap = buildRecap({ run, summary: 's', score: { answered: 1, correct: 0 }, visibleMs: 1000, answeredThisVisit: 0, checklist });
  assert.ok(recap, 'a checklist is always worth showing');
  view.showRecap(recap, () => {});
  const screen = screenText(view.render({ cols: 80, rows: 40, now: 0 }));
  assert.match(screen, /Worth a look before you merge/);
  assert.match(screen, /src\/retry\.ts\s+Why three attempts\?/);
});
