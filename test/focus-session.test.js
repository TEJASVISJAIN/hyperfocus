import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { claudeAgent } from '../src/agents/claude.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { createFocusSession } from '../src/focus-session.js';

const fakeModel = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));
const repeat = (q) => ({ kind: 'why', q, options: ['a', 'b', 'c'], answer: 1, why: 'w', anchor: { file: 'src/retry.ts', anchors: ['export async function withRetry(fn) {'] }, repeat: true });

function session(extra = {}) {
  process.env.FAKE_HAIKU_LOG = join(mkdtempSync(join(tmpdir(), 'hf-session-')), 'calls.jsonl');
  const answers = [];
  const focus = createFocusSession({
    claudePath: fakeModel,
    writer: { path: fakeModel, adapter: claudeAgent.writer, model: 'haiku' },
    config: DEFAULT_CONFIG,
    redraw: () => {},
    onAnswer: (entry) => answers.push(entry),
    ...extra,
  });
  return { focus, answers };
}

async function until(predicate) {
  for (let waited = 0; waited < 5000; waited += 25) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

test('one missed question due again joins each reply\'s new questions, never twice in a session', async () => {
  const due = [repeat('Why back off?'), repeat('Why jitter?')];
  const { focus, answers } = session({ dueRepeats: () => due });
  focus.agentEvent({ type: 'busy', sessionId: 's', prompt: 'add retry to token refresh' });
  await until(() => focus.view.queuedQuestions === 3);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const asked = [];
  for (let index = 0; index < 3; index++) {
    asked.push(focus.snapshot().question?.q);
    focus.act({ type: 'skip' });
  }
  assert.deepEqual(asked, ['Why retry refreshToken?', 'How many attempts?', 'Why back off?']);
  assert.equal(answers.at(-1).question.repeat, true, 'the answer is recorded as a repeat');
  assert.equal(focus.run?.firstQuestionAt !== undefined, true, 'the first question time is kept on the run');
  focus.agentEvent({ type: 'done', sessionId: 's' });
});

test('with no new questions, no repeat is asked instead', async () => {
  process.env.FAKE_HAIKU_MODE = 'no-questions';
  try {
    const { focus } = session({ dueRepeats: () => [repeat('Why back off?')] });
    focus.agentEvent({ type: 'busy', sessionId: 's', prompt: 'add retry' });
    await until(() => focus.view.summary === 'Reading files.');
    assert.equal(focus.view.queuedQuestions, 0);
    focus.agentEvent({ type: 'done', sessionId: 's' });
  } finally {
    delete process.env.FAKE_HAIKU_MODE;
  }
});
