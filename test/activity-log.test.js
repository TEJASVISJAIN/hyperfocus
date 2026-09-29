import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createActivityLog } from '../src/activity-log.js';
import { toFocusEvent } from '../src/hook-events.js';

const recordedPayloads = JSON.parse(readFileSync(new URL('./fixtures/hook-payloads.json', import.meta.url), 'utf8'));

function replay(payloads, log = createActivityLog({ cwd: '/repo' })) {
  for (const payload of payloads) {
    const event = toFocusEvent(payload);
    if (event) log.record(event);
  }
  return log;
}

test('a run collects the prompt, what was read, what changed and what was run', () => {
  const run = replay(recordedPayloads).run;
  assert.equal(run.prompt, 'add retry to token refresh');
  assert.deepEqual(run.reads, ['src/auth.ts', 'grep "refreshToken" in /repo/src']);
  assert.deepEqual(run.edits.map((edit) => edit.path), ['src/auth.ts', 'src/retry.ts']);
  assert.deepEqual(run.commands, ['npm test -- auth']);
  assert.equal(run.finished, true);
});

test('edits read as a diff of removed and added lines', () => {
  const [authEdit, newFile] = replay(recordedPayloads).run.edits;
  assert.equal(
    authEdit.diff,
    [
      '- export async function refreshToken() {',
      '-   return fetchToken();',
      '- }',
      '+ export async function refreshToken() {',
      '+   return withRetry(fetchToken, { attempts: 3 });',
      '+ }',
    ].join('\n'),
  );
  assert.match(newFile.diff, /^\+ export async function withRetry/);
  assert.doesNotMatch(newFile.diff, /^- /m, 'a new file has nothing removed');
});

test('a new prompt starts a new run and keeps the previous one', () => {
  const log = replay(recordedPayloads);
  replay([{ hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: 'now add a test' }], log);
  assert.equal(log.run.prompt, 'now add a test');
  assert.deepEqual(log.run.edits, []);
  assert.equal(log.run.finished, false);
  assert.equal(log.previousRun.prompt, 'add retry to token refresh');
});

test('huge edits are truncated so model calls stay small', () => {
  const huge = 'x'.repeat(10_000);
  const run = replay([
    { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'p' },
    { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Write', tool_input: { file_path: '/repo/big.txt', content: huge } },
  ]).run;
  assert.ok(run.edits[0].diff.length <= 4100, `diff is ${run.edits[0].diff.length} chars`);
  assert.match(run.edits[0].diff, /truncated/);
});

test('a long run keeps the most recent changes within the budget', () => {
  /** @type {object[]} */
  const payloads = [{ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'p' }];
  for (let index = 0; index < 12; index++) {
    payloads.push({
      hook_event_name: 'PostToolUse',
      session_id: 's',
      tool_name: 'Write',
      tool_input: { file_path: `/repo/file${index}.txt`, content: `${index}`.repeat(3000) },
    });
  }
  const run = replay(payloads).run;
  const totalDiff = run.edits.reduce((sum, edit) => sum + edit.diff.length, 0);
  assert.ok(totalDiff <= 20_000, `total diff is ${totalDiff} chars`);
  assert.equal(run.edits.length, 12, 'every edited file is still listed');
  assert.match(run.edits[11].diff, /^\+ 111/, 'the latest change is kept in full');
  assert.match(run.edits[0].diff, /omitted/, 'the oldest change is dropped first');
});

test('activity before any prompt (e.g. a resumed session) still starts a run', () => {
  const run = replay([{ hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/elsewhere/x.ts' } }]).run;
  assert.equal(run.prompt, '');
  assert.deepEqual(run.reads, ['/elsewhere/x.ts']);
});

test('the idle reminder or a repeated Stop after a run finishes leaves that run in place', () => {
  const log = replay(recordedPayloads);
  replay(
    [
      { hook_event_name: 'Notification', session_id: 's1', message: 'Claude is waiting for your input' },
      { hook_event_name: 'Stop', session_id: 's1' },
    ],
    log,
  );
  assert.equal(log.run.prompt, 'add retry to token refresh');
  assert.equal(log.run.edits.length, 2);
  assert.equal(log.previousRun, null);
});

const event = (type, fields = {}) => ({ type, sessionId: 's', ...fields });

test('a timeline keeps what the agent did, in order, for the live feed', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('busy', { prompt: 'retry' }));
  log.record(event('read', { target: '/repo/src/auth.ts' }));
  log.record(event('edit', { path: '/repo/src/auth.ts', changes: [{ before: 'a\nb', after: 'a\nb\nc' }] }));
  log.record(event('command', { command: 'npm test\n  --watch=false' }));
  log.record(event('subagent', { description: 'Find callers' }));
  assert.deepEqual(log.run.timeline, [
    { kind: 'read', text: 'src/auth.ts' },
    { kind: 'edit', text: 'src/auth.ts', added: 3, removed: 2 },
    { kind: 'command', text: 'npm test' },
    { kind: 'subagent', text: 'Find callers' },
  ]);
});

test('the timeline keeps only the latest 30 steps', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('busy', { prompt: 'x' }));
  for (let index = 0; index < 40; index++) log.record(event('command', { command: `step ${index}` }));
  assert.equal(log.run.timeline.length, 30);
  assert.equal(log.run.timeline.at(-1).text, 'step 39');
});

