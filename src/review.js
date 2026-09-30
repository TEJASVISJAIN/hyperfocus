import { createFocusView } from './focus-view.js';
import { createHistory, missedStillInCode } from './history.js';
import { createQuizEngine } from './quiz-engine.js';
import { CLEAR_AND_HOME, ENTER_ALT_SCREEN, HIDE_CURSOR, KEYS, LEAVE_ALT_SCREEN, MOUSE_OFF, MOUSE_ON, SHOW_CURSOR } from './screen.js';
import { colorAllowed } from './styles.js';
const QUIT_KEYS = new Set(['q', '\x03', '\x1b']);

/**
 * `hyperfocus --review`: asks again the questions you missed in this project, but only those whose
 * code is still there. Questions about changes that were reverted or rewritten never come back.
 */
export async function runReview({ claudePath, config, cwd = process.cwd() }) {
  const due = missedStillInCode({ cwd });
  if (due.length === 0) {
    process.stdout.write('Nothing to review: no missed questions about code that is still in this project.\n');
    return 0;
  }

  const { stdin, stdout } = process;
  const history = createHistory();
  const engine = claudePath ? createQuizEngine({ claudePath, model: config.model }) : null;
  let reviewed = 0;
  let right = 0;

  const view = createFocusView({
    title: 'hyperfocus review',
    backHint: 'q to quit',
    idleText: 'All caught up. Press q to quit.',
    spinner: false,
    summaryHeading: 'Review',
    liveToggle: false,
    color: colorAllowed(),
    onAnswer: (entry) => {
      if (!entry.skipped) {
        reviewed++;
        if (entry.correct) right++;
      }
      history.append(entry, { cwd, sessionId: 'review', files: entry.question.anchor ? [entry.question.anchor.file] : [], source: 'review' });
    },
    onFollowUp: async (request) => {
      const answer = engine ? await engine.askFollowUp(null, request) : null;
      if (answer) view.setFollowUpAnswer(answer, request.question);
      else view.setFollowUpFailed(request.question);
      draw();
    },
  });
  view.setActivity(`${due.length} to review`, Date.now());
  view.setSummary(
    `${due.length} question${due.length === 1 ? '' : 's'} you missed before, about code that is still in this project.`,
  );
  view.addQuestions(due);

  const draw = () => stdout.write(HIDE_CURSOR + CLEAR_AND_HOME + view.render({ cols: stdout.columns || 80, rows: stdout.rows || 24 }));

  return new Promise((resolve) => {
    const finish = () => {
      stdout.write((config.mouse ? MOUSE_OFF : '') + SHOW_CURSOR + LEAVE_ALT_SCREEN);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write(`Reviewed ${reviewed}: ${right} right.\n`);
      resolve(0);
    };
    // However review ends, even by a crash, the shell gets its terminal back with mouse reporting off.
    process.on('exit', () => stdout.write(MOUSE_OFF + SHOW_CURSOR + LEAVE_ALT_SCREEN));
    stdout.write(ENTER_ALT_SCREEN + (config.mouse ? MOUSE_ON : ''));
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', (chunk) => {
      for (const key of chunk.toString('utf8').match(KEYS) ?? []) {
        if (key === '\x03' || (!view.isTyping && QUIT_KEYS.has(key))) return finish();
        view.handleKey(key);
      }
      draw();
    });
    stdout.on('resize', draw);
    draw();
  });
}
