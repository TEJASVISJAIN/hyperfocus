import assert from 'node:assert/strict';
import { test } from 'node:test';
import { surroundingCode } from '../src/code-context.js';

const numbered = (count, name = 'line') => Array.from({ length: count }, (_, index) => `${name} ${index + 1}`);
const edit = (path, anchors) => ({ path, diff: '', anchors });
const run = (edits) => ({ prompt: '', startedAt: 0, finished: false, reads: [], edits, commands: [], timeline: [] });

test('takes ten lines either side of the lines an edit added, from the file on disk', () => {
  const lines = numbered(60);
  lines[29] = 'export async function withRetry(fn) {';
  const files = { '/repo/src/retry.ts': lines.join('\n') };
  const [context] = surroundingCode(run([edit('src/retry.ts', ['export async function withRetry(fn) {'])]), { cwd: '/repo', readFile: (path) => files[path] });
  assert.equal(context.file, 'src/retry.ts');
  const shown = context.text.split('\n');
  assert.equal(shown[0], 'line 20');
  assert.equal(shown.at(-1), 'line 40');
  assert.equal(shown.length, 21);
});

test('caps each edit at 40 lines and the whole context at 100, newest edits first', () => {
  const files = {};
  const edits = [];
  for (const name of ['a', 'b', 'c', 'd']) {
    const lines = numbered(200, name);
    for (const at of [20, 60, 100]) lines[at] = `${name} anchor line number ${at}`;
    files[`/repo/${name}.ts`] = lines.join('\n');
    edits.push(edit(`${name}.ts`, [20, 60, 100].map((at) => `${name} anchor line number ${at}`)));
  }
  const context = surroundingCode(run(edits), { cwd: '/repo', readFile: (path) => files[path] });
  assert.deepEqual(context.map((part) => part.file), ['d.ts', 'c.ts', 'b.ts'], 'the last three edits, latest first');
  for (const part of context) assert.ok(part.text.split('\n').length <= 40);
  assert.ok(context.reduce((sum, part) => sum + part.text.split('\n').length, 0) <= 100);
});

test('skips sensitive files, files that are gone, and edits whose lines are no longer there; redacts secrets', () => {
  const files = {
    '/repo/.env': 'API_KEY=sk-live-abcdefghijklmnop\nOTHER_SETTING=1',
    '/repo/src/config.ts': 'const apiToken = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\nexport const retryAttempts = 3;',
    '/repo/src/moved.ts': 'nothing of the edit is left here',
  };
  const edits = [
    edit('.env', ['OTHER_SETTING=1 and more']),
    edit('src/gone.ts', ['export function vanished() {']),
    edit('src/moved.ts', ['export function renamedAway() {']),
    edit('src/config.ts', ['export const retryAttempts = 3;']),
  ];
  const context = surroundingCode(run(edits), { cwd: '/repo', readFile: (path) => { if (!(path in files)) throw new Error('ENOENT'); return files[path]; } });
  assert.deepEqual(context.map((part) => part.file), ['src/config.ts']);
  assert.doesNotMatch(context[0].text, /ghp_/);
  assert.match(context[0].text, /retryAttempts/);
});
