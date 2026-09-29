import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFocusView } from '../src/focus-view.js';

const stripAnsi = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const screenText = (rendered) => stripAnsi(rendered).split('\r\n').join('\n');

const retryQuestion = {
  q: 'Why retry refreshToken?',
  options: ['Rate limits', 'Token expiry races', 'Caching'],
  answer: 1,
  why: 'Concurrent requests can race on an expired token.',
};
const attemptsQuestion = { q: 'How many attempts?', options: ['1', '3'], answer: 1, why: 'attempts: 3' };
const finished = { reason: 'done', changedFiles: ['src/auth.ts', 'src/retry.ts'], score: { answered: 1, correct: 1 } };

function setup() {
  const calls = { answers: [], followUps: [], back: 0, keepGoing: 0 };
  const view = createFocusView({
    onAnswer: (entry) => calls.answers.push(entry),
    onFollowUp: (request) => calls.followUps.push(request),
    onBack: () => calls.back++,
    onKeepGoing: () => calls.keepGoing++,
  });
  const text = () => screenText(view.render({ cols: 80, rows: 40, now: 0 }));
  const type = (keys) => [...keys].forEach((key) => view.handleKey(key));
  return { view, calls, text, type };
}

test('when Claude finishes mid-question, the question stays and the user chooses', () => {
  const { view, text } = setup();
  view.addQuestions([retryQuestion]);
  view.showFinished(finished);
  const screen = text();
  assert.match(screen, /Claude finished · 2 files changed/);
  assert.match(screen, /Enter\s+back to Claude/);
  assert.match(screen, /c\s+keep going/);
  assert.match(screen, /Why retry refreshToken\?/, 'the question is still there');
});

test('Enter goes back to Claude', () => {
  const { view, calls } = setup();
  view.addQuestions([retryQuestion]);
  view.showFinished(finished);
  view.handleKey('\r');
  assert.equal(calls.back, 1);
  assert.deepEqual(calls.answers, [], 'nothing was scored');
});

test('c keeps going: the banner goes and the quiz carries on', () => {
  const { view, calls, text } = setup();
  view.addQuestions([retryQuestion]);
  view.showFinished(finished);
  view.handleKey('c');
  assert.equal(calls.keepGoing, 1);
  assert.doesNotMatch(text(), /keep going/);
  assert.match(text(), /1-3 to answer/);
});

test('answering straight away also means keep going', () => {
  const { view, calls, text } = setup();
  view.addQuestions([retryQuestion]);
  view.showFinished(finished);
  view.handleKey('2');
  assert.equal(calls.keepGoing, 1);
  assert.equal(calls.answers[0].correct, true);
  assert.match(text(), /✔ Correct/);
  assert.doesNotMatch(text(), /Enter\s+back to Claude/);
});

test('the banner says when Claude is waiting for input rather than finished', () => {
  const { view, text } = setup();
  view.addQuestions([retryQuestion]);
  view.showFinished({ ...finished, reason: 'needs-input' });
  assert.match(text(), /Claude needs your input/);
});

test('isAtQuestion tells whether there is a question on screen', () => {
  const { view } = setup();
  assert.equal(view.isAtQuestion, false);
  view.addQuestions([retryQuestion]);
  assert.equal(view.isAtQuestion, true);
});

test('after an answer, f lets the user ask their own follow-up', () => {
  const { view, calls, text, type } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  assert.match(text(), /f\s+ask a follow-up/);
  view.handleKey('f');
  type('why not refresh early?');
  assert.match(text(), /> why not refresh early\?/);
  view.handleKey('\r');
  assert.deepEqual(calls.followUps, [{ question: retryQuestion, chosen: 0, ask: 'why not refresh early?', thread: [] }]);
  assert.match(text(), /Thinking/);

  view.setFollowUpAnswer('A request can still race the expiry window, so retrying covers it.');
  assert.match(text(), /why not refresh early\?/);
  assert.match(text(), /A request can still race the expiry window/);
});

test('follow-ups can continue, carrying the thread so far', () => {
  const { view, calls, type } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('2');
  view.handleKey('f');
  type('first?\r');
  view.setFollowUpAnswer('First answer.');
  view.handleKey('f');
  type('second?\r');
  assert.deepEqual(calls.followUps[1].thread, [{ ask: 'first?', answer: 'First answer.' }]);
});

test('any other key after a follow-up moves on to the next question', () => {
  const { view, text, type } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('2');
  view.handleKey('f');
  type('why?\r');
  view.setFollowUpAnswer('Because.');
  view.handleKey('x');
  assert.match(text(), /How many attempts\?/);
});

test('typing a follow-up supports backspace, and Esc (plain or kitty-encoded) cancels it', () => {
  for (const esc of ['\x1b', '\x1b[27u']) {
    const { view, calls, text, type } = setup();
    view.addQuestions([retryQuestion]);
    view.handleKey('1');
    view.handleKey('f');
    type('whyy');
    view.handleKey('\x7f');
    assert.match(text(), /> why(?!y)/);
    view.handleKey(esc);
    assert.doesNotMatch(text(), /> why/);
    assert.match(text(), /f\s+ask a follow-up/);
    assert.deepEqual(calls.followUps, []);
  }
});

test('kitty-encoded Enter submits the follow-up', () => {
  const { view, calls, type } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  view.handleKey('f');
  type('why?');
  view.handleKey('\x1b[13u');
  assert.equal(calls.followUps.length, 1);
});

test('keys typed into a follow-up are text, not quiz commands', () => {
  const { view, calls, type } = setup();
  view.addQuestions([retryQuestion, attemptsQuestion]);
  view.handleKey('1');
  view.handleKey('f');
  type('s 2 f');
  view.handleKey('\r');
  assert.equal(calls.followUps[0].ask, 's 2 f');
  assert.equal(calls.answers.length, 1, 'no skip or answer happened');
});

test('an empty follow-up is not sent', () => {
  const { view, calls } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  view.handleKey('f');
  view.handleKey('\r');
  assert.deepEqual(calls.followUps, []);
});

test('a failed follow-up says so and lets the user try again', () => {
  const { view, text, type } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('1');
  view.handleKey('f');
  type('why?\r');
  view.setFollowUpFailed();
  assert.match(text(), /Couldn't get an answer/);
  assert.match(text(), /f\s+ask a follow-up/);
});

test('f before answering does nothing special', () => {
  const { view, calls, text } = setup();
  view.addQuestions([retryQuestion]);
  view.handleKey('f');
  assert.match(text(), /1-3 to answer/);
  assert.deepEqual(calls.followUps, []);
});
