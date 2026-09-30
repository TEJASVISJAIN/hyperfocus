import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { codexAgent, codexEvent, parsePatch } from '../src/agents/codex.js';
import { geminiAgent } from '../src/agents/gemini.js';

test('a Codex patch touching several files becomes one edit per file, with paths from the project', () => {
  const patch = [
    '*** Begin Patch',
    '*** Add File: src/retry.ts',
    '+export async function withRetry(fn) {',
    '+}',
    '*** Update File: src/auth.ts',
    '@@ export async function refresh',
    '-  return fetchToken();',
    '+  return withRetry(fetchToken);',
    '*** Delete File: src/old.ts',
    '*** End Patch',
  ].join('\n');
  assert.deepEqual(parsePatch(patch), [
    { path: 'src/retry.ts', changes: [{ before: '', after: 'export async function withRetry(fn) {\n}' }] },
    { path: 'src/auth.ts', changes: [{ before: '  return fetchToken();', after: '  return withRetry(fetchToken);' }] },
  ]);
  const events = /** @type {any} */ (codexEvent({ hook_event_name: 'PostToolUse', session_id: 's', cwd: '/repo', tool_name: 'apply_patch', tool_input: { command: patch } }));
  assert.deepEqual(events.map((event) => event.path), [join('/repo', 'src/retry.ts'), join('/repo', 'src/auth.ts')]);
});

test("Codex's plan becomes the plan line", () => {
  const event = /** @type {any} */ (codexEvent({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'update_plan', tool_input: { plan: [{ step: 'Add withRetry', status: 'completed' }, { step: 'Use it', status: 'in_progress' }] } }));
  assert.deepEqual(event.todos.map((todo) => [todo.subject, todo.status]), [['Add withRetry', 'completed'], ['Use it', 'in_progress']]);
});

test('Codex runs with a mirror of ~/.codex: the real files stay put, hooks are added to the user\'s own, new files move back', () => {
  const root = mkdtempSync(join(tmpdir(), 'focus-codex-'));
  const real = join(root, 'real');
  mkdirSync(join(real, 'sessions'), { recursive: true });
  writeFileSync(join(real, 'config.toml'), 'model = "o3"\n');
  writeFileSync(join(real, 'hooks.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));
  const mirror = join(root, 'mirror');

  const launch = codexAgent.prepareLaunch({ socketPath: '/tmp/s.sock', env: { CODEX_HOME: real }, home: mirror });
  assert.equal(launch.env.CODEX_HOME, mirror);
  assert.deepEqual(launch.args, ['--enable', 'hooks']);
  assert.ok(lstatSync(join(mirror, 'config.toml')).isSymbolicLink());
  assert.ok(lstatSync(join(mirror, 'sessions')).isSymbolicLink());
  const hooks = JSON.parse(readFileSync(join(mirror, 'hooks.json'), 'utf8')).hooks;
  assert.equal(hooks.Stop[0].hooks[0].command, 'say done', "the user's hook still runs");
  assert.match(hooks.Stop[1].hooks[0].command, /hyperfocus-hook\.js/);
  assert.equal(JSON.parse(readFileSync(join(real, 'hooks.json'), 'utf8')).hooks.Stop.length, 1, "the user's file is unchanged");

  writeFileSync(join(mirror, 'auth.json'), '{"token": "first login"}'); // Codex logging in during the session
  launch.cleanup();
  assert.equal(readFileSync(join(real, 'auth.json'), 'utf8'), '{"token": "first login"}');
  codexAgent.prepareLaunch({ socketPath: '/tmp/s.sock', env: { CODEX_HOME: real }, home: mirror }).cleanup();
  assert.ok(lstatSync(join(mirror, 'auth.json')).isSymbolicLink(), 'and is linked from then on');
});

test("Gemini gets a copy of the system settings with hyperfocus's hooks; the real file is untouched", () => {
  const root = mkdtempSync(join(tmpdir(), 'focus-gemini-'));
  const system = join(root, 'system.json');
  writeFileSync(system, JSON.stringify({ telemetry: { enabled: false }, hooks: { AfterAgent: [{ hooks: [{ type: 'command', command: 'audit' }] }] } }));
  const launch = geminiAgent.prepareLaunch({ socketPath: '/tmp/s.sock', env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system }, home: root });
  const written = JSON.parse(readFileSync(launch.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
  assert.deepEqual(written.telemetry, { enabled: false });
  assert.equal(written.hooks.AfterAgent[0].hooks[0].command, 'audit');
  assert.match(written.hooks.AfterAgent[1].hooks[0].command, /hyperfocus-hook\.js/);
  assert.equal(written.hooks.AfterTool[0].matcher, '.*');
  assert.equal(JSON.parse(readFileSync(system, 'utf8')).hooks.AfterAgent.length, 1);

  writeFileSync(system, '{ not json');
  assert.throws(() => geminiAgent.prepareLaunch({ socketPath: '/tmp/s.sock', env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: system }, home: root }), /left them alone/);
  assert.ok(existsSync(join(root, 'gemini-system-settings.json')));
});
