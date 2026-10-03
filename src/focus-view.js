import { renderRecap } from './recap.js';
import { BLUE, BOLD, CYAN, DIM, GREEN, INDENT, INVERSE, MAGENTA, RED, RESET, YELLOW, stripColor } from './styles.js';
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

export const INTRO_TITLE = 'Welcome to hyperfocus';
// Shown the first time the quiz takes the screen, and by `hyperfocus --intro`.
export const introLines = (agent = 'Claude') => [
  `${agent} is busy, so hyperfocus switched to a quiz about the change it is making.`,
  `The moment ${agent} finishes or needs you, you are back in ${agent} with a recap.`,
  '',
  `Esc          back to ${agent} now`,
  `Ctrl-]       switch between ${agent} and the quiz any time`,
  '↑↓ Enter     choose and answer, or press 1–4',
  's            skip a question',
  'w            save an answered question to your notebook (hyperfocus --saved)',
  `l            show what ${agent} is doing right now`,
];

/**
 * The quiz screen shown while the agent works: a status line, Claude's plan, the running summary,
 * one question at a time, and below it a live feed of the agent's steps and a peek at Claude's own
 * screen. State survives switching back to Claude, so an unanswered question is still there next time.
 *
 * Callbacks:
 * - `onAnswer({ question, chosen, correct, skipped, rating? })` for every answered or skipped question; a
 *   prediction is reported when Claude's next edit settles it; `b` reports `rating: 'bad'`, skipped
 * - `onFollowUp({ question, chosen, ask, thread })` when the user asks their own follow-up;
 *   answer with `setFollowUpAnswer` or `setFollowUpFailed`
 * - `onBack()` / `onKeepGoing()` for the choice offered by `showFinished`
 * - `onSave({ question, chosen, correct, thread })` when the user presses `w` on an answered question,
 *   to keep it in their notebook; returns whether it was saved
 * - `onQuiet()` when the user presses `z`: no more automatic quizzes this session
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
  onQuiet = undefined,
  onSave = undefined,
  agentName = 'Claude', // what the agent is called on screen
  title = 'hyperfocus',
  backHint = `Esc back to ${agentName}`,
  idleText = 'Thinking of a question about this change…',
  spinner = true,
  summaryHeading = "What's happening",
  live = false, // start with the live panel (feed and peek) open; `l` toggles it
  liveToggle = true, // offer `l` at all (review mode has no agent to watch)
  color = true, // false for NO_COLOR: styles stay, colours go
  animations = true, // false: the spinner stands still
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
  let intro = null; // { onDismiss } while the first-run intro is up
  let confirmingQuiet = false; // `z` pressed once: a second `z` goes quiet, anything else cancels
  let finished = null; // { reason, changedFiles, score } while offering "back to Claude or keep going"
  let pendingPredictions = []; // { question, chosen } waiting for Claude's next edit
  let result = null; // { text, good, at }: how the latest prediction turned out
  let progress = null;
  let feed = [];
  let peek = [];
  let liveShown = live && liveToggle;
  let clickRows = new Map(); // screen row (1-based) → the key a click there stands for
  const ids = new WeakMap(); // question → its number in this session, so other surfaces can name it
  let lastId = 0;

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

  function skip(question) {
    results.push('skip');
    onAnswer({ question, chosen: null, correct: null, skipped: true });
    next();
  }

  // A bad question: reported as skipped and rated, so it never counts, comes back or repeats.
  function rateBad(question) {
    if (!feedback) results.push('skip');
    pendingPredictions = pendingPredictions.filter((pending) => pending.question !== question);
    onAnswer({ question, chosen: null, correct: null, skipped: true, rating: 'bad' });
    next();
  }

  function save(question) {
    if (feedback.saved) return;
    const isCorrect = question.kind === 'predict' ? null : feedback.chosen === question.answer;
    feedback.saved = onSave({ question, chosen: feedback.chosen, correct: isCorrect, thread: [...followUp.thread] }) !== false;
  }

  function askFollowUp(ask) {
    followUp = { ...followUp, draft: null, pendingAsk: ask, failed: false };
    onFollowUp?.({ question: feedback.question, chosen: feedback.chosen, ask, thread: [...followUp.thread] });
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
      if (ask) askFollowUp(ask);
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
    showIntro(onDismiss) {
      intro = { onDismiss };
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
      for (const question of questions) ids.set(question, ++lastId);
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
          result = { text: `${agentName} edited ${path}, which wasn't an option`, good: null, at };
          continue;
        }
        const isCorrect = guess === path;
        score(isCorrect);
        onAnswer({ question, chosen, correct: isCorrect, skipped: false });
        result = isCorrect
          ? { text: `✔ Prediction right: ${agentName} edited ${path}`, good: true, at }
          : { text: `✘ Prediction missed: ${agentName} edited ${path}, not ${guess}`, good: false, at };
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
      if (intro) {
        const { onDismiss } = intro;
        intro = null;
        onDismiss();
        return key === ESC && onExit ? onExit() : undefined;
      }
      if (recap) {
        const { onDismiss } = recap;
        recap = null;
        return onDismiss();
      }
      if (followUp.draft !== null) return handleDraftKey(key);
      if (key === 'l' && liveToggle) return void (liveShown = !liveShown);
      if (key === ESC && onExit) return onExit();
      // Two presses, so a stray "z" typed into the wrong screen doesn't silence the session.
      if (confirmingQuiet) {
        confirmingQuiet = false;
        if (key === 'z') return onQuiet();
        return;
      }
      if (key === 'z' && onQuiet && !feedback) return void (confirmingQuiet = true);

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

      if (key === 'b') return rateBad(question);
      if (feedback) {
        if (key === 'w' && onSave) return save(question);
        if (key === 'f' && followUp.pendingAsk === null) return void (followUp.draft = '');
        return next();
      }
      if (arrow) return void (selected = (selected + arrow + question.options.length) % question.options.length);
      if (key === ENTER) return answer(question, selected);
      if (key === 's') return skip(question);
      const chosen = Number(key) - 1;
      if (!/^[1-9]$/.test(key) || chosen >= question.options.length) return;
      answer(question, chosen);
    },

    /**
     * What this view shows, as plain data for other surfaces (the VS Code panel). The answer and
     * why stay out until the user has answered.
     */
    snapshot() {
      const question = current();
      const isPredict = question?.kind === 'predict';
      return {
        agent: { activity, since: activityStartedAt, busy: !IDLE_ACTIVITIES.has(activity), finished: Boolean(finished) },
        run: { summary },
        question: question
          ? {
              id: ids.get(question) ?? 0,
              number: seen + 1,
              kind: question.kind ?? 'why',
              q: question.q,
              options: [...question.options],
              ...(question.code ? { code: question.code } : {}),
              ...(question.file ? { file: question.file } : {}),
              ...(question.anchor ? { anchor: question.anchor } : {}),
              ...(question.tags?.length ? { tags: [...question.tags] } : {}),
            }
          : null,
        queued: Math.max(0, queue.length - 1),
        feedback: feedback
          ? {
              chosen: feedback.chosen,
              correct: isPredict ? null : feedback.chosen === question.answer,
              answer: isPredict ? null : question.answer,
              why: isPredict ? null : question.why,
              saved: Boolean(feedback.saved),
            }
          : null,
        thread: [...followUp.thread.map(({ ask, answer }) => ({ ask, answer })), ...(followUp.pendingAsk !== null ? [{ ask: followUp.pendingAsk, answer: null }] : [])],
        followUpFailed: followUp.failed,
        score: { answered, correct, streak },
        result: result ? { text: result.text, good: result.good } : null,
      };
    },

    /**
     * Does what a key would, for a surface that names its action instead of pressing it. An action
     * naming a question (`id`) that is no longer on screen is 'stale'; one that makes no sense right
     * now is 'ignored'. The same rules as the keys apply: while the "agent finished" choice is up,
     * only answering, skipping, keep going and back do anything.
     * @param {{ type: string, id?: number, chosen?: number, ask?: string, rating?: string }} action
     * @returns {'ok' | 'stale' | 'ignored'}
     */
    act(action) {
      const question = current();
      if (action.id !== undefined && action.id !== (question && ids.get(question))) return 'stale';
      const blockedByFinished = finished && !['answer', 'skip', 'keepGoing', 'back', 'quiet'].includes(action.type);
      if (blockedByFinished) return 'ignored';
      switch (action.type) {
        case 'answer': {
          const { chosen } = action;
          if (!question || feedback || !Number.isInteger(chosen) || chosen < 0 || chosen >= question.options.length) return 'ignored';
          if (finished) keepGoing();
          answer(question, chosen);
          return 'ok';
        }
        case 'skip':
          if (!question || feedback) return 'ignored';
          if (finished) keepGoing();
          skip(question);
          return 'ok';
        case 'next':
          if (!feedback) return 'ignored';
          next();
          return 'ok';
        case 'rate':
          if (!question || action.rating !== 'bad') return 'ignored';
          rateBad(question);
          return 'ok';
        case 'save':
          if (!feedback || !onSave) return 'ignored';
          save(question);
          return 'ok';
        case 'followUp': {
          const ask = typeof action.ask === 'string' ? action.ask.trim() : '';
          if (!feedback || !ask || followUp.pendingAsk !== null || !onFollowUp) return 'ignored';
          askFollowUp(ask);
          return 'ok';
        }
        case 'keepGoing':
          if (!finished) return 'ignored';
          keepGoing();
          return 'ok';
        case 'back':
          if (!finished || !onBack) return 'ignored';
          onBack();
          return 'ok';
        case 'quiet':
          if (!onQuiet) return 'ignored';
          onQuiet();
          return 'ok';
        default:
          return 'ignored';
      }
    },

    render({ cols, rows, now = Date.now() }) {
      syncSelection();
      const margin = cols >= 30 ? INDENT : '';
      const cardWidth = Math.max(12, Math.min(cols - margin.length * 2, MAX_CARD_WIDTH));
      const inner = Math.max(6, cardWidth - 6);
      const box = { margin, cardWidth, inner };
      const header = [statusLine(cols, now), ...planLine(cols - 2), ...resultLine(cols - 2, now), ''];

      if (intro) {
        // Key lines keep their spacing, which lines the keys up, whenever they fit.
        const body = introLines(agentName).flatMap((line) => (!line ? [''] : widthOf(line) <= inner ? [line] : wrap(line, inner)));
        const screen = [...header, ...card(box, BOLD + INTRO_TITLE + RESET, '', body), ...hintRow([['any key', 'start']], cols, margin)];
        return finish(screen.slice(0, rows));
      }
      if (recap) {
        const { title: recapTitle, detail, lines: body } = renderRecap(recap.card, { width: inner, agentName });
        const screen = [...header, ...card(box, recapTitle, detail, body), ...hintRow([['any key', `back to ${agentName}`]], cols, margin)];
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
      const peekBlock = !liveShown ? [] : fitSection(agentName, peek.slice(-MAX_PEEK_LINES).map(peekLine), room, cols);

      return finish([...header, ...mainBlock, ...fittedSummary, ...feedBlock, ...peekBlock].slice(0, rows));
    },
  };
  return view;

  // Remembers which rows are options, so a click there can answer. Only rows the question itself
  // marked count: a peek or summary line that happens to read "1) …" is not an option.
  function finish(rowsShown) {
    clickRows = new Map();
    const optionsClickable = current() && !feedback && !recap && !intro;
    const lines = rowsShown.map((line, index) => {
      if (!line.startsWith(OPTION_MARK)) return line;
      if (optionsClickable) clickRows.set(index + 1, line[1]);
      return line.slice(2);
    });
    const drawn = lines.join('\r\n');
    return color ? drawn : stripColor(drawn);
  }

  function statusLine(cols, now) {
    const hint = backHint + ' ';
    const frame = !spinner || IDLE_ACTIVITIES.has(activity) ? '' : `${animations ? SPINNER[Math.floor(now / 1000) % SPINNER.length] : '·'} `;
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
    const back = onExit ? [['esc', `back to ${agentName}`]] : [];
    const quiet = onQuiet ? [['z', 'quiet']] : [];
    const question = current();
    if (confirmingQuiet) return [['z', 'again: no more automatic quizzes this session'], ['any other key', 'cancel']];
    if (!question) {
      return [
        ...(onExit ? [['enter or esc', `back to ${agentName}`]] : []),
        ...(liveToggle && !liveShown ? [['l', `see what ${agentName} is doing`]] : live),
        ...(onQuiet ? [['z', 'quiet for this session']] : []),
      ];
    }
    if (followUp.draft !== null) return [['enter', 'ask'], ['esc', 'cancel']];
    if (!feedback) return [['↑↓', 'choose'], ['enter', 'answer'], ['s', 'skip'], ['b', 'bad question'], ...live, ...quiet, ...back];
    const save = !onSave ? [] : feedback.saved ? [['✓', 'saved']] : [['w', 'save']];
    if (followUp.pendingAsk !== null) return [...save, ['any key', 'next question'], ...back];
    return [['f', 'ask a follow-up'], ...save, ['any key', 'next question'], ...live, ...back];
  }

  function renderFinished({ margin, inner }, cols) {
    if (!finished || !current()) return [];
    const files = finished.changedFiles.length;
    const headline = [
      finished.reason === 'done' ? `${agentName} finished` : `${agentName} needs your input`,
      files ? `${files} file${files === 1 ? '' : 's'} changed` : 'no files changed',
      ...(finished.score.answered ? [`quiz ${finished.score.correct}/${finished.score.answered}`] : []),
    ].join(' · ');
    return [
      margin + GREEN + BOLD + '✔ ' + truncate(headline, Math.max(4, inner)) + RESET,
      ...hintRow([['enter', `back to ${agentName}`], ['c', 'keep going']], cols, margin),
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
        body.push(...wrap(`Locked in: ${question.options[feedback.chosen]}. The next file ${agentName} edits settles it.`, inner));
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
    const dots = results.slice(-MAX_DOTS).map((outcome) => (outcome === 'right' ? GREEN + '●' : outcome === 'wrong' ? RED + (color ? '●' : '✗') : DIM + '○') + RESET).join('');
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
