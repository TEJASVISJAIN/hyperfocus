import { renderRecap } from './recap.js';
import { BLUE, BOLD, CYAN, DIM, GREEN, INDENT, INVERSE, MAGENTA, RED, RESET, YELLOW } from './styles.js';
import { truncate, widthOf, wrap } from './text-layout.js';

// Claude Code turns on the kitty keyboard protocol, which the terminal keeps using while the
// focus view is up: these arrive as escape sequences instead of their plain bytes.
const KITTY_KEYS = { '\x1b[27u': '\x1b', '\x1b[13u': '\r', '\x1b[127u': '\x7f', '\x1b[9u': '\t' };
const ESC = '\x1b';
const ENTER = '\r';
const BACKSPACES = new Set(['\x7f', '\b']);
// SGR mouse report: button;column;row, M on press and m on release.
const MOUSE_REPORT = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;
// Option rows carry this marker, with their key, until `finish` strips it and records the row.
const OPTION_MARK = '\x00';

const SPINNER = ['◐', '◓', '◑', '◒'];
const IDLE_ACTIVITIES = new Set(['done', 'waiting for you']);
const KIND_LABELS = { why: '', bug: 'spot the bug', output: 'what does it do', predict: 'predict' };
const FEED_ICONS = { read: ['⌕', CYAN], edit: ['✎', YELLOW], command: ['$', MAGENTA], subagent: ['◆', BLUE] };
const PEEK_GUTTER = '│ ';
const MAX_FEED_STEPS = 4;
const MAX_PEEK_LINES = 4;
const RESULT_SHOWN_MS = 10_000;
const MAX_PLAN_CELLS = 10;

/**
 * The quiz screen shown while the agent works: a status line, Claude's plan, the running summary,
 * one question at a time, and below it a live feed of the agent's steps and a peek at Claude's own
 * screen. State survives switching back to Claude, so an unanswered question is still there next time.
 *
 * Callbacks:
 * - `onAnswer({ question, chosen, correct, skipped })` for every answered or skipped question; a
 *   prediction is reported when Claude's next edit settles it
 * - `onFollowUp({ question, chosen, ask, thread })` when the user asks their own follow-up;
 *   answer with `setFollowUpAnswer` or `setFollowUpFailed`
 * - `onBack()` / `onKeepGoing()` for the choice offered by `showFinished`
 *
 * The live panel (feed and peek) is hidden unless `live` is set or the user presses `l`: it is
 * there for those who want it, not noise on every question.
 *
 * `title`, `backHint`, `idleText`, `spinner`, `summaryHeading` and `liveToggle` let the same screen serve `hyperfocus --review`.
 */
