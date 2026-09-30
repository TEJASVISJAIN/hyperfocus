import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_CONFIG, loadConfig, setProjectSetting } from '../src/config.js';

function configFile(contents) {
  const path = join(mkdtempSync(join(tmpdir(), 'focus-config-')), 'config.json');
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

test('without a config file, the defaults apply', () => {
  const { config, problems } = loadConfig({ path: '/nonexistent/config.json', env: {} });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.deepEqual(problems, []);
  assert.deepEqual(DEFAULT_CONFIG, {
    delayMs: 8000,
    model: 'haiku',
    questionsPerBatch: 3,
    kinds: ['why', 'bug', 'output', 'predict'],
    notifications: true,
    mouse: true,
    live: false,
    switchOn: 'edit',
    quiet: false,
  });
});

test('settings in the file override the defaults', () => {
  const path = configFile({ delayMs: 3000, model: 'sonnet', questionsPerBatch: 2, kinds: ['why', 'bug'], notifications: false, live: true });
  const { config, problems } = loadConfig({ path, env: {} });
  assert.deepEqual(problems, []);
  assert.equal(config.delayMs, 3000);
  assert.equal(config.model, 'sonnet');
  assert.equal(config.questionsPerBatch, 2);
  assert.deepEqual(config.kinds, ['why', 'bug']);
  assert.equal(config.notifications, false);
  assert.equal(config.live, true);
  assert.equal(config.mouse, true, 'unset keys keep their default');
});

test('bad values are reported and ignored, the rest still applies', () => {
  const path = configFile({ delayMs: -5, questionsPerBatch: 12, kinds: ['why', 'riddles'], mouse: 'yes', model: '', typo: 1, live: true });
  const { config, problems } = loadConfig({ path, env: {} });
  assert.equal(config.delayMs, 8000);
  assert.equal(config.questionsPerBatch, 3);
  assert.deepEqual(config.kinds, ['why'], 'unknown kinds are dropped');
  assert.equal(config.mouse, true);
  assert.equal(config.model, 'haiku');
  assert.equal(config.live, true);
  assert.equal(problems.length, 6);
  assert.ok(problems.some((problem) => /typo/.test(problem) && /unknown/.test(problem)));
  assert.ok(problems.some((problem) => /riddles/.test(problem)));
});

test('a file that is not JSON is reported and the defaults apply', () => {
  const { config, problems } = loadConfig({ path: configFile('{ delayMs: 3 '), env: {} });
  assert.deepEqual(config, DEFAULT_CONFIG);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /not valid JSON/);
});

test('HYPERFOCUS_DELAY_MS still wins over the file', () => {
  const path = configFile({ delayMs: 3000 });
  assert.equal(loadConfig({ path, env: { HYPERFOCUS_DELAY_MS: '100' } }).config.delayMs, 100);
  assert.equal(loadConfig({ path, env: { HYPERFOCUS_DELAY_MS: '' } }).config.delayMs, 3000);
  assert.equal(loadConfig({ path, env: { HYPERFOCUS_DELAY_MS: 'soon' } }).config.delayMs, 3000);
});

test('HYPERFOCUS_CONFIG points at a different file', () => {
  const path = configFile({ model: 'opus' });
  assert.equal(loadConfig({ env: { HYPERFOCUS_CONFIG: path } }).config.model, 'opus');
});

test('an empty kinds list and a file that is not an object are reported', () => {
  assert.equal(loadConfig({ path: configFile({ kinds: [] }), env: {} }).problems.length, 1);
  for (const contents of ['null', '[]', '"x"']) {
    const { config, problems } = loadConfig({ path: configFile(contents), env: {} });
    assert.deepEqual(config, DEFAULT_CONFIG);
    assert.equal(problems.length, 1, contents);
  }
});

test('switchOn is "edit" by default and accepts "busy"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-config-'));
  const path = join(dir, 'config.json');
  assert.equal(loadConfig({ path, env: {} }).config.switchOn, 'edit');
  writeFileSync(path, JSON.stringify({ switchOn: 'busy' }));
  assert.equal(loadConfig({ path, env: {} }).config.switchOn, 'busy');
  writeFileSync(path, JSON.stringify({ switchOn: 'soon' }));
  const { config, problems } = loadConfig({ path, env: {} });
  assert.equal(config.switchOn, 'edit');
  assert.match(problems[0], /"switchOn" must be "edit" or "busy"/);
});

test('a project can override settings, and bad project settings are reported', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ delayMs: 5000, projects: { '/repo': { quiet: true, delayMs: 'soon' }, '/other': { quiet: false } } }));
  const { config, problems } = loadConfig({ path, env: {}, cwd: '/repo' });
  assert.equal(config.quiet, true);
  assert.equal(config.delayMs, 5000, 'the bad project value falls back to the global one');
  assert.match(problems.join('\n'), /\/repo.*"delayMs"/);
  assert.equal(loadConfig({ path, env: {}, cwd: '/elsewhere' }).config.quiet, false);
});

test('setting a project option keeps the rest of the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'focus-config-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ model: 'sonnet', projects: { '/other': { quiet: false } } }));
  setProjectSetting('/repo', 'quiet', true, { path });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { model: 'sonnet', projects: { '/other': { quiet: false }, '/repo': { quiet: true } } });
  const fresh = join(dir, 'nested', 'config.json');
  setProjectSetting('/repo', 'quiet', true, { path: fresh });
  assert.deepEqual(JSON.parse(readFileSync(fresh, 'utf8')), { projects: { '/repo': { quiet: true } } });
});
