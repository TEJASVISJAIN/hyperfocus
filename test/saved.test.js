import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notebookPath, readSaved, saveQuestion } from '../src/saved.js';

const question = { kind: 'why', q: 'Why retry refreshToken?', options: ['Rate limits', 'Token expiry races'], answer: 1, why: 'Requests race on an expired token.', file: 'src/auth.ts', code: 'await retry(refreshToken, 3)', tags: ['async'] };

test('saved questions pile up in a notebook with the answer, the result, the code and the follow-up', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'hf-saved-')), 'saved.jsonl');
  saveQuestion({ question, chosen: 0, correct: false, thread: [{ ask: 'why 3?', answer: 'Enough to ride out a refresh.' }] }, { cwd: '/work/app', files: ['src/auth.ts'], path, now: new Date('2026-09-30T10:00:00Z') });
  saveQuestion({ question: { ...question, q: 'Second one?' }, chosen: 1, correct: true }, { cwd: '/work/app', path, now: new Date('2026-09-30T10:05:00Z') });
  assert.equal(readSaved({ path, cwd: '/work/app' }).length, 2);
  assert.equal(readSaved({ path, cwd: '/elsewhere' }).length, 0);
  const notebook = readFileSync(notebookPath(path), 'utf8');
  assert.match(notebook, /## app/);
  assert.match(notebook, /### Why retry refreshToken\?/);
  assert.match(notebook, /\*\*A\.\*\* Rate limits ← you/);
  assert.match(notebook, /\*\*B\.\*\* Token expiry races ← answer/);
  assert.match(notebook, /❌ wrong/);
  assert.match(notebook, /await retry\(refreshToken, 3\)/);
  assert.match(notebook, /> \*\*You asked:\*\* why 3\?/);
  assert.match(notebook, /✅ right/);
  assert.ok(notebook.indexOf('Why retry') < notebook.indexOf('Second one?'));
});
