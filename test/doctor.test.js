import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkNode, checkTerminal, formatDoctor, runDoctor } from '../src/doctor.js';

const focusBin = fileURLToPath(new URL('../bin/hyperfocus.js', import.meta.url));

test('runs every check, and a check that throws is a failure with its message', async () => {
  const results = await runDoctor([
    { name: 'fine', run: async () => ({ status: 'ok', detail: 'all good' }) },
    { name: 'meh', run: () => ({ status: 'warn', detail: 'small', hint: 'make it bigger' }) },
    { name: 'broken', run: () => { throw new Error('exploded'); } },
  ]);
  assert.deepEqual(results.map((result) => [result.name, result.status]), [['fine', 'ok'], ['meh', 'warn'], ['broken', 'fail']]);
  assert.equal(results[2].detail, 'exploded');
  const text = formatDoctor(results);
  assert.match(text, /✔ fine\s+all good/);
  assert.match(text, /! meh\s+small\n\s+→ make it bigger/);
  assert.match(text, /✘ broken\s+exploded/);
  assert.match(text, /1 problem/);
});

test('node 22 or newer is required', () => {
  assert.equal(checkNode('22.3.0').status, 'ok');
  assert.equal(checkNode('20.11.1').status, 'fail');
});

test('the terminal must be interactive; a small one is a warning', () => {
  assert.equal(checkTerminal({ isTTY: true, columns: 120, rows: 40 }, { isTTY: true }).status, 'ok');
  assert.equal(checkTerminal({ isTTY: true, columns: 50, rows: 15 }, { isTTY: true }).status, 'warn');
  assert.equal(checkTerminal({ isTTY: false }, { isTTY: false }).status, 'warn');
});

test('hyperfocus --doctor reports a missing claude and exits 1', async () => {
  const result = await new Promise((resolve) =>
    execFile(process.execPath, [focusBin, '--doctor'], { env: { ...process.env, HYPERFOCUS_CLAUDE_BIN: '/nonexistent/claude', HYPERFOCUS_HOME: mkdtempSync(join(tmpdir(), 'focus-doc-')) } }, (error, stdout) =>
      resolve({ code: error ? error.code : 0, stdout }),
    ),
  );
  assert.equal(result.code, 1);
  assert.match(result.stdout, /✘ claude\s+not found/);
  assert.match(result.stdout, /✔ node/);
  assert.match(result.stdout, /- questions\s+skipped/);
});
