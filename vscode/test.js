// node vscode/test.js: checks the panel's data against a sample hyperfocus home.
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { summarize } = require('./data');

const home = mkdtempSync(join(tmpdir(), 'hf-vscode-'));
const now = new Date('2026-09-30T12:00:00Z').getTime();
const at = (days) => new Date(now - days * 86_400_000).toISOString();
const q = (question, correct, ts, extra = {}) => ({ ts, cwd: '/work/app', question, options: ['a', 'b'], answer: 1, chosen: correct ? 1 : 0, correct, skipped: false, tags: ['async'], ...extra });
writeFileSync(join(home, 'history.jsonl'), [q('one', true, at(0)), q('two', false, at(1)), q('three', false, at(2)), q('four', true, at(4)), q('rated bad', false, at(0), { rating: 'bad' }), q('other', true, at(0), { cwd: '/work/other' })].map((e) => JSON.stringify(e)).join('\n') + '\nnot json\n');
writeFileSync(join(home, 'saved.jsonl'), JSON.stringify(q('saved one', false, at(0))) + '\n');

const here = summarize({ home, cwd: '/work/app', now });
assert.equal(here.answered, 4);
assert.equal(here.correct, 2);
assert.equal(here.streak, 3); // today, yesterday, two days ago; the gap on day 3 ends it
assert.deepEqual(here.weakSpots.map((t) => [t.tag, t.correct, t.answered]), [['async', 2, 4]]);
assert.deepEqual(here.missed.map((e) => e.question), ['three', 'two']);
assert.equal(here.saved.length, 1);
assert.equal(summarize({ home, cwd: null, now }).answered, 5);
console.log('vscode panel data: ok');