export function createFocusView({
  onAnswer,
  onFollowUp = undefined,
  onBack = undefined,
  onKeepGoing = undefined,
  title = 'hyperfocus',
  backHint = 'Ctrl-] back to Claude',
  idleText = 'Thinking of a question about this change…',
  spinner = true,
  summaryHeading = "What's happening",
  live = false, // start with the live panel (feed and peek) open; `l` toggles it
  liveToggle = true, // offer `l` at all (review mode has no agent to watch)
}) {
  let activity = 'thinking';
  let activityStartedAt = Date.now();
  let summary = '';
  const queue = [];
  let feedback = null; // { question, chosen } after an answer, until the user moves on
  let followUp = emptyFollowUp();
  let seen = 0; // questions the user has moved past, for numbering
  let answered = 0;
  let correct = 0;
  let streak = 0;
  let recap = null; // { card, onDismiss } while the "while you were away" card is up
  let finished = null; // { reason, changedFiles, score } while offering "back to Claude or keep going"
  let pendingPredictions = []; // { question, chosen } waiting for Claude's next edit
  let result = null; // { text, good, at }: how the latest prediction turned out
  let progress = null;
  let feed = [];
  let peek = [];
  let liveShown = live && liveToggle;
  let clickRows = new Map(); // screen row (1-based) → the key a click there stands for

  const current = () => queue[0];

  function next() {
    feedback = null;
    followUp = emptyFollowUp();
    queue.shift();
    seen++;
  }

  function keepGoing() {
    finished = null;
    onKeepGoing?.();
  }

  function score(isCorrect) {
    answered++;
    if (isCorrect) {
      correct++;
      streak++;
    } else streak = 0;
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

  // A left click on an option answers it. Clicks anywhere else do nothing: the click that focuses
  // the terminal window arrives too, and must not dismiss a card or skip past an explanation.
  function handleClick([, button, , row, action]) {
    const code = Number(button);
    if (action !== 'M' || (code & 3) !== 0 || code >= 32 || followUp.draft !== null) return;
    const key = clickRows.get(Number(row));
    if (key) view.handleKey(key);
  }

  const view = {
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
    get isTyping() {
      return followUp.draft !== null;
    },
    get liveShown() {
      return liveShown;
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
    setProgress(plan) {
      progress = plan;
    },
    setFeed(steps) {
      feed = steps;
    },
    setPeek(screenLines) {
      peek = screenLines;
    },
    addQuestions(questions) {
      queue.push(...questions);
    },
    newRun(startedAt) {
      const unanswered = feedback ? [] : queue.slice(0, 1).filter((question) => question.kind !== 'predict');
      queue.splice(0, queue.length, ...unanswered);
      feedback = null;
      followUp = emptyFollowUp();
      finished = null;
      pendingPredictions = [];
      summary = '';
      answered = 0;
      correct = 0;
      streak = 0;
      feed = [];
      activity = 'thinking';
      activityStartedAt = startedAt;
    },

    /** Claude edited `path`: settles every prediction the user locked in. */
    resolvePredictions(path, at = Date.now()) {
      for (const { question, chosen } of pendingPredictions) {
        const guess = question.options[chosen];
        if (!question.options.includes(path)) {
          result = { text: `Claude edited ${path}, which wasn't an option`, good: null, at };
          continue;
        }
        const isCorrect = guess === path;
        score(isCorrect);
        onAnswer({ question, chosen, correct: isCorrect, skipped: false });
        result = isCorrect
          ? { text: `✔ Prediction right: Claude edited ${path}`, good: true, at }
          : { text: `✘ Prediction missed: Claude edited ${path}, not ${guess}`, good: false, at };
      }
      pendingPredictions = [];
    },
    /** The run is over: predictions still open can no longer be settled, so they go unscored. */
    expirePredictions() {
      pendingPredictions = [];
      // Unanswered predictions can't be settled any more either, so they leave the queue.
      const keep = queue.filter((question, index) => question.kind !== 'predict' || (index === 0 && feedback));
      queue.splice(0, queue.length, ...keep);
    },

    handleKey(rawKey) {
      const mouse = rawKey.match(MOUSE_REPORT);
      if (mouse) return handleClick(mouse);
      clickRows = new Map(); // the screen is about to change: rows are known again after the next render
      const key = KITTY_KEYS[rawKey] ?? rawKey;
      // Other escape sequences here are terminal reports (focus in/out, paste markers) or
      // keys we don't use, never a deliberate "any key".
      if (key.length > 1 && key.startsWith(ESC)) return;
      if (recap) {
        const { onDismiss } = recap;
        recap = null;
        return onDismiss();
      }
      if (followUp.draft !== null) return handleDraftKey(key);
      if (key === 'l' && liveToggle) return void (liveShown = !liveShown);

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
      feedback = { question, chosen };
      if (question.kind === 'predict') return void pendingPredictions.push({ question, chosen });
      const isCorrect = chosen === question.answer;
      score(isCorrect);
      onAnswer({ question, chosen, correct: isCorrect, skipped: false });
    },

    render({ cols, rows, now = Date.now() }) {
      const textWidth = Math.max(10, cols - INDENT.length * 2);
      const header = [statusLine(cols, now), DIM + '─'.repeat(cols) + RESET, ...planLine(textWidth), ...resultLine(textWidth, now), ''];
      if (recap) return finish([...header, ...renderRecap(recap.card, { cols })].slice(0, rows));

      const summaryBlock = [
        DIM + summaryHeading + RESET,
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

      // The question matters most, then the summary, then the live feed, then the peek.
      let room = Math.max(0, rows - header.length - questionBlock.length);
      const fittedSummary = room >= summaryBlock.length ? summaryBlock : room > 1 ? [...summaryBlock.slice(0, room - 1), ''] : [];
      room -= fittedSummary.length;
      const feedBlock = !liveShown ? [] : fitSection('Live', feed.slice(-MAX_FEED_STEPS).map((step) => feedLine(step, textWidth)), room, cols);
      room -= feedBlock.length;
      const peekLine = (line) => INDENT + CYAN + PEEK_GUTTER + RESET + truncate(line, textWidth - PEEK_GUTTER.length);
      const peekBlock = !liveShown ? [] : fitSection('Claude', peek.slice(-MAX_PEEK_LINES).map(peekLine), room, cols);

      return finish([...header, ...fittedSummary, ...questionBlock, ...feedBlock, ...peekBlock].slice(0, rows));
    },
  };
  return view;

  // Remembers which rows are options, so a click there can answer. Only rows the question itself
  // marked count: a peek or summary line that happens to read "1) …" is not an option.
  function finish(screen) {
    clickRows = new Map();
    const optionsClickable = current() && !feedback && !recap;
    const lines = screen.map((line, index) => {
      if (!line.startsWith(OPTION_MARK)) return line;
      if (optionsClickable) clickRows.set(index + 1, line[1]);
      return line.slice(2);
    });
    return lines.join('\r\n');
  }

  function statusLine(cols, now) {
    const hint = backHint + ' ';
    const frame = !spinner || IDLE_ACTIVITIES.has(activity) ? '' : `${SPINNER[Math.floor(now / 1000) % SPINNER.length]} `;
    const left = ` ${frame}${title} · ${activity} · ${formatElapsed(now - activityStartedAt)} `;
    const room = cols - widthOf(hint);
    const fitted = room >= 12 ? truncate(left, room) : truncate(left, cols);
    const padding = ' '.repeat(Math.max(0, cols - widthOf(fitted) - (room >= 12 ? widthOf(hint) : 0)));
    return INVERSE + fitted + padding + (room >= 12 ? hint : '') + RESET;
  }

  function planLine(textWidth) {
    if (!progress) return [];
    const cells = Math.min(progress.total, MAX_PLAN_CELLS);
    const filled = Math.round((progress.done / progress.total) * cells);
    const bar = '▰'.repeat(filled) + '▱'.repeat(cells - filled);
    const text = `Plan ${progress.done}/${progress.total} ${bar}${progress.current ? ` ${progress.current}` : ''}`;
    return [INDENT + DIM + truncate(text, textWidth) + RESET];
  }

  function resultLine(textWidth, now) {
    if (!result || now - result.at >= RESULT_SHOWN_MS) return [];
    const style = result.good === true ? GREEN : result.good === false ? RED : DIM;
    return [INDENT + style + truncate(result.text, textWidth) + RESET];
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
      ...keyHints([['Enter', 'back to Claude'], ['c', 'keep going']], textWidth),
      '',
    ];
  }

  function renderQuestion(textWidth, threadShown) {
    const question = current();
    if (!question) {
      const hint = liveToggle && !liveShown ? [INDENT + DIM + truncate('l shows what Claude is doing', textWidth) + RESET] : [];
      return [INDENT + DIM + idleText + RESET, ...hint];
    }

    const label = KIND_LABELS[question.kind] ?? '';
    const scoreText = [answered ? `score ${correct}/${answered}` : '', streak >= 2 ? `streak ${streak}` : ''].filter(Boolean).join(' · ');
    const heading = truncate([`Question ${seen + 1}`, label].filter(Boolean).join(' · '), textWidth + INDENT.length * 2);
    const lines = [
      `${BOLD}${heading}${RESET}${DIM}${scoreText ? truncate(` · ${scoreText}`, Math.max(0, textWidth + 4 - widthOf(heading))) : ''}${RESET}`,
      ...wrap(question.q, textWidth).map((line) => INDENT + BOLD + line + RESET),
      '',
      ...renderCode(question, textWidth),
    ];
    question.options.forEach((option, index) => {
      const number = `${index + 1}) `;
      const [first, ...rest] = wrap(option, textWidth - number.length);
      const style = feedback ? optionStyle(index) : '';
      const mark = OPTION_MARK + String(index + 1);
      lines.push(mark + INDENT + style + number + first + RESET);
      for (const line of rest) lines.push(mark + INDENT + style + ' '.repeat(number.length) + line + RESET);
    });
    lines.push('');

    if (!feedback) {
      const liveHint = liveToggle ? ` · l ${liveShown ? 'hide live view' : 'live view'}` : '';
      lines.push(INDENT + DIM + truncate(`press 1-${question.options.length} to answer · s to skip${liveHint}`, textWidth) + RESET);
      return lines;
    }
    if (question.kind === 'predict') {
      lines.push(
        ...wrap(`Locked in: ${question.options[feedback.chosen]}. The next file Claude edits settles it.`, textWidth).map((line) => INDENT + line),
        '',
        ...renderFollowUps(textWidth, threadShown),
      );
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
      if (question.kind === 'predict') return index === feedback.chosen ? BOLD : DIM;
      if (index === question.answer) return GREEN;
      if (index === feedback.chosen) return RED;
      return DIM;
    }
  }

  function renderCode(question, textWidth) {
    if (!question.code) return [];
    const marks = question.codeMarks ?? [];
    const codeLines = question.code.split('\n').map((line, index) => {
      const mark = marks[index] === '+' || marks[index] === '-' ? marks[index] : ' ';
      const style = mark === '+' ? GREEN : mark === '-' ? RED : DIM;
      return INDENT + INDENT + style + truncate(`${mark} ${line}`, textWidth - INDENT.length) + RESET;
    });
    return [...codeLines, ''];
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
    if (followUp.failed) lines.push(...wrap("Couldn't get an answer. Press f to try again.", textWidth).map((line) => INDENT + RED + line + RESET), '');

    if (followUp.draft !== null) {
      lines.push(...wrap(`> ${followUp.draft}█`, textWidth).map((line) => INDENT + line), '');
      lines.push(INDENT + DIM + truncate('Enter to ask · Esc to cancel', textWidth) + RESET);
    } else if (followUp.pendingAsk === null) {
      lines.push(...keyHints([['f', 'ask a follow-up'], ['any key', 'next question']], textWidth, 1));
    }
    return lines;
  }
}

// "key  does" pairs on one line when they fit, one per line when they don't. Pairs from
// `dimFrom` on are dimmed, as secondary choices.
function keyHints(pairs, width, dimFrom = pairs.length) {
  const plain = pairs.map(([key, does]) => `${key}  ${does}`);
  const styled = pairs.map(([key, does], index) => (index >= dimFrom ? `${DIM}${key}  ${does}${RESET}` : `${BOLD}${key}${RESET}  ${does}`));
  if (widthOf(plain.join('    ')) <= width) return [INDENT + styled.join('    ')];
  return plain.map((text, index) => INDENT + (index >= dimFrom ? DIM : '') + truncate(text, width) + RESET);
}

// Adds a titled section below the question if at least one of its lines fits, oldest lines dropped
// first. The heading is a rule with the title in it, so the live panel reads as its own area.
function fitSection(heading, sectionLines, room, cols) {
  if (sectionLines.length === 0) return [];
  const fitting = Math.min(sectionLines.length, room - 2);
  if (fitting < 1) return [];
  const rule = DIM + '── ' + RESET + CYAN + BOLD + heading + RESET + DIM + ' ' + '─'.repeat(Math.max(0, cols - heading.length - 4)) + RESET;
  return ['', rule, ...sectionLines.slice(sectionLines.length - fitting)];
}

function feedLine(step, textWidth) {
  const [icon, color] = FEED_ICONS[step.kind] ?? ['·', DIM];
  const added = ` +${step.added ?? 0}`;
  const removed = ` −${step.removed ?? 0}`;
  const counts = step.kind === 'edit' ? GREEN + added + RESET + RED + removed + RESET : '';
  const countsWidth = step.kind === 'edit' ? widthOf(added + removed) : 0;
  return INDENT + color + icon + RESET + ' ' + truncate(step.text.split('\n')[0], textWidth - 2 - countsWidth) + counts;
}

function emptyFollowUp() {
  return { thread: [], draft: null, pendingAsk: null, failed: false };
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
