import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorFor, anchorsFrom, isStillInCode } from '../src/code-anchors.js';

const retryDiff = [
  '- return fetchToken();',
  '+ return withRetry(fetchToken, { attempts: 3, backoffMs: 200 });',
  '+ }',
  '+ // retry',
  '+ export const RETRYABLE_STATUS = new Set([429, 503]);',
].join('\n');

test('anchors are the distinctive lines a change added', () => {
  assert.deepEqual(anchorsFrom(retryDiff), [
    'return withRetry(fetchToken, { attempts: 3, backoffMs: 200 });',
    'export const RETRYABLE_STATUS = new Set([429, 503]);',
  ]);
});

test('lines that were redacted or omitted are not anchors', () => {
  assert.deepEqual(anchorsFrom('+ const token = "[redacted]";\n(older change omitted)\n+ … (truncated)'), []);
});

test('there are at most 8 anchors, the longest lines first', () => {
  const diff = Array.from({ length: 12 }, (_, index) => `+ const value${index} = compute(${'x'.repeat(index)});`).join('\n');
  const anchors = anchorsFrom(diff);
  assert.equal(anchors.length, 8);
  assert.match(anchors[0], /value11/);
});

const fileWith = (text) => () => text;
const anchored = { file: 'src/auth.ts', anchors: anchorsFrom(retryDiff) };

test('a change is still in the code while its lines are, whatever the indentation', () => {
  const current = 'function refresh() {\n    return withRetry(fetchToken, { attempts: 3, backoffMs: 200 });\n}\nexport const RETRYABLE_STATUS = new Set([429, 503]);\n';
  assert.equal(isStillInCode(anchored, { cwd: '/repo', readFile: fileWith(current) }), true);
});

test('a change that was rewritten in another direction is gone', () => {
  const rewritten = 'function refresh() {\n  return circuitBreaker.call(fetchToken);\n}\n';
  assert.equal(isStillInCode(anchored, { cwd: '/repo', readFile: fileWith(rewritten) }), false);
});

test('half of the lines surviving still counts as in the code', () => {
  const partly = 'export const RETRYABLE_STATUS = new Set([429, 503]);\n';
  assert.equal(isStillInCode(anchored, { cwd: '/repo', readFile: fileWith(partly) }), true);
});

test('a deleted file means the change is gone', () => {
  const missing = () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  assert.equal(isStillInCode(anchored, { cwd: '/repo', readFile: missing }), false);
});

test('without anchors nothing can be checked, so it does not count as in the code', () => {
  assert.equal(isStillInCode({ file: 'src/auth.ts', anchors: [] }, { cwd: '/repo', readFile: fileWith('anything') }), false);
  assert.equal(isStillInCode({}, { cwd: '/repo', readFile: fileWith('anything') }), false);
});

test('relative files are read from the project they were recorded in', () => {
  const paths = [];
  isStillInCode(anchored, { cwd: '/repo', readFile: (path) => (paths.push(path), '') });
  isStillInCode({ ...anchored, file: '/elsewhere/a.ts' }, { cwd: '/repo', readFile: (path) => (paths.push(path), '') });
  assert.deepEqual(paths, ['/repo/src/auth.ts', '/elsewhere/a.ts']);
});

const edit = (path, diff) => ({ path, diff, anchors: anchorsFrom(diff) });
const retryEdit = edit('src/retry.ts', '+ export async function withRetry(fn, attempts = 3) {\n+   return await fn().catch(() => withRetry(fn, attempts - 1));\n+ }');
const authEdit = edit('src/auth.ts', '-   return fetchToken();\n+   return withRetry(fetchToken, 3);');
const runWith = (...edits) => ({ edits });

test('a question with a code excerpt is anchored on the lines it quotes', () => {
  const question = { file: 'src/retry.ts', code: 'return await fn().catch(() => withRetry(fn, attempts - 1));', codeMarks: ['+'] };
  assert.deepEqual(anchorFor(question, runWith(retryEdit, authEdit)), {
    file: 'src/retry.ts',
    anchors: ['return await fn().catch(() => withRetry(fn, attempts - 1));'],
  });
});

test('an excerpt without a file is anchored on the file whose diff has those lines', () => {
  const question = { code: 'return withRetry(fetchToken, 3);', codeMarks: ['+'] };
  assert.deepEqual(anchorFor(question, runWith(retryEdit, authEdit)), { file: 'src/auth.ts', anchors: ['return withRetry(fetchToken, 3);'] });
});

test('a question about a file is anchored on everything the run added there', () => {
  assert.deepEqual(anchorFor({ file: 'src/retry.ts' }, runWith(retryEdit, authEdit)), { file: 'src/retry.ts', anchors: retryEdit.anchors });
});

test('otherwise the latest edit anchors the question', () => {
  assert.deepEqual(anchorFor({}, runWith(retryEdit, authEdit)), { file: 'src/auth.ts', anchors: authEdit.anchors });
});

test('questions asked before any edit have no anchor', () => {
  assert.equal(anchorFor({ file: 'src/auth.ts' }, runWith()), null);
});

test('redacted lines in an excerpt are never anchors', () => {
  const secretEdit = edit('src/config.ts', '+ const apiKey = "[redacted]";\n+ const endpoint = buildEndpoint(region);');
  const question = { code: 'const apiKey = "[redacted]";\nconst endpoint = buildEndpoint(region);', codeMarks: ['+', '+'] };
  assert.deepEqual(anchorFor(question, runWith(secretEdit)), { file: 'src/config.ts', anchors: ['const endpoint = buildEndpoint(region);'] });
});
