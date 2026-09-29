import { alertUser } from './alert.js';
import { createAutoSwitch } from './auto-switch.js';
import { focusDelayMs } from './cli-args.js';
import { debugLog } from './debug-log.js';
import { startEventServer } from './event-server.js';
import { buildHookSettings } from './hook-settings.js';
import { exitCodeFor, startClaudeInPty, takeOverTerminal } from './passthrough.js';
import { createScreen } from './screen.js';

const TYPING_GRACE_MS = 2000;

const placeholderFocusView = {
  render: () => 'focus — Claude is working. Press Ctrl-] to go back.',
  handleKey: () => {},
};

export async function runFocus(claudePath, claudeArgs, { auto }) {
  const { stdout } = process;
  const eventServer = await startEventServer();
  const write = (data) => stdout.write(data);

  const child = startClaudeInPty(claudePath, ['--settings', JSON.stringify(buildHookSettings()), ...claudeArgs], {
    env: { ...process.env, CLAUDE_FOCUS_SOCK: eventServer.socketPath },
    onOutput: (data) => screen.claudeOutput(data),
    onExit: (result) => {
      screen.showClaude();
      restoreTerminal();
      eventServer.close();
      process.exit(exitCodeFor(result));
    },
  });

  const screen = createScreen({
    write,
    claude: child,
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    focusView: placeholderFocusView,
    onToggleKey: () => {
      const toView = screen.view === 'claude' ? 'focus' : 'claude';
      policy.manualToggle(toView);
      if (toView === 'focus') screen.showFocus();
      else screen.showClaude();
    },
  });

  let lastNeedsInputMessage = '';
  const policy = createAutoSwitch({
    delayMs: focusDelayMs(),
    typingGraceMs: TYPING_GRACE_MS,
    auto,
    currentView: () => screen.view,
    openFocus: () => screen.showFocus(),
    returnToClaude: (reason) => {
      screen.showClaude();
      alertUser(reason === 'done' ? 'Claude finished — back to you' : lastNeedsInputMessage || 'Claude needs you', write);
    },
  });

  eventServer.events.on('event', (event) => {
    debugLog('event', JSON.stringify(event).slice(0, 300));
    if (event.type === 'needs-input') lastNeedsInputMessage = event.message;
    policy.agentEvent(event);
  });

  const restoreTerminal = takeOverTerminal((chunk) => {
    if (screen.view === 'claude') policy.userTyped();
    screen.input(chunk.toString('utf8'));
  });
  stdout.on('resize', () => screen.resize(stdout.columns, stdout.rows));
}
