import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, test } from 'node:test';
import { startEventServer } from '../src/event-server.js';

const hookScript = fileURLToPath(new URL('../bin/hyperfocus-hook.js', import.meta.url));

// Runs the hook exactly the way Claude Code does: payload JSON on stdin, env inherited.
function runHook(payload, env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = execFile(process.execPath, [hookScript], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr, elapsedMs: Date.now() - startedAt }),
    );
    child.stdin.end(JSON.stringify(payload));
  });
}

let server;
beforeEach(async () => {
  server = await startEventServer();
});
afterEach(() => server.close());

async function sendAndReceive(payload) {
  const received = once(server.events, 'event');
  const result = await runHook(payload, { HYPERFOCUS_SOCK: server.socketPath });
  assert.equal(result.code, 0);
  assert.equal(result.stdout, '', 'hooks must never print: Claude would treat stdout as feedback');
  const [event] = await received;
  return event;
}

test('a submitted prompt means the agent is busy', async () => {
  const event = await sendAndReceive({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session-1',
    prompt: 'add retry to token refresh',
  });
  assert.deepEqual(event, { type: 'busy', sessionId: 'session-1', prompt: 'add retry to token refresh' });
});

test('reading tools report what the agent is looking at', async () => {
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/repo/src/auth.ts' } }),
    { type: 'read', sessionId: 's', target: '/repo/src/auth.ts' },
  );
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Grep', tool_input: { pattern: 'refreshToken', path: '/repo/src' } }),
    { type: 'read', sessionId: 's', target: 'grep "refreshToken" in /repo/src' },
  );
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Glob', tool_input: { pattern: '**/*.test.ts' } }),
    { type: 'read', sessionId: 's', target: 'glob **/*.test.ts' },
  );
});

test('edits carry the file and what changed', async () => {
  assert.deepEqual(
    await sendAndReceive({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/auth.ts', old_string: 'return fetchToken();', new_string: 'return withRetry(fetchToken);' },
    }),
    {
      type: 'edit',
      sessionId: 's',
      path: '/repo/src/auth.ts',
      changes: [{ before: 'return fetchToken();', after: 'return withRetry(fetchToken);' }],
    },
  );
  assert.deepEqual(
    await sendAndReceive({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'MultiEdit',
      tool_input: { file_path: '/repo/a.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] },
    }),
    { type: 'edit', sessionId: 's', path: '/repo/a.ts', changes: [{ before: 'a', after: 'b' }, { before: 'c', after: 'd' }] },
  );
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Write', tool_input: { file_path: '/repo/new.ts', content: 'export {}' } }),
    { type: 'edit', sessionId: 's', path: '/repo/new.ts', changes: [{ before: '', after: 'export {}' }] },
  );
});

test('shell commands are reported', async () => {
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } }),
    { type: 'command', sessionId: 's', command: 'npm test' },
  );
});

test('stopping and asking for input hand control back to the user', async () => {
  assert.deepEqual(await sendAndReceive({ hook_event_name: 'Stop', session_id: 's' }), { type: 'done', sessionId: 's' });
  assert.deepEqual(
    await sendAndReceive({ hook_event_name: 'Notification', session_id: 's', message: 'Claude needs your permission to use Bash' }),
    { type: 'needs-input', sessionId: 's', message: 'Claude needs your permission to use Bash' },
  );
});

test('the hook does nothing inside hyperfocus-spawned claude sessions', async () => {
  let received = false;
  server.events.on('event', () => (received = true));
  const result = await runHook({ hook_event_name: 'Stop', session_id: 's' }, { HYPERFOCUS_SOCK: server.socketPath, HYPERFOCUS_CHILD: '1' });
  assert.equal(result.code, 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(received, false);
});

test('the hook exits quietly and quickly when hyperfocus is not listening', async () => {
  const result = await runHook({ hook_event_name: 'Stop', session_id: 's' }, { HYPERFOCUS_SOCK: '/tmp/no-such-focus.sock' });
  assert.equal(result.code, 0);
  assert.equal(result.stdout + result.stderr, '');
  assert.ok(result.elapsedMs < 1000, `took ${result.elapsedMs}ms`);
});

test('malformed payloads are ignored and never take hyperfocus down', async () => {
  const malformed = [
    null,
    { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'MultiEdit', tool_input: { file_path: '/a.ts' } },
    { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: {} },
    { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit', tool_input: { old_string: 'a', new_string: 'b' } },
    { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: null },
  ];
  const received = [];
  server.events.on('event', (event) => received.push(event));
  for (const payload of malformed) await runHook(payload, { HYPERFOCUS_SOCK: server.socketPath });
  assert.deepEqual(await sendAndReceive({ hook_event_name: 'Stop', session_id: 's' }), { type: 'done', sessionId: 's' });
  assert.deepEqual(received, [{ type: 'done', sessionId: 's' }]);
});
