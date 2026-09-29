import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHistory, missedStillInCode, readStats, recentAccuracy } from '../src/history.js';

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
      ts: undefined, cwd: '/repo', sessionId: 's1', source: 'live', kind: 'why', question: 'Why retry?', options: ['a', 'b', 'c'], answer: 1,
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

  const result = await runFocus(['--stats'], { HOME: home, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/work\/api\s+3\s+2 \(67%\)/);
  assert.match(result.stdout, /\/work\/web\s+1\s+0 \(0%\)/);
  assert.match(result.stdout, /total\s+4\s+2 \(50%\)/);
});

test('hyperfocus --stats with no history explains how to get some', async () => {
  const result = await runFocus(['--stats'], { HOME: tempDir(), HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No quiz answers recorded yet/);
});

test('--stats shortens only paths inside the home folder to ~', async () => {
  const home = tempDir();
  mkdirSync(join(home, '.hyperfocus'));
  const line = (cwd) => JSON.stringify({ cwd, correct: true, skipped: false, question: 'q' });
  writeFileSync(join(home, '.hyperfocus', 'history.jsonl'), [line(join(home, 'app')), line(home + '2/app')].join('\n'));
  const result = await runFocus(['--stats'], { HOME: home, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude' });
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
    if (!(file in files)) throw new Error('ENOENT');
    return files[file];
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
