import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatBrief, installHook, uninstallHook } from '../src/git-hook.js';

const repo = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'focus-git-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
};

test('installs a pre-push hook that runs the brief review and never fails the push', () => {
  const cwd = repo();
  const result = installHook({ cwd });
  const path = join(cwd, '.git', 'hooks', 'pre-push');
  assert.equal(result.path, path);
  const script = readFileSync(path, 'utf8');
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.match(script, /hyperfocus --review --brief/);
  assert.ok(statSync(path).mode & 0o100, 'executable');
  execFileSync('sh', [path], { cwd, env: { ...process.env, PATH: '/usr/bin:/bin' } }); // hyperfocus not installed: still exits 0
  assert.equal(installHook({ cwd }).alreadyInstalled, true, 'installing twice adds nothing');
  assert.equal(readFileSync(path, 'utf8'), script);
});

test('appends to an existing hook, keeps its exit status, and uninstalls only its own block', () => {
  const cwd = repo();
  const path = join(cwd, '.git', 'hooks', 'pre-push');
  const existing = '#!/bin/sh\necho checking\nfalse\n';
  writeFileSync(path, existing, { mode: 0o755 });
  installHook({ cwd });
  assert.throws(() => execFileSync('sh', [path], { cwd, stdio: 'ignore' }), 'the existing hook still fails the push');
  uninstallHook({ cwd });
  assert.equal(readFileSync(path, 'utf8'), existing);
});

test('uninstalling a hook that only hyperfocus wrote removes the file; core.hooksPath is honoured', () => {
  const cwd = repo();
  execFileSync('git', ['config', 'core.hooksPath', 'my-hooks'], { cwd });
  const { path } = installHook({ cwd });
  assert.equal(path, join(cwd, 'my-hooks', 'pre-push'));
  assert.equal(uninstallHook({ cwd }).removed, true);
  assert.equal(existsSync(path), false);
});

test('outside a git repository it refuses', () => {
  assert.throws(() => installHook({ cwd: mkdtempSync(join(tmpdir(), 'focus-nogit-')) }), /not a git repository/);
});

test('the brief review fits a screen and says nothing when there is nothing to say', () => {
  const due = Array.from({ length: 12 }, (_, index) => ({ q: `Question ${index}?`, options: ['right', 'wrong'], answer: 0, why: '', anchor: { file: 'src/a.ts', anchors: [] } }));
  const text = formatBrief(due);
  assert.match(text, /^hyperfocus: 12 questions you missed are about code that is still here/);
  assert.match(text, /src\/a.ts: Question 0\? — right/);
  assert.match(text, /and 4 more: hyperfocus --review/);
  assert.ok(text.split('\n').length <= 12);
  assert.equal(formatBrief([]), '');
});

test('a block whose end marker was edited away is left alone, with a clear message', () => {
  const cwd = repo();
  const { path } = installHook({ cwd });
  const damaged = readFileSync(path, 'utf8').replace(/# <<< hyperfocus <<<\n/, '');
  writeFileSync(path, damaged);
  assert.throws(() => uninstallHook({ cwd }), /no end marker/);
  assert.equal(readFileSync(path, 'utf8'), damaged);
});
