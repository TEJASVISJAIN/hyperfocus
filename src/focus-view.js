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
const MAX_CARD_WIDTH = 84;
const MAX_DOTS = 10;
const UP_KEYS = new Set(['\x1b[A', '\x1bOA', 'k']);
const DOWN_KEYS = new Set(['\x1b[B', '\x1bOB', 'j']);
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
 * - `onExit()` when the user asks to go back to Claude: Esc anywhere, or Enter while there is no
 *   question yet
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
  onExit = undefined,
  title = 'hyperfocus',
  backHint = 'Esc back to Claude',
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
  let results = []; // 'right' | 'wrong' | 'skip' for this run, drawn as dots on the card
  let selected = 0; // the option the arrow keys point at
  let selectedFor = null;
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

  // A new question on screen starts with its first option selected.
  function syncSelection() {
    if (selectedFor === current()) return;
    selectedFor = current();
    selected = 0;
  }

  function answer(question, chosen) {
    feedback = { question, chosen };
    if (question.kind === 'predict') return void pendingPredictions.push({ question, chosen });
    const isCorrect = chosen === question.answer;
    score(isCorrect);
    onAnswer({ question, chosen, correct: isCorrect, skipped: false });
  }

  function next() {
    selectedFor = null; // the next question starts at its first option, even if it is the same object
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
    results.push(isCorrect ? 'right' : 'wrong');
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
      results = [];
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
      syncSelection();
      const key = KITTY_KEYS[rawKey] ?? rawKey;
      const arrow = UP_KEYS.has(key) ? -1 : DOWN_KEYS.has(key) ? 1 : 0;
      // Other escape sequences here are terminal reports (focus in/out, paste markers) or
      // keys we don't use, never a deliberate "any key".
      if (!arrow && key.length > 1 && key.startsWith(ESC)) return;
      if (recap) {
        const { onDismiss } = recap;
        recap = null;
        return onDismiss();
      }
      if (followUp.draft !== null) return handleDraftKey(key);
      if (key === 'l' && liveToggle) return void (liveShown = !liveShown);
      if (key === ESC && onExit) return onExit();

      const question = current();
      // Nothing to answer yet, and maybe nothing left to wait for: let the user leave simply.
      if (!question && onExit && key === ENTER) return onExit();
      if (finished) {
        if (key === ENTER) return onBack?.();
        if (key === 'c') return keepGoing();
        // Choosing or answering the question on screen is choosing to keep going too.
        const answersQuestion = question && !feedback && (arrow || key === 's' || /^[1-9]$/.test(key));
        if (!answersQuestion) return;
        keepGoing();
      }
      if (!question) return;

      if (feedback) {
        if (key === 'f' && followUp.pendingAsk === null) return void (followUp.draft = '');
        return next();
      }
      if (arrow) return void (selected = (selected + arrow + question.options.length) % question.options.length);
      if (key === ENTER) return answer(question, selected);
      if (key === 's') {
        results.push('skip');
        onAnswer({ question, chosen: null, correct: null, skipped: true });
        return next();
      }
      const chosen = Number(key) - 1;
      if (!/^[1-9]$/.test(key) || chosen >= question.options.length) return;
      answer(question, chosen);
    },

    render({ cols, rows, now = Date.now() }) {
      syncSelection();
      const margin = cols >= 30 ? INDENT : '';
      const cardWidth = Math.max(12, Math.min(cols - margin.length * 2, MAX_CARD_WIDTH));
      const inner = Math.max(6, cardWidth - 6);
      const box = { margin, cardWidth, inner };
      const header = [statusLine(cols, now), ...planLine(cols - 2), ...resultLine(cols - 2, now), ''];

      if (recap) {
        const { title: recapTitle, detail, lines: body } = renderRecap(recap.card, { width: inner });
        const screen = [...header, ...card(box, recapTitle, detail, body), ...hintRow([['any key', 'back to Claude']], cols, margin)];
        return finish(screen.slice(0, rows));
      }

      // A long follow-up thread drops its oldest exchanges first, so the latest answer stays visible.
      let threadShown = followUp.thread.length;
      const main = () => [...renderFinished(box, cols), ...renderQuestion(box, threadShown), ...hintRow(currentHints(), cols, margin)];
      let mainBlock = main();
      while (threadShown > 0 && header.length + mainBlock.length > rows) {
        threadShown--;
        mainBlock = main();
      }

      // The question card matters most, then the summary, then the live view.
      const textWidth = cols - margin.length * 2;
      let room = Math.max(0, rows - header.length - mainBlock.length);
      const summaryLines = (summary ? wrap(summary, textWidth) : ['Watching the agent…']).map((line) => margin + line);
      const summaryBlock = ['', margin + DIM + summaryHeading + RESET, ...summaryLines];
      const fittedSummary = room >= summaryBlock.length ? summaryBlock : room >= 3 ? summaryBlock.slice(0, room) : [];
      room -= fittedSummary.length;
      const feedBlock = !liveShown ? [] : fitSection('Live', feed.slice(-MAX_FEED_STEPS).map((step) => feedLine(step, textWidth, margin)), room, cols);
      room -= feedBlock.length;
      const peekLine = (line) => margin + CYAN + PEEK_GUTTER + RESET + truncate(line, textWidth - PEEK_GUTTER.length);
      const peekBlock = !liveShown ? [] : fitSection('Claude', peek.slice(-MAX_PEEK_LINES).map(peekLine), room, cols);

      return finish([...header, ...mainBlock, ...fittedSummary, ...feedBlock, ...peekBlock].slice(0, rows));
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
    const fitted = room >= 12 ? truncate(left, room - 1) : truncate(left, cols);
    const padding = ' '.repeat(Math.max(0, cols - widthOf(fitted) - (room >= 12 ? widthOf(hint) : 0)));
    return INVERSE + fitted + padding + (room >= 12 ? hint : '') + RESET;
  }

  function planLine(width) {
    if (!progress) return [];
    const cells = Math.min(progress.total, MAX_PLAN_CELLS);
    const filled = Math.round((progress.done / progress.total) * cells);
    const bar = CYAN + '▰'.repeat(filled) + RESET + DIM + '▱'.repeat(cells - filled) + RESET;
    const label = `Plan ${progress.done}/${progress.total} `;
    const current = progress.current ? ' ' + truncate(progress.current, Math.max(0, width - label.length - cells - 1)) : '';
    return [' ' + DIM + label + RESET + bar + current];
  }

  function resultLine(width, now) {
    if (!result || now - result.at >= RESULT_SHOWN_MS) return [];
    const style = result.good === true ? GREEN : result.good === false ? RED : DIM;
    return [' ' + style + truncate(result.text, width) + RESET];
  }

  // Keys that do something right now, as one row under the card.
  function currentHints() {
    const live = liveToggle ? [['l', liveShown ? 'hide live view' : 'live view']] : [];
    const back = onExit ? [['esc', 'back to Claude']] : [];
    const question = current();
    if (!question) return [...(onExit ? [['enter or esc', 'back to Claude']] : []), ...(liveToggle && !liveShown ? [['l', 'see what Claude is doing']] : live)];
    if (followUp.draft !== null) return [['enter', 'ask'], ['esc', 'cancel']];
    if (!feedback) return [['↑↓', 'choose'], ['enter', 'answer'], ['s', 'skip'], ...live, ...back];
    if (followUp.pendingAsk !== null) return [['any key', 'next question'], ...back];
    return [['f', 'ask a follow-up'], ['any key', 'next question'], ...live, ...back];
  }

  function renderFinished({ margin, inner }, cols) {
    if (!finished || !current()) return [];
    const files = finished.changedFiles.length;
    const headline = [
      finished.reason === 'done' ? 'Claude finished' : 'Claude needs your input',
      files ? `${files} file${files === 1 ? '' : 's'} changed` : 'no files changed',
      ...(finished.score.answered ? [`quiz ${finished.score.correct}/${finished.score.answered}`] : []),
    ].join(' · ');
    return [
      margin + GREEN + BOLD + '✔ ' + truncate(headline, Math.max(4, inner)) + RESET,
      ...hintRow([['enter', 'back to Claude'], ['c', 'keep going']], cols, margin),
      '',
    ];
  }

  function renderQuestion(box, threadShown) {
    const { margin, inner } = box;
    const question = current();
    if (!question) return [margin + DIM + idleText + RESET, ''];

    const label = KIND_LABELS[question.kind] ?? '';
    const heading = BOLD + `Question ${seen + 1}` + RESET + (label ? DIM + ' · ' + RESET + CYAN + label + RESET : '');
    const body = [...wrap(question.q, inner).map((line) => BOLD + line + RESET), '', ...renderCode(question, inner)];

    question.options.forEach((option, index) => {
      const [bullet, style] = optionLook(question, index);
      const number = `${index + 1}  `;
      const [first, ...rest] = wrap(option, inner - 2 - number.length);
      const mark = OPTION_MARK + String(index + 1);
      body.push(mark + bullet + style + number + first + RESET);
      for (const line of rest) body.push(mark + '  ' + style + ' '.repeat(number.length) + line + RESET);
    });

    if (feedback) {
      body.push('');
      if (question.kind === 'predict') {
        body.push(...wrap(`Locked in: ${question.options[feedback.chosen]}. The next file Claude edits settles it.`, inner));
      } else {
        const wasRight = feedback.chosen === question.answer;
        body.push(wasRight ? GREEN + BOLD + '✔ Correct' + RESET : RED + BOLD + '✘ Not quite' + RESET + DIM + ` · the answer is ${question.answer + 1}` + RESET);
        body.push(...wrap(question.why, inner));
      }
      body.push(...renderFollowUps(inner, threadShown));
    }
    return card(box, heading, scoreDetail(), body);
  }

  function optionLook(question, index) {
    if (!feedback) return index === selected ? [CYAN + BOLD + '▸ ', CYAN + BOLD] : ['  ', ''];
    if (question.kind === 'predict') return index === feedback.chosen ? [BOLD + '● ', BOLD] : ['  ', DIM];
    if (index === question.answer) return [GREEN + BOLD + '✔ ' + RESET, GREEN];
    if (index === feedback.chosen) return [RED + BOLD + '✘ ' + RESET, RED];
    return ['  ', DIM];
  }

  // "●●○ 2/3 · streak 2": this run's answers as dots, then the score.
  function scoreDetail() {
    if (results.length === 0) return '';
    const dots = results.slice(-MAX_DOTS).map((outcome) => (outcome === 'right' ? GREEN + '●' : outcome === 'wrong' ? RED + '●' : DIM + '○') + RESET).join('');
    return dots + DIM + ` ${correct}/${answered}` + (streak >= 2 ? ` · streak ${streak}` : '') + RESET;
  }

  function renderCode(question, inner) {
    if (!question.code) return [];
    const marks = question.codeMarks ?? [];
    const codeLines = question.code.split('\n').map((line, index) => {
      const mark = marks[index] === '+' || marks[index] === '-' ? marks[index] : ' ';
      const style = mark === '+' ? GREEN : mark === '-' ? RED : DIM;
      return '  ' + style + truncate(`${mark} ${line}`, inner - 2) + RESET;
    });
    return [...codeLines, ''];
  }

  function renderFollowUps(inner, threadShown) {
    const asked = (ask) => wrap(`› ${ask}`, inner).map((line) => CYAN + BOLD + line + RESET);
    const lines = [];
    for (const { ask, answer } of followUp.thread.slice(followUp.thread.length - threadShown)) {
      lines.push('', ...asked(ask), ...wrap(answer, inner));
    }
    if (followUp.pendingAsk !== null) lines.push('', ...asked(followUp.pendingAsk), DIM + 'Thinking…' + RESET);
    if (followUp.failed) lines.push('', ...wrap("Couldn't get an answer. Press f to try again.", inner).map((line) => RED + line + RESET));
    if (followUp.draft !== null) lines.push('', ...wrap(`› ${followUp.draft}█`, inner));
    return lines;
  }
}

