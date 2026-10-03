import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRunLog, formatChecklist, formatNotes, formatTiming, medianRunMs, readNotes, readTiming } from '../src/notes.js';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'focus-notes-')), 'runs.jsonl');
const edit = (path, anchors) => ({ path, diff: '', anchors });
const run = (prompt, edits) => ({ prompt, startedAt: 0, finished: true, reads: [], edits, commands: [], timeline: [] });

const onDisk = {
  '/repo/src/retry.ts': 'export async function withRetry(fn, attempts = 3) {\n',
  '/repo/src/auth.ts': 'return withRetry(fetchToken, 3);\n',
};
const readFile = (path) => {
  const key = path.replaceAll('\\', '/'); // keyed with /, joined with the platform separator
  if (!(key in onDisk)) throw new Error('ENOENT');
  return onDisk[key];
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

test('runs are logged with how long they took, and a project knows its typical run length', () => {
  const path = tempPath();
  const runs = createRunLog({ path });
  for (const [startedAt, finishedAt] of [[0, 5000], [0, 12_000], [0, 9000]]) {
    runs.append({ ...run('p', []), startedAt, finishedAt }, { cwd: '/repo', sessionId: 's', summary: '' });
  }
  runs.append({ ...run('p', []), startedAt: 0, finishedAt: 60_000 }, { cwd: '/other', sessionId: 's', summary: '' });
  assert.equal(JSON.parse(readFileSync(path, 'utf8').split('\n')[0]).durationMs, 5000);
  assert.equal(medianRunMs({ cwd: '/repo', path }), 9000);
  assert.equal(medianRunMs({ cwd: '/nowhere', path }), null, 'no history, no guess');
});

test('missed questions still in the code become a Markdown checklist', () => {
  const due = [
    { q: 'Why back off?', options: ['Load', 'Style'], answer: 0, why: '', anchor: { file: 'src/retry.ts', anchors: [] } },
    { q: 'Planning?', options: ['a', 'b'], answer: 1, why: '' },
  ];
  assert.equal(formatChecklist(due), '### Worth a look\n\n- [ ] `src/retry.ts`: Why back off? — Load\n- [ ] Planning? — b\n');
  assert.equal(formatChecklist([]), '');
  const notes = formatNotes({ runs: [{ prompt: 'p', summary: '', files: ['a.ts'], ts: '' }], leftOut: 0 }, { project: '~/app', checklist: due.slice(0, 1) });
  assert.match(notes, /- `a.ts`\n\n### Worth a look\n\n- \[ \] `src\/retry.ts`/);
});

test('each run records how long it waited for its first question; --stats shows the median and how many were in time', () => {
  const path = tempPath();
  const runs = createRunLog({ path });
  const timed = (durationMs, firstQuestionMs) => ({ ...run('p', []), startedAt: 1000, finishedAt: 1000 + durationMs, ...(firstQuestionMs === null ? {} : { firstQuestionAt: 1000 + firstQuestionMs }) });
  runs.append(timed(40_000, 4000), { cwd: '/repo', sessionId: 's', summary: '' });
  runs.append(timed(20_000, 6000), { cwd: '/repo', sessionId: 's', summary: '' });
  runs.append(timed(15_000, null), { cwd: '/repo', sessionId: 's', summary: '' }); // none before it ended
  runs.append(timed(30_000, 35_000), { cwd: '/other', sessionId: 't', summary: '' }); // came after the end
  runs.append(timed(3000, null), { cwd: '/repo', sessionId: 's', summary: '' }); // a quick reply: not counted

  const [first] = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(first.firstQuestionMs, 4000);
  assert.equal(first.v, 1);

  appendFileSync(path, JSON.stringify({ ts: '2026-01-01T00:00:00Z', cwd: '/repo', sessionId: 'old', prompt: 'p', summary: '', durationMs: 60_000, files: [] }) + '\n');
  const timing = readTiming({ path });
  assert.deepEqual(timing, { runs: 4, medianMs: 6000, beforeDone: 2 }, 'a run from before 1.0.0 recorded no time, so it is left out');
  const text = formatTiming(timing);
  assert.match(text, /6\.0s median/);
  assert.match(text, /2 of 4 runs had a question before the agent finished/);
  assert.equal(formatTiming({ runs: 0, medianMs: null, beforeDone: 0 }), '');
});
