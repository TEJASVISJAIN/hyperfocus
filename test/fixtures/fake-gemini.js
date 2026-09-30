#!/usr/bin/env node
// Stands in for `gemini`: hooks come from $GEMINI_CLI_SYSTEM_SETTINGS_PATH, payloads are Gemini-shaped,
// and `gemini -p … -o json` answers with canned questions.
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('-p')) {
  process.stdin.resume();
  process.stdin.on('end', () => {
    const batch = {
      summary: 'Gemini is wrapping fetchToken in withRetry.',
      questions: [{ kind: 'why', q: 'Why does refresh need a retry?', options: ['Expired tokens race', 'Caching', 'Logging'], answer: 0, why: 'Concurrent requests race.' }],
    };
    process.stdout.write(JSON.stringify({ response: JSON.stringify(batch), stats: {} }));
  });
} else {
  process.stdout.write('fake gemini ready\r\n');
  const hooks = JSON.parse(readFileSync(process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8')).hooks;
  const fire = (event, payload) => {
    for (const entry of hooks[event] ?? []) {
      const child = exec(entry.hooks[0].command, () => {});
      child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: 'gemini-session', cwd: process.cwd(), ...payload }));
    }
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (data) => {
    if (data.includes('go')) {
      fire('BeforeAgent', { prompt: 'add retry to token refresh' });
      setTimeout(() => fire('AfterTool', { tool_name: 'replace', tool_input: { file_path: `${process.cwd()}/src/auth.ts`, old_string: 'return fetchToken();', new_string: 'return withRetry(fetchToken);' } }), 50);
    }
    if (data.includes('quit')) process.exit(0);
  });
}