// A rounded card: ╭─ title ──── detail ─╮, the body padded inside │ │, then ╰───╯. Option rows keep
// their click marker at the very start of the line.
function card({ margin, cardWidth, inner }, title, detail, body) {
  let titleText = title;
  let detailText = detail;
  let fill = cardWidth - 6 - visibleWidth(titleText) - (detailText ? visibleWidth(detailText) + 2 : 0);
  if (fill < 1 && detailText) {
    detailText = '';
    fill = cardWidth - 6 - visibleWidth(titleText);
  }
  if (fill < 1) {
    titleText = truncate(stripStyles(titleText), Math.max(1, cardWidth - 7));
    fill = cardWidth - 6 - visibleWidth(titleText);
  }
  const top = margin + DIM + '╭─ ' + RESET + titleText + ' ' + DIM + '─'.repeat(Math.max(0, fill)) + RESET + (detailText ? ' ' + detailText + ' ' : '') + DIM + '─╮' + RESET;
  const side = DIM + '│' + RESET;
  const row = (line) => {
    const marked = line.startsWith(OPTION_MARK);
    const content = marked ? line.slice(2) : line;
    const padding = ' '.repeat(Math.max(0, inner - visibleWidth(content)));
    return (marked ? line.slice(0, 2) : '') + margin + side + '  ' + content + RESET + padding + '  ' + side;
  };
  const bottom = margin + DIM + '╰' + '─'.repeat(cardWidth - 2) + '╯' + RESET;
  return [top, row(''), ...body.map(row), row(''), bottom];
}

