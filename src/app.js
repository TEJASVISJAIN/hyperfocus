import { alertUser } from './alert.js';
import { createAutoSwitch } from './auto-switch.js';
import { focusDelayMs } from './cli-args.js';
import { debugLog } from './debug-log.js';
import { startEventServer } from './event-server.js';
import { createFocusSession } from './focus-session.js';
import { buildHookSettings } from './hook-settings.js';
import { exitCodeFor, startClaudeInPty, takeOverTerminal } from './passthrough.js';
import { buildRecap } from './recap.js';
import { createScreen } from './screen.js';

const TYPING_GRACE_MS = 2000;
const CLOCK_TICK_MS = 1000;

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

  const session = createFocusSession({ claudePath, redraw: () => screen.redrawFocus() });

  const screen = createScreen({
    write,
    claude: child,
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    focusView: { render: (size) => session.view.render(size), handleKey: (key) => session.handleKey(key) },
    onToggleKey: () => {
      const toView = screen.view === 'claude' ? 'focus' : 'claude';
      policy.manualToggle(toView);
      if (toView === 'focus') openFocus();
      else {
        session.view.hideRecap();
        screen.showClaude();
      }
    },
  });

  let lastNeedsInputMessage = '';
  let visit = { openedAt: 0, answeredBefore: 0 };
  const openFocus = () => {
    visit = { openedAt: Date.now(), answeredBefore: session.view.score.answered };
    screen.showFocus();
  };

  // Hand the screen back, first showing what the user missed if they were away for a while.
  const handBack = (reason) => {
    const { score } = session.view;
    const recap = buildRecap({
      run: session.run,
      summary: session.view.summary,
      score,
      visibleMs: Date.now() - visit.openedAt,
      answeredThisVisit: score.answered - visit.answeredBefore,
      reason,
    });
    if (recap) {
      session.view.showRecap(recap, () => screen.showClaude());
      screen.redrawFocus();
    } else {
      screen.showClaude();
    }
    alertUser(reason === 'done' ? 'Claude finished — back to you' : lastNeedsInputMessage || 'Claude needs you', write);
  };

  const policy = createAutoSwitch({
    delayMs: focusDelayMs(),
    typingGraceMs: TYPING_GRACE_MS,
    auto,
    currentView: () => screen.view,
    openFocus,
    returnToClaude: handBack,
  });

  eventServer.events.on('event', (event) => {
    debugLog('event', JSON.stringify(event).slice(0, 300));
    if (event.type === 'needs-input') lastNeedsInputMessage = event.message;
    session.agentEvent(event);
    policy.agentEvent(event);
  });

  // Keeps the elapsed time on the status line moving.
  setInterval(() => screen.redrawFocus(), CLOCK_TICK_MS).unref();

  const restoreTerminal = takeOverTerminal((chunk) => {
    if (screen.view === 'claude') policy.userTyped();
    screen.input(chunk.toString('utf8'));
  });
  stdout.on('resize', () => screen.resize(stdout.columns, stdout.rows));
}
