import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_AND_HOME = '\x1b[H\x1b[2J';

// Ctrl-] as sent by plain terminals, by the kitty keyboard protocol, and by xterm's
// modifyOtherKeys — Claude Code turns the latter two on, so all three can arrive.
const TOGGLE_KEYS = new Set(['\x1d', '\x1b[93;5u', '\x1b[27;5;93~']);

/**
 * Owns the real terminal and decides whether it shows Claude or the focus view.
 *
 * Normal case: the focus view lives on the alternate screen. Claude's main screen is left
 * untouched underneath, and whatever Claude prints meanwhile is held back and replayed when
 * we return — byte for byte, so Claude's own screen bookkeeping stays correct.
 *
 * If Claude itself was on the alternate screen when we took over, there is nothing underneath
 * to return to, so we repaint Claude's screen from a headless mirror instead.
 */
export function createScreen({ write, claude, cols, rows, focusView, onToggleKey }) {
  const mirror = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const serializer = new SerializeAddon();
  mirror.loadAddon(serializer);

  let view = 'claude';
  let heldBackOutput = [];
  let claudeWasOnAltScreen = false;
  let claudeCursorVisible = true;
  let resizedWhileAway = false;

  function drawFocus() {
    write(HIDE_CURSOR + CLEAR_AND_HOME + focusView.render({ cols: mirror.cols, rows: mirror.rows }));
  }

  return {
    get view() {
      return view;
    },

    claudeOutput(data) {
      mirror.write(data);
      const cursorToggle = data.lastIndexOf('\x1b[?25');
      if (cursorToggle !== -1) claudeCursorVisible = data[cursorToggle + 5] === 'h';
      if (view === 'claude') write(data);
      else heldBackOutput.push(data);
    },

    input(chunk) {
      if (TOGGLE_KEYS.has(chunk)) return onToggleKey();
      if (view === 'claude') claude.write(chunk);
      else focusView.handleKey(chunk);
    },

    showFocus() {
      if (view === 'focus') return;
      view = 'focus';
      claudeWasOnAltScreen = mirror.buffer.active.type === 'alternate';
      resizedWhileAway = false;
      if (!claudeWasOnAltScreen) write(ENTER_ALT_SCREEN);
      drawFocus();
    },

    redrawFocus() {
      if (view === 'focus') drawFocus();
    },

    showClaude() {
      if (view === 'claude') return;
      view = 'claude';
      const cursor = claudeCursorVisible ? SHOW_CURSOR : HIDE_CURSOR;
      if (claudeWasOnAltScreen) {
        write(CLEAR_AND_HOME + serializer.serialize() + cursor);
      } else {
        write(LEAVE_ALT_SCREEN + cursor + heldBackOutput.join(''));
      }
      heldBackOutput = [];
      if (resizedWhileAway) nudgeClaudeToRedraw();
    },

    resize(newCols, newRows) {
      mirror.resize(newCols, newRows);
      claude.resize(newCols, newRows);
      if (view === 'focus') {
        resizedWhileAway = true;
        drawFocus();
      }
    },

    dispose() {
      mirror.dispose();
    },
  };

  // Output replayed after a resize was laid out for the old size; a resize round-trip makes
  // Claude Code re-render everything for the current one.
  function nudgeClaudeToRedraw() {
    claude.resize(mirror.cols, Math.max(1, mirror.rows - 1));
    setTimeout(() => claude.resize(mirror.cols, mirror.rows), 50);
  }
}
