import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_AND_HOME = '\x1b[H\x1b[2J';
// Terminals that support it paint the whole frame at once instead of flickering line by line.
const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';

// Ctrl-] as sent by plain terminals, by the kitty keyboard protocol, and by xterm's
// modifyOtherKeys — Claude Code turns the latter two on, so all three can arrive.
const TOGGLE_KEY = /\x1d|\x1b\[93;5u|\x1b\[27;5;93~/;
// One key per piece: escape sequences (arrows, function keys) stay whole, everything else is one character.
const KEYS = /\x1b\[M[\s\S]{3}|\x1b\[[0-9;?<]*[\x40-\x7e]|\x1b.|[\s\S]/gu;

const ALT_SCREEN_SWITCH = /\x1b\[\?(?:1049|1047|47)([hl])/g;
// Past this, replaying what Claude drew while away costs more than repainting its current screen
// (Claude Code redraws its spinner many times a second, so long runs add up fast).
const MAX_HELD_BACK_CHARS = 1_000_000;

/**
 * Owns the real terminal and decides whether it shows Claude or the focus view.
 *
 * Normal case: the focus view lives on the alternate screen. Claude's main screen is left
 * untouched underneath, and whatever Claude prints meanwhile is held back and replayed when
 * we return — byte for byte, so Claude's own screen bookkeeping stays correct.
 *
 * When replaying isn't possible — Claude was on its own alternate screen when we took over, or it
 * printed too much while away — we repaint Claude's current screen from a headless mirror instead.
 */
export function createScreen({ write, claude, cols, rows, focusView, onToggleKey }) {
  const mirror = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 0 });
  const serializer = new SerializeAddon();
  mirror.loadAddon(serializer);

  let view = 'claude';
  let heldBackOutput = [];
  let heldBackChars = 0;
  let mustRepaint = false;
  let repainting = false;
  // Tracked from Claude's output as it arrives: the mirror parses asynchronously, so its own
  // state can lag behind what Claude has already sent.
  let claudeOnAltScreen = false;
  let claudeWasOnAltScreen = false;
  let claudeCursorVisible = true;
  let resizedWhileAway = false;

  function drawFocus() {
    write(BEGIN_FRAME + HIDE_CURSOR + CLEAR_AND_HOME + focusView.render({ cols: mirror.cols, rows: mirror.rows }) + END_FRAME);
  }

  function holdBack(data) {
    if (mustRepaint) return;
    heldBackOutput.push(data);
    heldBackChars += data.length;
    if (heldBackChars > MAX_HELD_BACK_CHARS) {
      mustRepaint = true;
      clearHeldBack();
    }
  }

  function clearHeldBack() {
    heldBackOutput = [];
    heldBackChars = 0;
  }

  function trackTerminalModes(data) {
    for (const [, mode] of data.matchAll(ALT_SCREEN_SWITCH)) claudeOnAltScreen = mode === 'h';
    const cursorToggle = data.lastIndexOf('\x1b[?25');
    if (cursorToggle !== -1) claudeCursorVisible = data[cursorToggle + 5] === 'h';
  }

  // Draws Claude's current screen from the mirror, once the mirror has parsed everything so far.
  function repaintClaude() {
    repainting = true;
    clearHeldBack();
    mirror.write('', () => {
      repainting = false;
      if (view !== 'claude') return void (mustRepaint = true);
      const serialized = serializer.serialize();
      const altStart = serialized.indexOf(ENTER_ALT_SCREEN);
      const frame = claudeOnAltScreen
        ? CLEAR_AND_HOME + (altStart === -1 ? serialized : serialized.slice(altStart + ENTER_ALT_SCREEN.length))
        : LEAVE_ALT_SCREEN + CLEAR_AND_HOME + serializer.serialize({ excludeAltBuffer: true });
      write(frame + (claudeCursorVisible ? SHOW_CURSOR : HIDE_CURSOR) + heldBackOutput.join(''));
      clearHeldBack();
      mustRepaint = false;
      nudgeClaudeToRedraw();
    });
  }

  return {
    get view() {
      return view;
    },

    claudeOutput(data) {
      mirror.write(data);
      trackTerminalModes(data);
      if (view === 'claude' && !repainting) write(data);
      else holdBack(data);
    },

    input(chunk) {
      // Fast typing and pastes can put Ctrl-] in the middle of a chunk, so split around it.
      const toggle = chunk.match(TOGGLE_KEY);
      const before = toggle ? chunk.slice(0, toggle.index) : chunk;
      if (before) {
        if (view === 'claude') claude.write(before);
        else for (const key of before.match(KEYS)) focusView.handleKey(key);
      }
      if (!toggle) return;
      onToggleKey();
      this.input(chunk.slice(toggle.index + toggle[0].length));
    },

    showFocus() {
      if (view === 'focus') return;
      view = 'focus';
      // Back again before a repaint landed: the real terminal never left the focus screen.
      if (!repainting) {
        claudeWasOnAltScreen = claudeOnAltScreen;
        resizedWhileAway = false;
        clearHeldBack();
        if (!claudeWasOnAltScreen) write(ENTER_ALT_SCREEN);
      }
      drawFocus();
    },

    redrawFocus() {
      if (view === 'focus') drawFocus();
    },

    showClaude() {
      if (view === 'claude') return;
      view = 'claude';
      if (claudeWasOnAltScreen || mustRepaint) return repaintClaude();
      write(LEAVE_ALT_SCREEN + (claudeCursorVisible ? SHOW_CURSOR : HIDE_CURSOR) + heldBackOutput.join(''));
      clearHeldBack();
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

  // Output replayed after a resize was laid out for the old size, and a repaint only restores what
  // the mirror knows; a resize round-trip makes Claude Code re-render everything itself.
  function nudgeClaudeToRedraw() {
    claude.resize(mirror.cols, Math.max(1, mirror.rows - 1));
    setTimeout(() => claude.resize(mirror.cols, mirror.rows), 50);
  }
}
