import { renderRecap } from './recap.js';
import { BOLD, DIM, GREEN, INDENT, INVERSE, RED, RESET } from './styles.js';
import { truncate, widthOf, wrap } from './text-layout.js';

// Claude Code turns on the kitty keyboard protocol, which the terminal keeps using while the
// focus view is up: these arrive as escape sequences instead of their plain bytes.
const KITTY_KEYS = { '\x1b[27u': '\x1b', '\x1b[13u': '\r', '\x1b[127u': '\x7f', '\x1b[9u': '\t' };
const ESC = '\x1b';
const ENTER = '\r';
const BACKSPACES = new Set(['\x7f', '\b']);

/**
 * The quiz screen shown while the agent works: a status line, the running summary and one
 * question at a time. State survives switching back to Claude, so an unanswered question is
 * still there next time.
 *
 * Callbacks:
 * - `onAnswer({ question, chosen, correct, skipped })` for every answered or skipped question
 * - `onFollowUp({ question, chosen, ask, thread })` when the user asks their own follow-up;
 *   answer with `setFollowUpAnswer` or `setFollowUpFailed`
 * - `onBack()` / `onKeepGoing()` for the choice offered by `showFinished`
 */
export function createFocusView({ onAnswer, onFollowUp = undefined, onBack = undefined, onKeepGoing = undefined }) {
  let activity = 'thinking';
  let activityStartedAt = Date.now();
  let summary = '';
  const queue = [];
  let feedback = null; // { question, chosen } after an answer, until the user moves on
  let followUp = emptyFollowUp();
  let answered = 0;
  let correct = 0;
  let recap = null; // { card, onDismiss } while the "while you were away" card is up
  let finished = null; // { reason, changedFiles, score } while offering "back to Claude or keep going"

  const current = () => queue[0];

  function next() {
    feedback = null;
    followUp = emptyFollowUp();
    queue.shift();
  }

  function keepGoing() {
    finished = null;
    onKeepGoing?.();
  }

  function handleDraftKey(key) {
    if (key === ESC) followUp.draft = null;
    else if (BACKSPACES.has(key)) followUp.draft = [...followUp.draft].slice(0, -1).join('');
    else if (key === ENTER) {
      const ask = followUp.draft.trim();
      if (!ask) return;
      followUp = { ...followUp, draft: null, pendingAsk: ask, failed: false };
      onFollowUp?.({ question: feedback.question, chosen: feedback.chosen, ask, thread: [...followUp.thread] });
    } else if (key >= ' ' && key !== '\x7f') followUp.draft += key;
  }

  return {
    get queuedQuestions() {
      return queue.length - (feedback ? 1 : 0);
    },
    get score() {
      return { answered, correct };
    },
    get summary() {
      return summary;
    },
    get isAtQuestion() {
      return Boolean(current());
    },

    showRecap(card, onDismiss) {
      recap = { card, onDismiss };
    },
    hideRecap() {
      recap = null;
    },
    showFinished(details) {
      finished = details;
    },
    hideFinished() {
      finished = null;
    },

    setFollowUpAnswer(answer, forQuestion = current()) {
      if (followUp.pendingAsk === null || forQuestion !== current()) return;
      followUp.thread.push({ ask: followUp.pendingAsk, answer });
      followUp.pendingAsk = null;
    },
    setFollowUpFailed(forQuestion = current()) {
      if (followUp.pendingAsk === null || forQuestion !== current()) return;
      followUp.pendingAsk = null;
      followUp.failed = true;
    },

    setActivity(label, startedAt) {
      activity = label;
      activityStartedAt = startedAt;
    },
    setSummary(text) {
      summary = text;
    },
    addQuestions(questions) {
      queue.push(...questions);
    },
    newRun(startedAt) {
      const unanswered = feedback ? [] : queue.slice(0, 1);
      queue.splice(0, queue.length, ...unanswered);
      feedback = null;
      followUp = emptyFollowUp();
      finished = null;
      summary = '';
      answered = 0;
      correct = 0;
      activity = 'thinking';
      activityStartedAt = startedAt;
    },

    handleKey(rawKey) {
      const key = KITTY_KEYS[rawKey] ?? rawKey;
      // Other escape sequences here are terminal reports (focus in/out, mouse, paste markers) or
      // keys we don't use, never a deliberate "any key".
      if (key.length > 1 && key.startsWith(ESC)) return;
      if (recap) {
        const { onDismiss } = recap;
        recap = null;
        return onDismiss();
      }
      if (followUp.draft !== null) return handleDraftKey(key);

      const question = current();
      if (finished) {
        if (key === ENTER) return onBack?.();
        if (key === 'c') return keepGoing();
        // Answering or skipping the question on screen is choosing to keep going too.
        const answersQuestion = question && !feedback && (key === 's' || /^[1-9]$/.test(key));
        if (!answersQuestion) return;
        keepGoing();
      }
      if (!question) return;

      if (feedback) {
        if (key === 'f' && followUp.pendingAsk === null) return void (followUp.draft = '');
        return next();
      }
      if (key === 's') {
        onAnswer({ question, chosen: null, correct: null, skipped: true });
        return next();
      }
      const chosen = Number(key) - 1;
      if (!/^[1-9]$/.test(key) || chosen >= question.options.length) return;
      const isCorrect = chosen === question.answer;
      answered++;
      if (isCorrect) correct++;
      feedback = { question, chosen };
      onAnswer({ question, chosen, correct: isCorrect, skipped: false });
    },

    render({ cols, rows, now = Date.now() }) {
      const textWidth = Math.max(10, cols - INDENT.length * 2);
      const header = [statusLine(cols, now), DIM + '─'.repeat(cols) + RESET, ''];
      if (recap) return [...header, ...renderRecap(recap.card, { cols })].slice(0, rows).join('\r\n');

      const summaryBlock = [
        DIM + "What's happening" + RESET,
        ...(summary ? wrap(summary, textWidth) : ['Watching the agent…']).map((line) => INDENT + line),
        '',
      ];
      // A long follow-up thread drops its oldest exchanges first, so the latest answer stays visible.
      let threadShown = followUp.thread.length;
      let questionBlock = [...renderFinished(textWidth), ...renderQuestion(textWidth, threadShown)];
      while (threadShown > 0 && header.length + questionBlock.length > rows) {
        threadShown--;
        questionBlock = [...renderFinished(textWidth), ...renderQuestion(textWidth, threadShown)];
      }

      // The question matters most: trim the summary first when the terminal is short.
      const summaryRoom = Math.max(0, rows - header.length - questionBlock.length);
      const fittedSummary = summaryRoom >= summaryBlock.length ? summaryBlock : [...summaryBlock.slice(0, summaryRoom - 1), ''];
      const screen = [...header, ...(summaryRoom > 1 ? fittedSummary : []), ...questionBlock].slice(0, rows);
      return screen.join('\r\n');
    },
  };

  function statusLine(cols, now) {
    const hint = 'Ctrl-] back to Claude ';
    const left = ` hyperfocus · ${activity} · ${formatElapsed(now - activityStartedAt)} `;
    const room = cols - widthOf(hint);
    const fitted = room >= 12 ? truncate(left, room) : truncate(left, cols);
    const padding = ' '.repeat(Math.max(0, cols - widthOf(fitted) - (room >= 12 ? widthOf(hint) : 0)));
    return INVERSE + fitted + padding + (room >= 12 ? hint : '') + RESET;
  }

  function renderFinished(textWidth) {
    if (!finished || !current()) return [];
    const files = finished.changedFiles.length;
    const headline = [
      finished.reason === 'done' ? 'Claude finished' : 'Claude needs your input',
      files ? `${files} file${files === 1 ? '' : 's'} changed` : 'no files changed',
      ...(finished.score.answered ? [`quiz ${finished.score.correct}/${finished.score.answered}`] : []),
    ].join(' · ');
    return [
      INDENT + GREEN + BOLD + '✔ ' + truncate(headline, textWidth - 2) + RESET,
      INDENT + `${BOLD}Enter${RESET}  back to Claude    ${BOLD}c${RESET}  keep going`,
      '',
    ];
  }

  function renderQuestion(textWidth, threadShown) {
    const question = current();
    if (!question) return [INDENT + DIM + 'Thinking of a question about this change…' + RESET];

    const lines = [
      `${BOLD}Question ${answered + (feedback ? 0 : 1)}${RESET}${DIM}${answered ? ` · score ${correct}/${answered}` : ''}${RESET}`,
      ...wrap(question.q, textWidth).map((line) => INDENT + BOLD + line + RESET),
      '',
    ];
    question.options.forEach((option, index) => {
      const label = `${index + 1}) `;
      const [first, ...rest] = wrap(option, textWidth - label.length);
      const style = feedback ? optionStyle(index) : '';
      lines.push(INDENT + style + label + first + RESET);
      for (const line of rest) lines.push(INDENT + style + ' '.repeat(label.length) + line + RESET);
    });
    lines.push('');

    if (!feedback) {
      lines.push(INDENT + DIM + `press 1-${question.options.length} to answer · s to skip` + RESET);
      return lines;
    }
    const wasRight = feedback.chosen === question.answer;
    lines.push(
      INDENT +
        (wasRight
          ? `${GREEN}✔ Correct${RESET}`
          : `${RED}✘ Not quite${RESET} · answer: ${question.answer + 1}) ${truncate(question.options[question.answer], textWidth - 26)}`),
      ...wrap(question.why, textWidth).map((line) => INDENT + line),
      '',
      ...renderFollowUps(textWidth, threadShown),
    );
    return lines;

    function optionStyle(index) {
      if (index === question.answer) return GREEN;
      if (index === feedback.chosen) return RED;
      return DIM;
    }
  }

  function renderFollowUps(textWidth, threadShown) {
    const asked = (ask) => wrap(`> ${ask}`, textWidth).map((line) => INDENT + BOLD + line + RESET);
    const lines = [];
    for (const { ask, answer } of followUp.thread.slice(followUp.thread.length - threadShown)) {
      lines.push(...asked(ask), ...wrap(answer, textWidth).map((line) => INDENT + line), '');
    }
    if (followUp.pendingAsk !== null) {
      lines.push(...asked(followUp.pendingAsk), INDENT + DIM + 'Thinking…' + RESET, '');
    }
    if (followUp.failed) lines.push(INDENT + RED + "Couldn't get an answer. Press f to try again." + RESET, '');

    if (followUp.draft !== null) {
      lines.push(...wrap(`> ${followUp.draft}█`, textWidth).map((line) => INDENT + line), '');
      lines.push(INDENT + DIM + 'Enter to ask · Esc to cancel' + RESET);
    } else if (followUp.pendingAsk === null) {
      lines.push(INDENT + `${BOLD}f${RESET}  ask a follow-up    ${DIM}any key  next question${RESET}`);
    }
    return lines;
  }
}

function emptyFollowUp() {
  return { thread: [], draft: null, pendingAsk: null, failed: false };
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
