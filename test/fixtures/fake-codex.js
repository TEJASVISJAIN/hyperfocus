#!/usr/bin/env node
// Stands in for `codex`: hooks come from $CODEX_HOME/hooks.json, payloads are Codex-shaped, and
// `codex exec --json` answers with canned questions as JSONL.
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args[0] === 'exec') {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const batch = {
      summary: 'Codex is wrapping fetchToken in withRetry.',
      questions: [{ kind: 'why', q: 'Why retry the token refresh?', options: ['Expired tokens race', 'Caching', 'Logging'], answer: 0, why: 'Concurrent requests race.' }],
    };
    process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: JSON.stringify(batch) } }) + '\n');
  });
} else {
  process.stdout.write(`fake codex ready ${args.join(' ')}\r\n`);
  const hooks = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'hooks.json'), 'utf8')).hooks;
  const fire = (event, payload) => {
    for (const entry of hooks[event] ?? []) {
      const child = exec(entry.hooks[0].command, () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'codex-session', cwd: process.cwd(), ...payload }));
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (data.includes('go')) {
      fire('UserPromptSubmit', { prompt: 'add retry to token refresh' });
      setTimeout(() => fire('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-  return fetchToken();\n+  return withRetry(fetchToken);\n*** End Patch' } }), 50);
    }
    if (data.includes('stop')) fire('Stop', { stop_hook_active: false });
    if (data.includes('quit')) process.exit(0);
  });
}
