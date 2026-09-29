import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEYS, createScreen, peekLines } from '../src/screen.js';

test('keys are split one per piece, arrows in either cursor mode staying whole', () => {
  assert.deepEqual('a\x1b[B\x1bOAj\r'.match(KEYS), ['a', '\x1b[B', '\x1bOA', 'j', '\r']);
});

const rule = '─'.repeat(100);
const claudeScreen = [
  '▗ ▗   ▖ ▖  Claude Code v2.1.285',
  '',
  '❯ Read package.json and tell me the version',
  '',
  '⏺ Reading 1 file… (ctrl+o to expand)',
  '  ⎿  package.json',
  '',
  '✢ Beaming… (2s · ↓ 134 tokens · thinking)',
  '',
  rule,
  '❯ ',
  rule,
  '  ⏸ manual mode on · esc to interrupt',
  '',
  '',
];

test("the peek is the last lines above Claude's input box", () => {
  assert.deepEqual(peekLines(claudeScreen, 3), ['⏺ Reading 1 file… (ctrl+o to expand)', '  ⎿  package.json', '✢ Beaming… (2s · ↓ 134 tokens · thinking)']);
});

test('without an input box on screen, the peek is the last lines with anything on them', () => {
  assert.deepEqual(peekLines(['a', '', 'b', 'c', '', ''], 2), ['b', 'c']);
});

function setup({ mouse = true } = {}) {
  const written = [];
  const claude = { write: () => {}, resize: () => {} };
  const screen = createScreen({
    write: (data) => written.push(data),
    claude,
    cols: 40,
    rows: 10,
    mouse,
    focusView: { render: () => 'focus', handleKey: () => {} },
    onToggleKey: () => {},
  });
  return { screen, output: () => written.join(''), clear: () => (written.length = 0) };
}

test('the focus view turns on mouse clicks, and turns them off again for Claude', () => {
  const { screen, output, clear } = setup();
  screen.showFocus();
  assert.match(output(), /\x1b\[\?1000h\x1b\[\?1006h/);
  clear();
  screen.showClaude();
  assert.match(output(), /\x1b\[\?1000l\x1b\[\?1006l/);
  screen.dispose();
});

test("Claude's own mouse modes are restored on the way back", () => {
  const { screen, output, clear } = setup();
  screen.claudeOutput('\x1b[?1002;1006h');
  screen.showFocus();
  clear();
  screen.showClaude();
  assert.match(output(), /\x1b\[\?1000l\x1b\[\?1006l.*\x1b\[\?1002h\x1b\[\?1006h/s);
  screen.dispose();
});

test('with mouse clicks turned off in the config, mouse modes are left alone', () => {
  const { screen, output } = setup({ mouse: false });
  screen.showFocus();
  screen.showClaude();
  assert.doesNotMatch(output(), /\x1b\[\?100[06]/);
  screen.dispose();
});
