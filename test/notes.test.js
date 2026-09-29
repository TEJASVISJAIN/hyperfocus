import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunLog, formatNotes, readNotes } from '../src/notes.js';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'focus-notes-')), 'runs.jsonl');
const edit = (path, anchors) => ({ path, diff: '', anchors });
const run = (prompt, edits) => ({ prompt, startedAt: 0, finished: true, reads: [], edits, commands: [], timeline: [] });

const onDisk = {
  '/repo/src/retry.ts': 'export async function withRetry(fn, attempts = 3) {\n',
  '/repo/src/auth.ts': 'return withRetry(fetchToken, 3);\n',
};
const readFile = (path) => {
  if (!(path in onDisk)) throw new Error('ENOENT');
  return onDisk[path];
};

function logSession(path) {
  const runs = createRunLog({ path });
  const record = (sessionId, prompt, summary, edits) => runs.append(run(prompt, edits), { cwd: '/repo', sessionId, summary });
  record('old', 'an older session', 'Old work.', [edit('src/retry.ts', ['export async function withRetry(fn, attempts = 3) {'])]);
  record('s', 'try a circuit breaker for token refresh', 'Adding a circuit breaker.', [edit('src/breaker.ts', ['export class CircuitBreaker {'])]);
  record('s', 'no, use retries with backoff instead\nand keep it small', 'Replacing the breaker with withRetry.', [
    edit('src/retry.ts', ['export async function withRetry(fn, attempts = 3) {']),
    edit('src/auth.ts', ['return withRetry(fetchToken, 3);']),
    edit('src/breaker.ts', ['export class CircuitBreaker {']),
    edit('src/retry.ts', ['export async function withRetry(fn, attempts = 3) {']),
  ]);
  record('s', 'what does this function do?', 'Explaining.', []);
  return runs;
}

test('each finished run is appended with its summary and the lines it added per file', () => {
  const path = tempPath();
  logSession(path);
  const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[2].files, [
    { path: 'src/retry.ts', anchors: ['export async function withRetry(fn, attempts = 3) {'] },
    { path: 'src/auth.ts', anchors: ['return withRetry(fetchToken, 3);'] },
    { path: 'src/breaker.ts', anchors: ['export class CircuitBreaker {'] },
  ]);
  assert.equal(entries[2].summary, 'Replacing the breaker with withRetry.');
});

test('notes cover the latest session in this project, leaving out what is no longer in the code', () => {
  const path = tempPath();
  logSession(path);
  const notes = readNotes({ cwd: '/repo', path, readFile });
  assert.equal(notes.runs.length, 1, 'the breaker run was replaced, the question-only run changed nothing');
  assert.deepEqual(notes.runs[0].files, ['src/retry.ts', 'src/auth.ts'], 'the breaker file is gone from the kept run too');
  assert.equal(notes.leftOut, 1);
});

test('the notes read as markdown, ready for a PR description', () => {
  const path = tempPath();
  logSession(path);
  const text = formatNotes(readNotes({ cwd: '/repo', path, readFile }), { project: '~/repo' });
  assert.match(text, /^## Session notes · ~\/repo/m);
  assert.match(text, /^### no, use retries with backoff instead$/m);
  assert.match(text, /^Replacing the breaker with withRetry\.$/m);
  assert.match(text, /^- `src\/retry\.ts`\n- `src\/auth\.ts`$/m);
  assert.doesNotMatch(text, /circuit breaker for token refresh/);
  assert.match(text, /1 earlier change is left out: it is no longer in the code\./);
});

test('with nothing recorded, the notes say how to get some', () => {
  const text = formatNotes(readNotes({ cwd: '/repo', path: tempPath(), readFile }), { project: '~/repo' });
  assert.match(text, /No changes recorded/);
});
