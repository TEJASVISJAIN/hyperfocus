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
