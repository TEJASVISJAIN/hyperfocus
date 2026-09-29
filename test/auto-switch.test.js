import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { createAutoSwitch } from '../src/auto-switch.js';

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
