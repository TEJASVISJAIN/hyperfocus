import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createAutoSwitch, isInterruptKey } from '../src/auto-switch.js';

beforeEach(() => mock.timers.enable({ apis: ['setTimeout', 'Date'] }));
afterEach(() => mock.timers.reset());

// A stand-in screen that records what the policy asked for.
function setup(options = {}) {
  const calls = [];
  let view = 'claude';
  const policy = createAutoSwitch({
    delayMs: 8000,
    typingGraceMs: 2000,
    currentView: () => view,
    openFocus: () => {
      calls.push('open focus');
      view = 'focus';
    },
    returnToClaude: (reason) => {
      calls.push(`return: ${reason}`);
      view = 'claude';
    },
    switchOn: 'busy',
    ...options,
  });
  return { policy, calls, setView: (next) => (view = next) };
}

const busy = { type: 'busy', sessionId: 's', prompt: 'do things' };
const done = { type: 'done', sessionId: 's' };
const needsInput = { type: 'needs-input', sessionId: 's', message: 'Claude needs your permission to use Bash' };

test('opens the focus view once the agent has been busy for the delay', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(7999);
  assert.deepEqual(calls, []);
  mock.timers.tick(1);
  assert.deepEqual(calls, ['open focus']);
});

test('a quick reply never interrupts', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(3000);
  policy.agentEvent(done);
  mock.timers.tick(60_000);
  assert.deepEqual(calls, []);
});

test('returns to claude when the agent finishes', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  policy.agentEvent(done);
  assert.deepEqual(calls, ['open focus', 'return: done']);
});

test('returns to claude when the agent needs input, even if the user opened focus by hand', () => {
  const { policy, calls, setView } = setup();
  policy.agentEvent(busy);
  setView('focus');
  policy.manualToggle('focus');
  policy.agentEvent(needsInput);
  assert.deepEqual(calls, ['return: needs-input']);
});

test('waits until the user has stopped typing for the grace period', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(7000);
  policy.userTyped();
  mock.timers.tick(1000); // delay reached, but typed 1s ago
  assert.deepEqual(calls, []);
  mock.timers.tick(999);
  assert.deepEqual(calls, []);
  mock.timers.tick(1);
  assert.deepEqual(calls, ['open focus']);
});

test('going back to claude by hand keeps focus away until the next prompt', () => {
  const { policy, calls, setView } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  setView('claude');
  policy.manualToggle('claude');
  mock.timers.tick(60_000);
  assert.deepEqual(calls, ['open focus']);

  policy.agentEvent(done);
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  assert.deepEqual(calls, ['open focus', 'open focus']);
});

test('an idle reminder while nothing is running does not switch anything', () => {
  const { policy, calls } = setup();
  policy.agentEvent({ type: 'needs-input', sessionId: 's', message: 'Claude is waiting for your input' });
  assert.deepEqual(calls, []);
});

test('with auto switching off, focus only opens by hand but still hands back control', () => {
  const { policy, calls, setView } = setup({ auto: false });
  policy.agentEvent(busy);
  mock.timers.tick(60_000);
  assert.deepEqual(calls, []);
  setView('focus');
  policy.agentEvent(done);
  assert.deepEqual(calls, ['return: done']);
});

test('after the user answers a permission prompt, tool activity counts as busy again', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  policy.agentEvent(needsInput);
  policy.agentEvent({ type: 'command', sessionId: 's', command: 'npm test' });
  mock.timers.tick(8000);
  assert.deepEqual(calls, ['open focus', 'return: needs-input', 'open focus']);
});

test('tool activity while already busy does not push the deadline back', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  policy.agentEvent({ type: 'read', sessionId: 's', target: 'a' });
  mock.timers.tick(4000);
  policy.agentEvent({ type: 'read', sessionId: 's', target: 'b' });
  mock.timers.tick(4000);
  assert.deepEqual(calls, ['open focus'], 'activity while already busy must not push the deadline back');
});

test('interrupting Claude (Esc / Ctrl-C) counts as the agent stopping, since no Stop hook fires', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(3000);
  policy.userInterrupted();
  mock.timers.tick(60_000);
  assert.deepEqual(calls, []);
});

