import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHistory, dueRepeats, missedStillInCode, readStats, readInsights, recentAccuracy, recentBadQuestions, formatStats } from '../src/history.js';

const focusBin = fileURLToPath(new URL('../bin/hyperfocus.js', import.meta.url));
const question = { q: 'Why retry?', options: ['a', 'b', 'c'], answer: 1, why: 'w' };
const tempDir = () => mkdtempSync(join(tmpdir(), 'focus-history-'));

test('each answer is appended as one JSON line, creating the folder on demand', () => {
  const path = join(tempDir(), 'nested', 'history.jsonl');
  const history = createHistory({ path });
  history.append({ question, chosen: 2, correct: false, skipped: false }, { cwd: '/repo', sessionId: 's1', files: ['src/auth.ts'] });
  history.append({ question, chosen: null, correct: null, skipped: true }, { cwd: '/repo', sessionId: 's1', files: [] });

  const entries = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  const [first] = entries;
  assert.equal(typeof first.ts, 'string');
  assert.deepEqual(
    { ...first, ts: undefined },
    {
      v: 1, ts: undefined, cwd: '/repo', sessionId: 's1', source: 'live', kind: 'why', question: 'Why retry?', options: ['a', 'b', 'c'], answer: 1,
      why: 'w', chosen: 2, correct: false, skipped: false, files: ['src/auth.ts'],
    },
  );
  assert.equal(entries[1].skipped, true);
});

test('a history file that cannot be written never throws', () => {
  const directoryInTheWay = tempDir();
  const history = createHistory({ path: directoryInTheWay });
  assert.doesNotThrow(() => history.append({ question, chosen: 1, correct: true, skipped: false }, { cwd: '/repo', sessionId: 's', files: [] }));
});

test('stats add up answers per project and skip unreadable lines', () => {
  const path = join(tempDir(), 'history.jsonl');
  const line = (cwd, correct, skipped = false) => JSON.stringify({ cwd, correct, skipped, question: 'q' });
  writeFileSync(path, [line('/a', true), line('/a', false), line('/a', null, true), 'not json', line('/b', true), ''].join('\n'));
  assert.deepEqual(readStats(path), [
    { cwd: '/a', answered: 2, correct: 1, skipped: 1 },
    { cwd: '/b', answered: 1, correct: 1, skipped: 0 },
  ]);
});

test('stats for a missing history file are empty', () => {
  assert.deepEqual(readStats(join(tempDir(), 'none.jsonl')), []);
});

