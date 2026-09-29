import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHistory, readStats } from '../src/history.js';

const focusBin = fileURLToPath(new URL('../bin/focus.js', import.meta.url));
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
    { ts: undefined, cwd: '/repo', sessionId: 's1', question: 'Why retry?', options: ['a', 'b', 'c'], answer: 1, chosen: 2, correct: false, skipped: false, files: ['src/auth.ts'] },
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

test('focus --stats prints accuracy per project without starting claude', async () => {
  const home = tempDir();
  mkdirSync(join(home, '.focus'));
  const line = (cwd, correct) => JSON.stringify({ cwd, correct, skipped: false, question: 'q' });
  writeFileSync(join(home, '.focus', 'history.jsonl'), [line('/work/api', true), line('/work/api', true), line('/work/api', false), line('/work/web', false)].join('\n'));

  const result = await runFocus(['--stats'], { HOME: home, FOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /\/work\/api\s+3\s+2 \(67%\)/);
  assert.match(result.stdout, /\/work\/web\s+1\s+0 \(0%\)/);
  assert.match(result.stdout, /total\s+4\s+2 \(50%\)/);
});

test('focus --stats with no history explains how to get some', async () => {
  const result = await runFocus(['--stats'], { HOME: tempDir(), FOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /No quiz answers recorded yet/);
});

test('--stats shortens only paths inside the home folder to ~', async () => {
  const home = tempDir();
  mkdirSync(join(home, '.focus'));
  const line = (cwd) => JSON.stringify({ cwd, correct: true, skipped: false, question: 'q' });
  writeFileSync(join(home, '.focus', 'history.jsonl'), [line(join(home, 'app')), line(home + '2/app')].join('\n'));
  const result = await runFocus(['--stats'], { HOME: home, FOCUS_CLAUDE_BIN: '/nonexistent/claude' });
  assert.match(result.stdout, /~\/app\s/);
  assert.ok(result.stdout.includes(home + '2/app'), result.stdout);
  assert.doesNotMatch(result.stdout, /~2\/app/);
});
