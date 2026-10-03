import { claudeAgent } from './agents/claude.js';
import { createHistory } from './history.js';
import { startBridge } from './bridge.js';
import { createFocusSession } from './focus-session.js';

const POLL_MS = 100;
const NO_QUESTION_MS = 120_000;

/**
 * A unified diff (`git diff --cached`) as hyperfocus edit events: one per file, one change per hunk,
 * with the hunk's removed and added lines. Binary files have nothing to ask about and are left out.
 * @returns {{ path: string, changes: { before: string, after: string }[] }[]}
 */
export function parseUnifiedDiff(text) {
  const edits = [];
  let edit = null;
  let oldPath = null;
  let hunk = null; // { before, after, oldLeft, newLeft }: lines still to come in this hunk
  const closeHunk = () => {
    if (edit && hunk && (hunk.before.length || hunk.after.length)) edit.changes.push({ before: hunk.before.join('\n'), after: hunk.after.join('\n') });
    hunk = null;
  };
  const closeFile = () => {
    closeHunk();
    if (edit?.changes.length) edits.push(edit);
    edit = null;
  };
  for (const line of String(text ?? '').split('\n')) {
    // Inside a hunk its header says how many lines follow, so "--- x" or "+++ x" there is code
    // (a removed SQL comment, say), never a file header.
    const isContent = line.startsWith('-') || line.startsWith('+') || line.startsWith(' ') || line.startsWith('\\') || line === '';
    if (hunk && (hunk.oldLeft > 0 || hunk.newLeft > 0) && isContent) {
      if (line.startsWith('-')) {
        hunk.before.push(line.slice(1));
        hunk.oldLeft--;
      } else if (line.startsWith('+')) {
        hunk.after.push(line.slice(1));
        hunk.newLeft--;
      } else if (line.startsWith(' ') || line === '') {
        hunk.oldLeft--;
        hunk.newLeft--;
      }
      continue;
    }
    if (line.startsWith('diff --git ')) {
      closeFile();
      oldPath = null;
    } else if (line.startsWith('--- ')) {
      oldPath = line.slice(4).replace(/^a\//, '');
    } else if (line.startsWith('+++ ')) {
      closeFile();
      const newPath = line.slice(4).replace(/^b\//, '');
      edit = { path: newPath === '/dev/null' ? oldPath : newPath, changes: [] };
    } else if (edit && line.startsWith('@@')) {
      closeHunk();
      const counts = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      hunk = { before: [], after: [], oldLeft: counts ? Number(counts[1] ?? 1) : 0, newLeft: counts ? Number(counts[2] ?? 1) : 0 };
    }
  }
  closeFile();
  return edits;
}

/**
 * `hyperfocus --staged`: questions about the staged change, with no agent and no terminal UI. The
 * VS Code panel finds the session through the bridge and asks them. One batch; it ends when the user
 * has gone past the last question, asks to end it, the panel that was following it goes away, or no
 * questions come.
 * @returns {Promise<number>} the exit code
 */
export async function runStaged({
  cwd,
  diff,
  config,
  writer,
  sessionsDir = undefined,
  historyPath = undefined,
  write = (text) => process.stdout.write(text),
  noQuestionMs = NO_QUESTION_MS,
}) {
  const edits = parseUnifiedDiff(diff);
  if (!edits.length) {
    write('Nothing staged to review. Stage a change with git add first.\n');
    return 0;
  }

  const history = createHistory(historyPath ? { path: historyPath } : {});
  let bridge = null;
  let asked = false;
  let endRequested = false;
  const redraw = () => bridge?.publish();
  // One reply is the review: once it is complete (questions stream in one by one before that),
  // closing the run stops the engine asking for more.
  const replyDone = () => {
    if (asked || !session.view.isAtQuestion) return;
    asked = true;
    session.agentEvent({ type: 'done', sessionId: 'staged' });
  };
  const session = createFocusSession({
    claudePath: writer.path,
    writer,
    // Predictions need an agent's next edit; there is none here.
    config: { ...config, kinds: config.kinds.filter((kind) => kind !== 'predict') },
    agent: { ...claudeAgent, name: 'Your staged change' },
    redraw: () => redraw(),
    onReplyDone: () => replyDone(),
    onAnswer: (entry) => history.append(entry, { cwd, sessionId: 'staged', files: edits.map((edit) => edit.path), source: 'staged' }),
  });

  bridge = await startBridge({
    sessionsDir,
    meta: { cwd, agent: 'staged' },
    state: () => session.snapshot(),
    // There is no agent to go back to: "back" ends the review.
    act: (action) => {
      if (action.type !== 'back') return session.act(action);
      endRequested = true;
      return 'ok';
    },
  });
  write(`Writing questions about ${edits.length} staged file${edits.length === 1 ? '' : 's'}. Answer them in the hyperfocus panel in VS Code.\n`);

  session.view.setActivity('reading your staged change', Date.now());
  session.replay([
    { type: 'busy', sessionId: 'staged', prompt: 'Review the staged change before committing it' },
    ...edits.map((edit) => ({ type: 'edit', sessionId: 'staged', path: edit.path, changes: edit.changes })),
  ]);

  const startedAt = Date.now();
  let stopWaiting = () => {};
  const outcome = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (endRequested) return resolve('ended');
      if (asked && !session.view.isAtQuestion) return resolve('finished');
      if (bridge.connectionCount > 0 && bridge.clientCount === 0) return resolve('left');
      if (!asked && !session.view.isAtQuestion && Date.now() - startedAt > noQuestionMs) return resolve('no-questions');
    }, POLL_MS);
    const stop = () => resolve('stopped');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    stopWaiting = () => {
      clearInterval(timer);
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
    };
  });
  stopWaiting();
  bridge.close();

  if (outcome === 'no-questions') {
    write('No questions came back for this change. Try again, or run hyperfocus --doctor.\n');
    return 1;
  }
  const { answered, correct } = session.view.score;
  write(answered ? `Reviewed: ${correct} of ${answered} right.\n` : 'Review ended.\n');
  return 0;
}
