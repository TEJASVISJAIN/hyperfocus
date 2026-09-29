#!/usr/bin/env node
// Stand-in for `claude -p`: logs how it was called and replies according to FAKE_HAIKU_MODE.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const logPath = process.env.FAKE_HAIKU_LOG;
const mode = process.env.FAKE_HAIKU_MODE || 'fenced';
const callNumber = existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length + 1 : 1;

const batch = {
  summary: 'Claude is wrapping refreshToken() in a retry helper.',
  questions: [
    { q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races', 'Caching'], answer: 1, why: 'Concurrent requests can race.' },
    { q: 'How many attempts?', options: ['1', '3', 'Unlimited'], answer: 1, why: 'attempts: 3' },
  ],
};

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', async () => {
  appendFileSync(
    logPath,
    JSON.stringify({ argv: process.argv.slice(2), child: process.env.HYPERFOCUS_CHILD, maxThinking: process.env.MAX_THINKING_TOKENS ?? null, sock: process.env.HYPERFOCUS_SOCK ?? null, stdin }) + '\n',
  );
  if (mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 3000));
  const reply = (result, isError = false) => process.stdout.write(JSON.stringify({ type: 'result', is_error: isError, result }));

  if (mode === 'error') return reply('API Error: overloaded', true);
  if (mode === 'always-invalid' || (mode === 'invalid-then-valid' && callNumber === 1)) return reply('Sure! Here are some questions: 1) ...');
  if (mode === 'no-questions') return reply(JSON.stringify({ summary: 'Reading files.', questions: [] }));
  reply('```json\n' + JSON.stringify(batch, null, 2) + '\n```');
});
