import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { claudeAgent } from '../src/agents/claude.js';
import { createProjectBrief } from '../src/project-brief.js';

const fakeModel = fileURLToPath(new URL('./fixtures/fake-haiku.js', import.meta.url));
const BRIEF = 'A retry library for token refresh. Node ESM, tests with node:test.';

function repo({ git = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hf-brief-repo-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  writeFileSync(join(root, 'README.md'), '# tokenretry\n\nRetries token refresh. Deploy key: sk-ant-abcdefghijklmnopqrstuvwxyz123456\n' + 'filler '.repeat(2000));
  writeFileSync(join(root, 'CLAUDE.md'), 'Use node:test. Keep modules small.\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'tokenretry', type: 'module' }));
  writeFileSync(join(root, '.env'), 'DATABASE_URL=postgres://admin:hunter2hunter2@db/prod\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'retry.js'), 'export const attempts = 3;\n');
  mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '');
  if (git) {
    run('init', '-q');
    run('add', 'README.md', 'CLAUDE.md', 'package.json', 'src');
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'Add exponential backoff to withRetry');
    writeFileSync(join(root, 'src', 'retry.js'), 'export const attempts = 5;\n');
  }
  const commit = (subject) => {
    writeFileSync(join(root, 'src', 'retry.js'), `export const attempts = ${Math.random()};\n`);
    run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', subject);
  };
  return { root, commit };
}

function briefFor(root, { now = Date.now, folder = mkdtempSync(join(tmpdir(), 'hf-brief-cache-')), log = join(mkdtempSync(join(tmpdir(), 'hf-brief-log-')), 'calls.jsonl'), mode = 'fenced' } = {}) {
  const brief = createProjectBrief({
    cwd: root,
    writer: { path: fakeModel, adapter: claudeAgent.writer, model: 'haiku' },
    env: { ...process.env, FAKE_HAIKU_LOG: log, FAKE_HAIKU_MODE: mode },
    folder,
    now,
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { brief, calls, folder, log };
}

test('the brief is written from the README, CLAUDE.md, manifests, the folder tree, recent commits and uncommitted files', async () => {
  const { root } = repo();
  const { brief, calls } = briefFor(root);
  assert.equal(brief.get(), null, 'nothing until it is built');
  await brief.refresh();
  assert.equal(brief.get(), BRIEF);

  const [call] = calls();
  assert.match(call.argv[call.argv.indexOf('--system-prompt') + 1], /project brief/);
  const sent = call.stdin;
  assert.match(sent, /# tokenretry/);
  assert.match(sent, /Keep modules small/);
  assert.match(sent, /"name":"tokenretry"/);
  assert.match(sent, /^src\/retry\.js$/m);
  assert.match(sent, /Add exponential backoff to withRetry/);
  assert.match(sent, /<uncommitted>\n.*src\/retry\.js/);
});

test('the brief stays small, and never carries secrets or sensitive files', async () => {
  const { root } = repo();
  const { brief, calls } = briefFor(root);
  await brief.refresh();
  const sent = calls()[0].stdin;
  assert.ok(sent.length < 12_000, `sent ${sent.length} characters`);
  assert.match(sent, /… \(cut\)/, 'the long README is cut');
  assert.doesNotMatch(sent, /sk-ant-abcdefghij/, 'secrets are redacted');
  assert.doesNotMatch(sent, /hunter2/, '.env is never read');
  assert.doesNotMatch(sent, /^\.env$/m, 'or listed');
  assert.doesNotMatch(sent, /left-pad/, 'dependency folders are left out');
});

test('a second session uses the cached brief until HEAD moves', async () => {
  const { root, commit } = repo();
  const first = briefFor(root);
  await first.brief.refresh();
  assert.equal(first.calls().length, 1);

  const second = briefFor(root, { folder: first.folder, log: first.log });
  await second.brief.refresh();
  assert.equal(second.brief.get(), BRIEF);
  assert.equal(second.calls().length, 1, 'cache hit: no new call');

  commit('Switch to jittered backoff');
  await second.brief.refresh();
  assert.equal(second.calls().length, 2, 'HEAD moved: rebuilt');
  assert.match(second.calls()[1].stdin, /Switch to jittered backoff/);
  await second.brief.refresh();
  assert.equal(second.calls().length, 2, 'and checked again without rebuilding');
});

test('outside git, the brief is kept per folder for a day', async () => {
  const { root } = repo({ git: false });
  let now = Date.parse('2026-10-01T09:00:00Z');
  const first = briefFor(root, { now: () => now });
  await first.brief.refresh();
  assert.doesNotMatch(first.calls()[0].stdin, /recent-commits/);

  now += 3 * 3600_000;
  const later = briefFor(root, { now: () => now, folder: first.folder, log: first.log });
  await later.brief.refresh();
  assert.equal(later.calls().length, 1, 'same day: cached');

  now += 24 * 3600_000;
  const nextDay = briefFor(root, { now: () => now, folder: first.folder, log: first.log });
  await nextDay.brief.refresh();
  assert.equal(nextDay.calls().length, 2, 'a day later: rebuilt');
});

test('a failed build leaves no brief and questions go on without it', async () => {
  const { root } = repo();
  const { brief } = briefFor(root, { mode: 'error' });
  await brief.refresh();
  assert.equal(brief.get(), null);
});

test('two prompts in a row start one build', async () => {
  const { root } = repo();
  const { brief, calls } = briefFor(root);
  await Promise.all([brief.refresh(), brief.refresh()]);
  assert.equal(calls().length, 1);
});
