import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { checkOllama, ollamaHost, ollamaWriter } from '../src/agents/ollama.js';
import { parseFocusArgs } from '../src/cli-args.js';
import { loadConfig } from '../src/config.js';
import { createQuizEngine } from '../src/quiz-engine.js';

const REPLY = JSON.stringify({
  questions: [{ q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races', 'Caching'], answer: 1, why: 'Concurrent requests can race.', file: 'src/auth.ts' }],
  summary: 'Wrapping refreshToken() in a retry helper.',
});

// A stand-in for Ollama: /api/tags lists the pulled models, /api/chat streams the reply in pieces.
async function fakeOllama({ models = ['qwen2.5-coder:7b'] } = {}) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      if (request.url === '/api/tags') return response.end(JSON.stringify({ models: models.map((name) => ({ name })) }));
      requests.push(JSON.parse(body));
      response.setHeader('content-type', 'application/x-ndjson');
      const isQuiz = /JSON/.test(requests.at(-1).messages[0].content);
      const text = isQuiz ? REPLY : 'Because a request can still race the expiry window.';
      for (const piece of [text.slice(0, 40), text.slice(40)]) response.write(JSON.stringify({ message: { role: 'assistant', content: piece }, done: false }) + '\n');
      response.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${address.port}` }, requests, close: () => server.close() };
}

const run = {
  prompt: 'add retry to token refresh',
  startedAt: 1,
  finished: false,
  reads: ['src/auth.ts'],
  edits: [{ path: 'src/auth.ts', diff: '- return fetchToken();\n+ return withRetry(fetchToken);', anchors: ['return withRetry(fetchToken);'] }],
  commands: [],
  timeline: [],
};

test('with the Ollama writer, questions come from the local model and nothing else is started', async () => {
  const ollama = await fakeOllama();
  const engine = createQuizEngine({ claudePath: '', writer: ollamaWriter, model: 'qwen2.5-coder:7b', env: ollama.env, random: () => 0.999999 });
  const batch = await new Promise((resolve) => {
    engine.on('batch', (next) => next.summary && resolve(next));
    engine.update(run, { queuedQuestions: 0 });
  });
  assert.equal(batch.summary, 'Wrapping refreshToken() in a retry helper.');
  const [request] = ollama.requests;
  assert.equal(request.model, 'qwen2.5-coder:7b');
  assert.equal(request.stream, true);
  assert.match(request.messages[1].content, /\+ return withRetry\(fetchToken\);/);
  assert.equal(engine.isWarm(), false, 'no process is kept warm for an HTTP writer');

  const answer = await engine.askFollowUp(run, { question: { q: 'Why?', options: ['a', 'b'], answer: 1, why: 'w' }, chosen: 0, ask: 'why not earlier?', thread: [] });
  assert.equal(answer, 'Because a request can still race the expiry window.');
  ollama.close();
});

test('the Ollama writer streams: the first question shows before the reply ends', async () => {
  const ollama = await fakeOllama();
  const engine = createQuizEngine({ claudePath: '', writer: ollamaWriter, model: 'qwen2.5-coder:7b', env: ollama.env });
  const batches = [];
  await new Promise((resolve) => {
    engine.on('batch', (batch) => {
      batches.push(batch);
      if (batch.summary) resolve(undefined);
    });
    engine.update(run, { queuedQuestions: 0 });
  });
  assert.equal(batches.reduce((sum, batch) => sum + batch.questions.length, 0), 1, 'the question once');
  ollama.close();
});

test('--doctor: Ollama reachable with the model pulled, not pulled, or not running', async () => {
  const ollama = await fakeOllama();
  assert.equal((await checkOllama({ model: 'qwen2.5-coder:7b', env: ollama.env })).status, 'ok');
  const missing = await checkOllama({ model: 'llama3.2', env: ollama.env });
  assert.equal(missing.status, 'fail');
  assert.match(missing.hint ?? '', /ollama pull llama3\.2/);
  ollama.close();
  const down = await checkOllama({ model: 'llama3.2', env: { OLLAMA_HOST: '127.0.0.1:9' } });
  assert.equal(down.status, 'fail');
  assert.match(down.detail, /not reachable/);
});

test('OLLAMA_HOST is read the way Ollama reads it', () => {
  assert.equal(ollamaHost({}), 'http://127.0.0.1:11434');
  assert.equal(ollamaHost({ OLLAMA_HOST: '0.0.0.0:8080' }), 'http://0.0.0.0:8080');
  assert.equal(ollamaHost({ OLLAMA_HOST: 'https://ollama.internal/' }), 'https://ollama.internal');
});

test('the writer is chosen in config or with --writer, and --writer never reaches the agent', () => {
  assert.deepEqual(parseFocusArgs(['--writer', 'ollama', '--model', 'opus']).claudeArgs, ['--model', 'opus']);
  assert.equal(parseFocusArgs(['--writer=ollama']).writer, 'ollama');
  assert.equal(parseFocusArgs([]).writer, null);
  const { config, problems } = loadConfig({ path: '/nonexistent/config.json' });
  assert.equal(config.writer, 'auto');
  assert.deepEqual(problems, []);
});
