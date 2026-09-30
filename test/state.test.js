import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readState, updateState } from '../src/state.js';

test('state starts empty, and updates are merged and kept', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'focus-state-')), 'state.json');
  assert.deepEqual(readState({ path }), {});
  updateState({ introSeenAt: '2026-09-30T00:00:00.000Z' }, { path });
  updateState({ other: 1 }, { path });
  assert.deepEqual(readState({ path }), { introSeenAt: '2026-09-30T00:00:00.000Z', other: 1 });
});

test('a damaged state file reads as empty', async () => {
  const { writeFileSync } = await import('node:fs');
  const path = join(mkdtempSync(join(tmpdir(), 'focus-state-')), 'state.json');
  writeFileSync(path, '{nope');
  assert.deepEqual(readState({ path }), {});
});
