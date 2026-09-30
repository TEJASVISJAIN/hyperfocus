import { alertUser } from './alert.js';
import { changedFiles } from './activity-log.js';
import { createAutoSwitch, isInterruptKey } from './auto-switch.js';
import { debugLog } from './debug-log.js';
import { startEventServer } from './event-server.js';
import { createFocusSession } from './focus-session.js';
import { buildHookSettings } from './hook-settings.js';
import { createHistory, recentAccuracy } from './history.js';
import { createRunLog, medianRunMs } from './notes.js';
import { exitCodeFor, startClaudeInPty, takeOverTerminal } from './passthrough.js';
import { buildRecap, reviewChecklist } from './recap.js';
import { createScreen, peekLines } from './screen.js';
import { readState, updateState } from './state.js';

const TYPING_GRACE_MS = 2000;
const CLOCK_TICK_MS = 1000;
const PEEK_LINES = 4;

const SHORT_RUN_MARGIN_MS = 10_000;

// Runs here usually end soon after the quiz would open, so one edit isn't enough to switch for.
const isShortRunProject = (cwd, delayMs) => {
  const median = medianRunMs({ cwd });
  return median !== null && median < delayMs + SHORT_RUN_MARGIN_MS;
};

export async function runFocus(claudePath, claudeArgs, { auto, config }) {
  const { stdout } = process;
  const eventServer = await startEventServer();
  const write = (data) => stdout.write(data);

  const child = startClaudeInPty(claudePath, ['--settings', JSON.stringify(buildHookSettings()), ...claudeArgs], {
    env: { ...process.env, HYPERFOCUS_SOCK: eventServer.socketPath },
    onOutput: (data) => screen.claudeOutput(data),
    onExit: (result) => {
      screen.showClaude();
      restoreTerminal();
      eventServer.close();
      process.exit(exitCodeFor(result));
    },
  });

  const cwd = process.cwd();
  const history = createHistory();
  const runLog = createRunLog();
  const loggedRuns = new WeakSet();
  let sessionId = null;
  const session = createFocusSession({
    claudePath,
    config,
    projectAccuracy: recentAccuracy({ cwd }),
    redraw: () => screen.redrawFocus(),
    onAnswer: (entry, run) => history.append(entry, { cwd, sessionId, files: changedFiles(run) }),
    onBack: () => {
      session.view.hideFinished();
      showRecapOrClaude('done');
    },
    onExit: () => leaveFocus(),
    onQuiet: () => {
      policy.goQuiet();
      leaveFocus();
    },
  });

  // The user chose Claude: like Ctrl-], the focus view stays away until their next prompt.
  const leaveFocus = () => {
    policy.manualToggle('claude');
    session.view.hideRecap();
    session.view.hideFinished();
    screen.showClaude();
  };

  const screen = createScreen({
    write,
    claude: child,
    cols: stdout.columns || 80,
    rows: stdout.rows || 24,
    mouse: config.mouse,
    focusView: {
      render: (size) => {
        if (session.view.liveShown) session.view.setPeek(peekLines(screen.claudeScreenLines(), PEEK_LINES));
        return session.view.render(size);
      },
      handleKey: (key) => session.handleKey(key),
    },
    onToggleKey: () => {
      const toView = screen.view === 'claude' ? 'focus' : 'claude';
      policy.manualToggle(toView);
      if (toView === 'focus') openFocus();
      else leaveFocus();
    },
  });

  let lastNeedsInputMessage = '';
  let visit = { openedAt: 0, answeredBefore: 0 };
  let introPending = !readState().introSeenAt;
  const openFocus = () => {
    if (introPending) {
      introPending = false;
      session.view.showIntro(() => updateState({ introSeenAt: new Date().toISOString() }));
    }
    visit = { openedAt: Date.now(), answeredBefore: session.view.score.answered };
    screen.showFocus();
  };

  // The "while you were away" card, when there is something worth showing; otherwise straight back.
  const showRecapOrClaude = (reason) => {
    const { score } = session.view;
    const recap = buildRecap({
      run: session.run,
      summary: session.view.summary,
      score,
      visibleMs: Date.now() - visit.openedAt,
      answeredThisVisit: score.answered - visit.answeredBefore,
      reason,
      checklist: reviewChecklist(session.missedThisRun, { cwd }),
    });
    if (recap) {
      session.view.showRecap(recap, () => screen.showClaude());
      screen.redrawFocus();
    } else {
      screen.showClaude();
    }
  };

  // Hand the screen back, first showing what the user missed if they were away for a while.
  const handBack = (reason) => {
    // Rung once the screen shows what the user is being called back to.
    const alert = () =>
      alertUser(reason === 'done' ? 'Claude finished — back to you' : lastNeedsInputMessage || 'Claude needs you', write, {
        notify: config.notifications,
      });
    // Mid-question: keep the question and let the user choose to go back or keep going.
    if (session.view.isAtQuestion) {
      session.view.showFinished({ reason, changedFiles: changedFiles(session.run), score: session.view.score });
      screen.redrawFocus();
      return alert();
    }
    showRecapOrClaude(reason);
    alert();
  };

  // Each run once, when it ends, for `hyperfocus --notes`.
  const logRun = () => {
    const { run } = session;
    if (!run || !run.finished || loggedRuns.has(run)) return;
    loggedRuns.add(run);
    runLog.append(run, { cwd, sessionId, summary: session.view.summary });
  };

  const policy = createAutoSwitch({
    delayMs: config.delayMs,
    typingGraceMs: TYPING_GRACE_MS,
    auto: auto && !config.quiet,
    switchOn: config.switchOn,
    shortRuns: isShortRunProject(cwd, config.delayMs),
    currentView: () => screen.view,
    openFocus,
    returnToClaude: handBack,
  });

  eventServer.events.on('event', (event) => {
    debugLog('event', JSON.stringify(event).slice(0, 300));
    sessionId = event.sessionId ?? sessionId;
    if (event.type === 'needs-input') lastNeedsInputMessage = event.message;
    session.agentEvent(event);
    if (event.type === 'done') logRun();
    policy.agentEvent(event);
  });

  // Keeps the elapsed time on the status line moving.
  setInterval(() => screen.redrawFocus(), CLOCK_TICK_MS).unref();

  // However hyperfocus exits, never leave the user on the focus screen with the cursor hidden.
  process.on('exit', () => screen.showClaude());

  const restoreTerminal = takeOverTerminal((chunk) => {
    const key = chunk.toString('utf8');
    if (screen.view === 'claude') {
      policy.userTyped();
      if (isInterruptKey(key)) {
        policy.userInterrupted();
        session.userInterrupted();
        logRun();
      }
    }
    screen.input(key);
  });
  stdout.on('resize', () => screen.resize(stdout.columns, stdout.rows));
}