function runFocus(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [focusBin, ...args], { env: { ...process.env, ...env } }, (error, stdout, stderr) =>
      resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

test('hyperfocus --stats prints accuracy per project without starting claude', async () => {
  const home = tempDir();
  mkdirSync(join(home, '.hyperfocus'));
  const line = (cwd, correct) => JSON.stringify({ cwd, correct, skipped: false, question: 'q' });
  writeFileSync(join(home, '.hyperfocus', 'history.jsonl'), [line('/work/api', true), line('/work/api', true), line('/work/api', false), line('/work/web', false)].join('\n'));

  const result = await runFocus(['--stats'], { HOME: home, USERPROFILE: home, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/work\/api\s+3\s+2 \(67%\)/);
  assert.match(result.stdout, /\/work\/web\s+1\s+0 \(0%\)/);
  assert.match(result.stdout, /total\s+4\s+2 \(50%\)/);
});

test('hyperfocus --stats with no history explains how to get some', async () => {
  const home = tempDir();
  const result = await runFocus(['--stats'], { HOME: home, USERPROFILE: home, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No quiz answers recorded yet/);
});

test('--stats shortens only paths inside the home folder to ~', async () => {
  const home = tempDir();
  mkdirSync(join(home, '.hyperfocus'));
  const line = (cwd) => JSON.stringify({ cwd, correct: true, skipped: false, question: 'q' });
  writeFileSync(join(home, '.hyperfocus', 'history.jsonl'), [line(join(home, 'app')), line(home + '2/app')].join('\n'));
  const result = await runFocus(['--stats'], { HOME: home, USERPROFILE: home, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.match(result.stdout, /~\/app\s/);
  assert.ok(result.stdout.includes(home + '2/app'), result.stdout);
  assert.doesNotMatch(result.stdout, /~2\/app/);
});

test('what a later review needs is kept: the kind, the code excerpt and its anchor', () => {
  const path = join(tempDir(), 'history.jsonl');
  const anchored = { ...question, kind: 'bug', code: 'await sleep(200);', codeMarks: ['+'], anchor: { file: 'src/retry.ts', anchors: ['await sleep(200);'] } };
  createHistory({ path }).append({ question: anchored, chosen: 0, correct: false, skipped: false }, { cwd: '/repo', sessionId: 's', files: [], source: 'review' });
  const [entry] = readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entry.source, 'review');
  assert.equal(entry.kind, 'bug');
  assert.equal(entry.code, 'await sleep(200);');
  assert.deepEqual(entry.codeMarks, ['+']);
  assert.deepEqual(entry.anchor, { file: 'src/retry.ts', anchors: ['await sleep(200);'] });
});

test('review brings back missed questions whose code is still there, and nothing that was discarded', () => {
  const path = join(tempDir(), 'history.jsonl');
  const history = createHistory({ path });
  const kept = { file: 'src/retry.ts', anchors: ['export async function withRetry(fn) {'] };
  const discarded = { file: 'src/breaker.ts', anchors: ['export class CircuitBreaker {'] };
  const ask = (q, anchor, correct, { cwd = '/repo', skipped = false, kind = 'why' } = {}) =>
    history.append({ question: { ...question, kind, q, anchor }, chosen: 0, correct, skipped }, { cwd, sessionId: 's', files: [] });

  ask('Why retry at all?', kept, false);
  ask('Why a breaker?', discarded, false); // change X, since replaced by Y
  ask('Why three attempts?', kept, false);
  ask('Why three attempts?', kept, true); // got it right later
  ask('Why no jitter?', kept, true);
  ask('Skipped one?', kept, null, { skipped: true });
  ask('Planning question?', undefined, false);
  ask('Another project?', kept, false, { cwd: '/other' });
  ask('Which file next?', kept, false, { kind: 'predict' });
  ask('Why back off?', kept, false);

  const files = { '/repo/src/retry.ts': 'export async function withRetry(fn) {\n' };
  const readFile = (file) => {
    if (!(file.replaceAll('\\', '/') in files)) throw new Error('ENOENT');
    return files[file.replaceAll('\\', '/')];
  };
  const due = missedStillInCode({ cwd: '/repo', path, readFile });
  assert.deepEqual(due.map((entry) => entry.q), ['Why back off?', 'Why retry at all?'], 'newest first');
  assert.deepEqual(due[0].options, ['a', 'b', 'c']);
  assert.equal(due[0].answer, 1);
  assert.equal(due[0].why, 'w');
  assert.deepEqual(due[0].anchor, kept);
});

test('recent accuracy in a project feeds the question difficulty', () => {
  const path = join(tempDir(), 'history.jsonl');
  const history = createHistory({ path });
  for (let index = 0; index < 30; index++) {
    history.append({ question, chosen: 0, correct: index >= 10, skipped: false }, { cwd: '/repo', sessionId: 's', files: [] });
  }
  history.append({ question, chosen: 0, correct: false, skipped: false }, { cwd: '/other', sessionId: 's', files: [] });
  history.append({ question, chosen: null, correct: null, skipped: true }, { cwd: '/repo', sessionId: 's', files: [] });
  assert.deepEqual(recentAccuracy({ cwd: '/repo', path }), { answered: 20, correct: 20 }, 'the latest 20 answers, skips left out');
  assert.deepEqual(recentAccuracy({ cwd: '/nowhere', path }), { answered: 0, correct: 0 });
});

test('hand-edited or damaged history entries are never brought back for review', () => {
  const path = join(tempDir(), 'history.jsonl');
  const anchor = { file: 'a.ts', anchors: ['export const kept = computeKept();'] };
  const base = { cwd: '/repo', question: 'Q?', options: ['a', 'b'], answer: 0, why: 'w', correct: false, skipped: false, anchor };
  writeFileSync(path, [{ ...base, question: 'numbers?', options: [1, 2] }, { ...base, question: 'code?', code: 42 }, { ...base, question: 'marks?', code: 'x', codeMarks: 'nope' }].map((entry) => JSON.stringify(entry)).join('\n'));
  assert.deepEqual(missedStillInCode({ cwd: '/repo', path, readFile: () => 'export const kept = computeKept();' }), []);
});

test('a question rated bad never comes back for review, is left out of stats, and is remembered as one to avoid', () => {
  const path = join(tempDir(), 'history.jsonl');
  const history = createHistory({ path });
  const anchor = { file: 'src/retry.ts', anchors: ['export async function withRetry(fn) {'] };
  const where = { cwd: '/repo', sessionId: 's', files: [] };
  history.append({ question: { ...question, q: 'Bad but missed?', anchor }, chosen: 0, correct: false, skipped: false }, where);
  history.append({ question: { ...question, q: 'Bad but missed?', anchor }, chosen: null, correct: null, skipped: true, rating: 'bad' }, where);
  history.append({ question: { ...question, q: 'Fair and missed?', anchor }, chosen: 0, correct: false, skipped: false }, where);
  for (const n of [1, 2, 3, 4, 5, 6]) history.append({ question: { ...question, q: `Bad ${n}?` }, chosen: null, correct: null, skipped: true, rating: 'bad' }, where);
  history.append({ question: { ...question, q: 'Elsewhere bad?' }, chosen: null, correct: null, skipped: true, rating: 'bad' }, { ...where, cwd: '/other' });

  assert.equal(JSON.parse(readFileSync(path, 'utf8').split('\n')[1]).rating, 'bad');
  const readFile = () => 'export async function withRetry(fn) {\n';
  assert.deepEqual(missedStillInCode({ cwd: '/repo', path, readFile }).map((entry) => entry.q), ['Fair and missed?']);
  const [repo] = readStats(path);
  assert.equal(repo.answered, 1, 'the answer to the bad question is not counted');
  assert.deepEqual(recentBadQuestions({ cwd: '/repo', path }), ['Bad 2?', 'Bad 3?', 'Bad 4?', 'Bad 5?', 'Bad 6?']);
});

test('insights: accuracy all time and lately, per kind, weakest concepts, this project, and the day streak', () => {
  const path = join(tempDir(), 'history.jsonl');
  const day = (n) => new Date(Date.UTC(2026, 8, n)).toISOString();
  const entry = (ts, { cwd = '/repo', sessionId = 's1', kind = 'why', tags = [], correct = true, skipped = false } = {}) =>
    JSON.stringify({ ts, cwd, sessionId, kind, tags, correct, skipped, question: `q${Math.random()}` });
  writeFileSync(path, [
    entry(new Date(Date.UTC(2026, 7, 1)).toISOString(), { sessionId: 'old', correct: false, tags: ['concurrency'] }),
    entry(new Date(Date.UTC(2026, 7, 1)).toISOString(), { sessionId: 'old', correct: false, tags: ['concurrency'] }),
    entry(day(25), { sessionId: 'a', correct: true, tags: ['concurrency'] }),
    entry(day(25), { sessionId: 'a', kind: 'bug', correct: false, tags: ['state'] }),
    entry(day(26), { sessionId: 'b', kind: 'bug', correct: false, tags: ['state'] }),
    entry(day(26), { sessionId: 'b', kind: 'bug', correct: true, tags: ['state', 'types'] }),
    entry(day(27), { sessionId: 'c', cwd: '/other', correct: true, tags: ['types'] }),
    entry(day(27), { sessionId: 'c', cwd: '/other', correct: true, tags: ['types'] }),
    entry(day(28), { sessionId: 'd', skipped: true, correct: null }),
  ].join('\n'));
  const insights = readInsights({ path, cwd: '/repo', now: Date.parse(day(28)) + 12 * 3600_000 });
  assert.deepEqual(insights.allTime, { answered: 8, correct: 4 });
  assert.deepEqual(insights.lately, { answered: 6, correct: 4 }, 'the last 30 days');
  assert.deepEqual(insights.byKind, { why: { answered: 5, correct: 3 }, bug: { answered: 3, correct: 1 } });
  assert.deepEqual(insights.weakest, [
    { tag: 'concurrency', answered: 3, correct: 1 },
    { tag: 'state', answered: 3, correct: 1 },
  ], 'tags with three or more answers and at least one miss, weakest first, ties by name; types is all right');
  assert.deepEqual(insights.project, { answered: 6, correct: 2 });
  assert.equal(insights.streak, 3, 'answers on the 25th, 26th and 27th; the 28th (today) only has a skip');
  assert.equal(readInsights({ path, cwd: '/repo', now: Date.parse(day(30)) + 12 * 3600_000 }).streak, 0, 'broken by two days without answers');

  const text = formatStats(readStats(path), insights);
  assert.match(text, /last 30 days\s+4 of 6 right \(67%\)/);
  assert.match(text, /spot the bug\s+1 of 3 right/);
  assert.match(text, /state\s+1 of 3 right/);
  assert.match(text, /this project\s+2 of 6 right/);
  assert.match(text, /streak\s+3 days/);
});

test('a missed question comes back a day, then three days, then a week later, and a miss starts it over', () => {
  const path = join(tempDir(), 'history.jsonl');
  const anchor = { file: 'src/retry.ts', anchors: ['export async function withRetry(fn) {'] };
  const readFile = () => 'export async function withRetry(fn) {\n';
  const day = (n) => Date.parse('2026-10-01T09:00:00Z') + n * 24 * 3600_000;
  const lines = [];
  const answer = (at, correct) => lines.push(JSON.stringify({ v: 1, ts: new Date(at).toISOString(), cwd: '/repo', source: 'live', kind: 'why', question: 'Why retry?', options: ['a', 'b', 'c'], answer: 1, why: 'w', anchor, chosen: correct ? 1 : 0, correct, skipped: false, files: [] }));
  const due = (at) => {
    writeFileSync(path, lines.join('\n') + '\n');
    return dueRepeats({ cwd: '/repo', path, now: at, readFile }).map((question) => question.q);
  };

  answer(day(0), false);
  assert.deepEqual(due(day(0.9)), [], 'not the same day');
  assert.deepEqual(due(day(1)), ['Why retry?'], 'a day later');
  answer(day(1), true);
  assert.deepEqual(due(day(3.9)), []);
  assert.deepEqual(due(day(4)), ['Why retry?'], 'then three days later');
  answer(day(4), false);
  assert.deepEqual(due(day(4.5)), [], 'a miss starts again');
  assert.deepEqual(due(day(5)), ['Why retry?'], 'from one day');
  answer(day(5), true);
  answer(day(8), true);
  assert.deepEqual(due(day(14.9)), []);
  assert.deepEqual(due(day(15)), ['Why retry?'], 'then a week');
  answer(day(15), true);
  assert.deepEqual(due(day(60)), [], 'learnt');
});

test('a repeat is ready to ask, marked as one, and never about code that is gone', () => {
  const path = join(tempDir(), 'history.jsonl');
  const history = createHistory({ path });
  const where = { cwd: '/repo', sessionId: 's', files: [] };
  history.append({ question: { ...question, q: 'Still here?', anchor: { file: 'src/a.ts', anchors: ['export const kept = computeKept();'] } }, chosen: 0, correct: false, skipped: false }, where);
  history.append({ question: { ...question, q: 'Gone?', anchor: { file: 'src/a.ts', anchors: ['export const removed = oldThing();'] } }, chosen: 0, correct: false, skipped: false }, where);
  const later = Date.now() + 2 * 24 * 3600_000;
  const due = dueRepeats({ cwd: '/repo', path, now: later, readFile: () => 'export const kept = computeKept();' });
  assert.deepEqual(due.map((entry) => [entry.q, entry.repeat, entry.options[entry.answer]]), [['Still here?', true, 'b']]);
});

test('entries from older and newer versions are read alike: unknown fields are ignored', () => {
  const path = join(tempDir(), 'history.jsonl');
  const base = { ts: new Date().toISOString(), cwd: '/repo', kind: 'why', question: 'Why?', options: ['a', 'b'], answer: 1, why: 'w', skipped: false, files: [] };
  writeFileSync(path, [JSON.stringify({ ...base, chosen: 1, correct: true }), JSON.stringify({ ...base, v: 7, chosen: 0, correct: false, someFutureField: { nested: true } })].join('\n') + '\n');
  assert.deepEqual(readStats(path), [{ cwd: '/repo', answered: 2, correct: 1, skipped: 0 }]);
});
