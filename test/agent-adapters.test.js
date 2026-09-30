import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    // An adapter may turn one payload into several events; each sample here stands for one.
    /** @returns {any} */
    const one = (payload) => [].concat(agent.toEvent(payload) ?? [])[0] ?? null;
    assert.deepEqual(one(samples.prompt), { type: 'busy', sessionId: 's', prompt: 'add retry' });
    if (samples.read) assert.equal(one(samples.read)?.type, 'read');
    const edit = one(samples.edit);
    assert.equal(edit?.type, 'edit');
    assert.equal(edit.path, '/repo/src/auth.ts');
    assert.ok(edit.changes.some((change) => change.after.includes('withRetry(fetchToken)')), JSON.stringify(edit.changes));
    assert.deepEqual(one(samples.command), { type: 'command', sessionId: 's', command: 'npm test' });
    assert.deepEqual(one(samples.stop), { type: 'done', sessionId: 's' });
    assert.equal(one(samples.needsInput)?.type, 'needs-input');
    assert.equal(one({ hook_event_name: 'SomethingElse', session_id: 's' }), null);
  });

  test(`${id}: a launch reports to the socket and cleans up after itself`, () => {
    const home = mkdtempSync(join(tmpdir(), 'focus-agent-'));
    const launch = agent.prepareLaunch({ socketPath: '/tmp/focus.sock', env: { HOME: home, CODEX_HOME: join(home, 'real-codex'), HYPERFOCUS_HOME: join(home, 'focus') }, home: join(home, 'mirror') });
    assert.equal(launch.env.HYPERFOCUS_SOCK, '/tmp/focus.sock');
    assert.ok(Array.isArray(launch.args));
    launch.cleanup();
  });

  test(`${id}: the question writer gets the system prompt, and its reply can be read`, () => {
    const sent = [...agent.writer.args('SYSTEM PROMPT', agent.writer.defaultModel), agent.writer.input?.('SYSTEM PROMPT', 'the prompt') ?? ''];
    assert.ok(sent.some((part) => part.includes('SYSTEM PROMPT')), 'the system prompt reaches the model, as an argument or on stdin');
    assert.equal(agent.writer.parse(samples.writerOutput)?.text, '{"summary": "s", "questions": []}');
    assert.equal(agent.writer.parse('not json at all'), null);
  });
}