test('interrupt keys are recognised in every encoding Claude Code may turn on', () => {
  for (const key of ['\x1b', '\x03', '\x1b[27u', '\x1b[99;5u', '\x1b[27;5;99~']) assert.equal(isInterruptKey(key), true, JSON.stringify(key));
  for (const key of ['a', '\x1b[A', '\r', '\x1b[I']) assert.equal(isInterruptKey(key), false, JSON.stringify(key));
});

test('a subagent starting after a permission prompt counts as busy again', () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  policy.agentEvent({ type: 'needs-input', sessionId: 's', message: 'allow?' });
  policy.agentEvent({ type: 'subagent', sessionId: 's', description: 'Find callers' });
  mock.timers.tick(8000);
  assert.deepEqual(calls, ['open focus', 'return: needs-input', 'open focus']);
});

test("a subagent finishing after Claude's Stop does not bring the focus view back", () => {
  const { policy, calls } = setup();
  policy.agentEvent(busy);
  mock.timers.tick(8000);
  policy.agentEvent(done);
  policy.agentEvent({ type: 'subagent-done', sessionId: 's' });
  mock.timers.tick(20_000);
  assert.deepEqual(calls, ['open focus', 'return: done']);
});

const edit = { type: 'edit', sessionId: 's', path: 'src/a.ts', changes: [] };
const task = (id) => ({ type: 'task-create', sessionId: 's', id, subject: `step ${id}`, activeForm: `doing ${id}` });

test('by default the quiz waits for the first edit, even after the delay', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent({ type: 'read', sessionId: 's', target: 'a' });
  mock.timers.tick(20_000);
  assert.deepEqual(calls, []);
  policy.agentEvent(edit);
  assert.deepEqual(calls, ['open focus']);
});

test('an edit before the delay still waits for the delay', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent(edit);
  mock.timers.tick(7999);
  assert.deepEqual(calls, []);
  mock.timers.tick(1);
  assert.deepEqual(calls, ['open focus']);
});

test('a plan of two steps is something to quiz on', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent(task('1'));
  mock.timers.tick(8000);
  assert.deepEqual(calls, []);
  policy.agentEvent(task('2'));
  assert.deepEqual(calls, ['open focus']);
});

test('a plan of three or more steps halves the wait', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent({ type: 'todos', sessionId: 's', todos: [1, 2, 3].map((n) => ({ subject: `s${n}`, status: 'pending', activeForm: '' })) });
  mock.timers.tick(3999);
  assert.deepEqual(calls, []);
  mock.timers.tick(1);
  assert.deepEqual(calls, ['open focus']);
});

test('in a project whose runs are usually short, the quiz waits for a second edit', () => {
  const { policy, calls } = setup({ switchOn: 'edit', shortRuns: true });
  policy.agentEvent(busy);
  policy.agentEvent(edit);
  mock.timers.tick(20_000);
  assert.deepEqual(calls, []);
  policy.agentEvent(edit);
  assert.deepEqual(calls, ['open focus']);
});

test('a new prompt starts counting edits and plan steps again', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent(edit);
  policy.agentEvent(done);
  policy.agentEvent(busy);
  mock.timers.tick(20_000);
  assert.deepEqual(calls, []);
});

test('going quiet stops automatic switching for good, but the agent finishing still hands back', () => {
  const { policy, calls, setView } = setup();
  policy.agentEvent(busy);
  policy.goQuiet();
  mock.timers.tick(60_000);
  policy.agentEvent(done);
  policy.agentEvent(busy);
  mock.timers.tick(60_000);
  assert.deepEqual(calls, []);
  setView('focus'); // Ctrl-] still opens it by hand
  policy.agentEvent(done);
  assert.deepEqual(calls, ['return: done']);
});

test('a long run that only reads still opens the quiz after 30 seconds: exploring is a long wait too', () => {
  const { policy, calls } = setup({ switchOn: 'edit' });
  policy.agentEvent(busy);
  policy.agentEvent({ type: 'read', sessionId: 's', target: 'a' });
  mock.timers.tick(29_999);
  assert.deepEqual(calls, []);
  mock.timers.tick(1);
  assert.deepEqual(calls, ['open focus']);
});

test('short-run projects also stop waiting for a second edit after 30 seconds', () => {
  const { policy, calls } = setup({ switchOn: 'edit', shortRuns: true });
  policy.agentEvent(busy);
  policy.agentEvent(edit);
  mock.timers.tick(30_000);
  assert.deepEqual(calls, ['open focus']);
});
