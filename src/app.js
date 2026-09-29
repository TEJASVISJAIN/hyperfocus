import { debugLog } from './debug-log.js';
import { startEventServer } from './event-server.js';
import { buildHookSettings } from './hook-settings.js';
import { exitCodeFor, startClaudeInPty, takeOverTerminal } from './passthrough.js';
import { createScreen } from './screen.js';

const placeholderFocusView = {
  render: () => 'focus — Claude is working. Press Ctrl-] to go back.',
  handleKey: () => {},
};

export async function runFocus(claudePath, args) {
  const { stdout } = process;
  const eventServer = await startEventServer();
  eventServer.events.on('event', (event) => debugLog('event', JSON.stringify(event).slice(0, 300)));

  const env = { ...process.env, CLAUDE_FOCUS_SOCK: eventServer.socketPath };
  const claudeArgs = ['--settings', JSON.stringify(buildHookSettings()), ...args];

  const child = startClaudeInPty(claudePath, claudeArgs, {
    env,
    onOutput: (data) => screen.claudeOutput(data),
    onExit: (result) => {
      screen.showClaude();
      restoreTerminal();
      eventServer.close();
      process.exit(exitCodeFor(result));
    },
  });

  const screen = createScreen({
    write: (data) => stdout.write(data),
    claude: child,
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    focusView: placeholderFocusView,
    onToggleKey: () => (screen.view === 'claude' ? screen.showFocus() : screen.showClaude()),
  });

  const restoreTerminal = takeOverTerminal((chunk) => screen.input(chunk.toString('utf8')));
  stdout.on('resize', () => screen.resize(stdout.columns, stdout.rows));
}
