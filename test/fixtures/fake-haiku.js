#!/usr/bin/env node
// Stand-in for `claude -p`: logs how it was called and replies according to FAKE_HAIKU_MODE.
// Speaks Claude's stream-json when asked to (input and output), the way hyperfocus calls it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const logPath = process.env.FAKE_HAIKU_LOG;
const spawnLog = process.env.FAKE_HAIKU_SPAWNS; // one line per process start, prompt or not
const mode = process.env.FAKE_HAIKU_MODE || 'fenced';
const streamDelayMs = Number(process.env.FAKE_HAIKU_STREAM_DELAY_MS || 0); // pause after the first question
const callNumber = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length + 1 : 1;
const argv = process.argv.slice(2);
const streaming = argv[argv.indexOf('--output-format') + 1] === 'stream-json';
const streamInput = argv[argv.indexOf('--input-format') + 1] === 'stream-json';

if (spawnLog) appendFileSync(spawnLog, JSON.stringify({ pid: process.pid, cwd: process.cwd() }) + '\n');

const batch = {
  summary: 'Claude is wrapping refreshToken() in a retry helper.',
  questions: [
    { q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races', 'Caching'], answer: 1, why: 'Concurrent requests can race.' },
    { q: 'How many attempts?', options: ['1', '3', 'Unlimited'], answer: 1, why: 'attempts: 3' },
  ],
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Whole replies, or Claude's stream: partial text deltas, then the result line.
async function reply(result, isError = false, splitAt = []) {
  if (!streaming) return void process.stdout.write(JSON.stringify({ type: 'result', is_error: isError, result }));
  const line = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  line({ type: 'system', subtype: 'init', cwd: process.cwd() });
  let from = 0;
  for (const [index, at] of [...splitAt, result.length].entries()) {
    line({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: result.slice(from, at) } } });
    from = at;
    if (index === 0 && streamDelayMs) await sleep(streamDelayMs);
  }
  line({ type: 'result', subtype: isError ? 'error' : 'success', is_error: isError, result });
}

let stdin = '';
process.stdin.on('data', (chunk) => (stdin += chunk));
process.stdin.on('end', async () => {
  if (streamInput && !stdin.trim()) return void process.stderr.write('Error: no input\n'); // closed unused: no call
  const prompt = streamInput ? JSON.parse(stdin.split('\n')[0]).message.content : stdin;
  if (logPath) appendFileSync(
    logPath,
    JSON.stringify({ argv, pid: process.pid, cwd: process.cwd(), child: process.env.HYPERFOCUS_CHILD, maxThinking: process.env.MAX_THINKING_TOKENS ?? null, sock: process.env.HYPERFOCUS_SOCK ?? null, stdin: prompt }) + '\n',
  );
  if (mode === 'slow') await sleep(3000);

  const systemPrompt = argv[argv.indexOf('--system-prompt') + 1] ?? '';
  if (/project brief/i.test(systemPrompt)) return reply(mode === 'error' ? 'API Error' : 'A retry library for token refresh. Node ESM, tests with node:test.', mode === 'error');
  if (/lesson/i.test(systemPrompt)) return reply(mode === 'error' ? 'API Error' : 'A race happens when two requests refresh at once; here withRetry absorbs it.', mode === 'error');
  if (/follow-up/i.test(systemPrompt)) return reply(mode === 'error' ? 'API Error' : 'Because a request can still race the expiry window.', mode === 'error');
  if (mode === 'error') return reply('API Error: overloaded', true);
  if (mode === 'always-invalid' || (mode === 'invalid-then-valid' && callNumber === 1)) return reply('Sure! Here are some questions: 1) ...');
  if (mode === 'no-questions') return reply(JSON.stringify({ summary: 'Reading files.', questions: [] }));
  if (mode === 'long-question') {
    const long = { ...batch.questions[0], q: 'Why '.repeat(80) + '?' };
    return reply(JSON.stringify({ summary: batch.summary, questions: [long, batch.questions[1]] }));
  }
  const text = '```json\n' + JSON.stringify(batch, null, 2) + '\n```';
  // Split right after the first question's closing brace, so a stream shows it before the rest.
  reply(text, false, [text.indexOf('"How many attempts?"')]);
});