test("Claude's task list gives the run's progress, across prompts", () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('busy', { prompt: 'x' }));
  log.record(event('task-create', { id: '1', subject: 'Write hello', activeForm: 'Writing hello' }));
  log.record(event('task-create', { id: '2', subject: 'Write bye', activeForm: 'Writing bye' }));
  assert.deepEqual(log.progress, { done: 0, total: 2, current: null });
  log.record(event('task-update', { id: '1', status: 'in_progress', subject: null, activeForm: null }));
  assert.deepEqual(log.progress, { done: 0, total: 2, current: 'Writing hello' });
  log.record(event('task-update', { id: '1', status: 'completed', subject: null, activeForm: null }));
  log.record(event('busy', { prompt: 'next prompt' }));
  log.record(event('task-update', { id: '2', status: 'in_progress', subject: 'Write goodbye', activeForm: 'Writing goodbye' }));
  assert.deepEqual(log.progress, { done: 1, total: 2, current: 'Writing goodbye' });
});

test('deleted tasks leave the plan, and a finished plan shows no progress', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('task-create', { id: '1', subject: 'A', activeForm: 'Doing A' }));
  log.record(event('task-create', { id: '2', subject: 'B', activeForm: 'Doing B' }));
  log.record(event('task-update', { id: '2', status: 'deleted', subject: null, activeForm: null }));
  assert.deepEqual(log.progress, { done: 0, total: 1, current: null });
  log.record(event('task-update', { id: '1', status: 'completed', subject: null, activeForm: null }));
  assert.equal(log.progress, null);
});

test('TodoWrite replaces the plan wholesale', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('task-create', { id: '1', subject: 'Old', activeForm: 'Old' }));
  log.record(event('todos', { todos: [{ subject: 'A', status: 'completed', activeForm: 'Doing A' }, { subject: 'B', status: 'in_progress', activeForm: 'Doing B' }] }));
  assert.deepEqual(log.progress, { done: 1, total: 2, current: 'Doing B' });
});

test('each edit remembers the lines it added, so later checks can tell if it survived', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('edit', { path: '/repo/src/retry.ts', changes: [{ before: '', after: 'export const attempts = computeAttempts(config);' }] }));
  assert.deepEqual(log.run.edits[0].anchors, ['export const attempts = computeAttempts(config);']);
});

test('secrets in diffs and commands are redacted before anything sees them', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('edit', { path: '/repo/src/config.ts', changes: [{ before: '', after: 'const apiKey = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";\nconst region = "eu";' }] }));
  log.record(event('command', { command: 'curl -H "Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123456789" https://api.github.com' }));
  const { edits, commands } = log.run;
  assert.doesNotMatch(edits[0].diff, /sk-ant/);
  assert.match(edits[0].diff, /\[redacted\]/);
  assert.match(edits[0].diff, /const region = "eu";/);
  assert.doesNotMatch(commands[0], /ghp_/);
});

test('files that hold secrets keep their name but never their contents', () => {
  const log = createActivityLog({ cwd: '/repo' });
  for (const path of ['/repo/.env', '/repo/.env.local', '/repo/certs/server.pem', '/repo/.npmrc', '/home/me/.ssh/id_ed25519']) {
    log.record(event('edit', { path, changes: [{ before: '', after: 'SECRET_VALUE=hunter2hunter2' }] }));
  }
  for (const edit of log.run.edits) {
    assert.equal(edit.diff, '(contents hidden: this file usually holds secrets)');
    assert.deepEqual(edit.anchors, []);
  }
});

test("a subagent finishing after Claude's Stop (its prompt suggestions) does not start a new run", () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('busy', { prompt: 'x' }));
  log.record(event('edit', { path: '/repo/a.ts', changes: [{ before: '', after: 'const a = computeSomething(1);' }] }));
  log.record(event('done'));
  const finishedRun = log.run;
  log.record(event('subagent-done'));
  assert.equal(log.run, finishedRun);
  assert.equal(log.run.finished, true);
});

test('secrets in the prompt are redacted too', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record(event('busy', { prompt: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for this' }));
  assert.doesNotMatch(log.run.prompt, /sk-ant/);
});

test('a new Claude session (after /clear) starts with no plan', () => {
  const log = createActivityLog({ cwd: '/repo' });
  log.record({ type: 'task-create', sessionId: 'a', id: '1', subject: 'A', activeForm: 'Doing A' });
  assert.ok(log.progress);
  log.record({ type: 'busy', sessionId: 'b', prompt: 'something else' });
  assert.equal(log.progress, null);
});

test('a huge diff is cut at a line boundary, so no half line becomes an anchor', () => {
  const log = createActivityLog({ cwd: '/repo' });
  const content = Array.from({ length: 400 }, (_, index) => `export const value${index} = computeValue(${index});`).join('\n');
  log.record(event('edit', { path: '/repo/big.ts', changes: [{ before: '', after: content }] }));
  const lines = log.run.edits[0].diff.split('\n');
  assert.equal(lines.at(-1), '… (truncated)');
  assert.match(lines.at(-2), /^\+ export const value\d+ = computeValue\(\d+\);$/);
});
