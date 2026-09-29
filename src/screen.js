import xtermHeadless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';

const { Terminal } = xtermHeadless;
const { SerializeAddon } = serializeAddon;

export const ENTER_ALT_SCREEN = '\x1b[?1049h';
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';
export const CLEAR_AND_HOME = '\x1b[H\x1b[2J';
// Terminals that support it paint the whole frame at once instead of flickering line by line.
const BEGIN_FRAME = '\x1b[?2026h';
const END_FRAME = '\x1b[?2026l';

// Ctrl-] as sent by plain terminals, by the kitty keyboard protocol, and by xterm's
// modifyOtherKeys — Claude Code turns the latter two on, so all three can arrive.
const TOGGLE_KEY = /\x1d|\x1b\[93;5u|\x1b\[27;5;93~/;
// One key per piece: escape sequences (arrows, including application-mode ESC O A, function keys)
// stay whole, everything else is one character.
export const KEYS = /\x1b\[M[\s\S]{3}|\x1b\[[0-9;?<]*[\x40-\x7e]|\x1bO[A-Za-z]|\x1b.|[\s\S]/gu;

const ALT_SCREEN_SWITCH = /\x1b\[\?(?:1049|1047|47)([hl])/g;
// Mouse reporting: the focus view wants clicks (1000) in SGR form (1006); Claude may use its own.
export const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
export const MOUSE_OFF = '\x1b[?1000l\x1b[?1006l';
const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
const MOUSE_MODES = new Set(['9', '1000', '1002', '1003', '1005', '1006', '1015', '1016']);
// Claude Code draws its input box between two full-width rules.
const RULE_LINE = /^─{20,}\s*$/;

/**
 * The last `count` non-empty lines of Claude's screen above its input box: what Claude is saying
 * and doing right now, without the box and the footer under it.
 */
export function peekLines(screenLines, count) {
  const rules = screenLines.flatMap((line, index) => (RULE_LINE.test(line) ? [index] : []));
  const end = rules.length >= 2 ? rules.at(-2) : screenLines.length;
  return screenLines.slice(0, end).filter((line) => line.trim()).slice(-count);
}
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
export function createScreen({ write, claude, cols, rows, focusView, onToggleKey, mouse = false }) {
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
  const claudeMouseModes = new Set();

  // Clicks are only for the focus view: hand Claude back exactly the mouse modes it asked for.
  const mouseForClaude = () => (mouse ? MOUSE_OFF + [...claudeMouseModes].map((mode) => `\x1b[?${mode}h`).join('') : '');

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
    for (const [, modes, action] of data.matchAll(PRIVATE_MODES)) {
      for (const mode of modes.split(';')) {
        if (!MOUSE_MODES.has(mode)) continue;
        if (action === 'h') claudeMouseModes.add(mode);
        else claudeMouseModes.delete(mode);
      }
    }
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
      write(frame + mouseForClaude() + (claudeCursorVisible ? SHOW_CURSOR : HIDE_CURSOR) + heldBackOutput.join(''));
      clearHeldBack();
      mustRepaint = false;
      nudgeClaudeToRedraw();
    });
  }

  return {
    get view() {
      return view;
    },

    /** Claude's current screen as plain text lines, as far as the mirror has parsed it. */
    claudeScreenLines() {
      const buffer = mirror.buffer.active;
      const lines = [];
      for (let row = 0; row < mirror.rows; row++) lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '');
      return lines;
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
      if (mouse) write(MOUSE_ON);
      drawFocus();
    },

    redrawFocus() {
      if (view === 'focus') drawFocus();
    },

    showClaude() {
      if (view === 'claude') return;
      view = 'claude';
      if (claudeWasOnAltScreen || mustRepaint) return repaintClaude();
      write(LEAVE_ALT_SCREEN + mouseForClaude() + (claudeCursorVisible ? SHOW_CURSOR : HIDE_CURSOR) + heldBackOutput.join(''));
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
