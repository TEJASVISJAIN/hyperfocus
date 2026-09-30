import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AGENTS } from '../src/agents/index.js';
import { SAMPLES } from './fixtures/agent-samples.js';

// Every agent must look the same to the rest of hyperfocus: the same events from its hooks, a launch
// that reports to the socket, and a question writer whose reply can be read.
for (const [id, agent] of Object.entries(AGENTS)) {
  const samples = SAMPLES[id];

  test(`${id}: has samples to be checked against`, () => {
    assert.ok(samples, `add ${id} to test/fixtures/agent-samples.js`);
    assert.equal(agent.id, id);
    assert.ok(agent.name);
  });

  test(`${id}: hook payloads become the same events`, () => {
    assert.deepEqual(agent.toEvent(samples.prompt), { type: 'busy', sessionId: 's', prompt: 'add retry' });
    assert.equal(agent.toEvent(samples.read)?.type, 'read');
    const edit = agent.toEvent(samples.edit);
    assert.equal(edit?.type, 'edit');
    assert.equal(edit.path, '/repo/src/auth.ts');
    assert.ok(edit.changes.some((change) => change.after.includes('withRetry(fetchToken)')), JSON.stringify(edit.changes));
    assert.deepEqual(agent.toEvent(samples.command), { type: 'command', sessionId: 's', command: 'npm test' });
    assert.deepEqual(agent.toEvent(samples.stop), { type: 'done', sessionId: 's' });
    assert.equal(agent.toEvent(samples.needsInput)?.type, 'needs-input');
    assert.equal(agent.toEvent({ hook_event_name: 'SomethingElse', session_id: 's' }) ?? null, null);
  });

  test(`${id}: a launch reports to the socket and cleans up after itself`, () => {
    const launch = agent.prepareLaunch({ socketPath: '/tmp/focus.sock', env: {} });
    assert.equal(launch.env.HYPERFOCUS_SOCK, '/tmp/focus.sock');
    assert.ok(Array.isArray(launch.args));
    launch.cleanup();
  });

  test(`${id}: the question writer gets the system prompt, and its reply can be read`, () => {
    assert.ok(agent.writer.args('SYSTEM PROMPT', agent.writer.defaultModel).some((arg) => arg.includes('SYSTEM PROMPT')));
    assert.equal(agent.writer.parse(samples.writerOutput)?.text, '{"summary": "s", "questions": []}');
    assert.equal(agent.writer.parse('not json at all'), null);
  });
}