// "key label" chips on one row, wrapping onto more rows when they don't fit.
function hintRow(pairs, cols, margin) {
  const width = Math.max(10, cols - margin.length - 1);
  const rows = [];
  let row = [];
  let rowWidth = 0;
  for (const [key, does] of pairs) {
    const chipWidth = widthOf(`${key} ${does}`);
    if (row.length && rowWidth + 3 + chipWidth > width) {
      rows.push(row);
      row = [];
      rowWidth = 0;
    }
    row.push(BOLD + key + RESET + ' ' + DIM + truncate(does, Math.max(1, width - widthOf(key) - 1)) + RESET);
    rowWidth += (row.length > 1 ? 3 : 0) + Math.min(chipWidth, width);
  }
  if (row.length) rows.push(row);
  return rows.map((chips) => margin + ' ' + chips.join('   '));
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

function feedLine(step, textWidth, margin) {
  const [icon, color] = FEED_ICONS[step.kind] ?? ['·', DIM];
  const added = ` +${step.added ?? 0}`;
  const removed = ` −${step.removed ?? 0}`;
  const counts = step.kind === 'edit' ? GREEN + added + RESET + RED + removed + RESET : '';
  const countsWidth = step.kind === 'edit' ? widthOf(added + removed) : 0;
  return margin + color + icon + RESET + ' ' + truncate(step.text.split('\n')[0], textWidth - 2 - countsWidth) + counts;
}

const stripStyles = (text) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
const visibleWidth = (text) => widthOf(stripStyles(text));

function emptyFollowUp() {
  return { thread: [], draft: null, pendingAsk: null, failed: false };
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
