import { truncate, widthOf, wrap } from './text-layout.js';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const INVERSE = '\x1b[7m';
const RESET = '\x1b[0m';
const INDENT = '  ';

/**
 * The quiz screen shown while the agent works: a status line, the running summary and one
 * question at a time. State survives switching back to Claude, so an unanswered question is
 * still there next time.
 *
 * `onAnswer` receives { question, chosen, correct, skipped } for every answered or skipped question.
 */
export function createFocusView({ onAnswer }) {
  let activity = 'thinking';
  let activityStartedAt = Date.now();
  let summary = '';
  const queue = [];
  let feedback = null; // { question, chosen } after an answer, until the next key
  let answered = 0;
  let correct = 0;

  const current = () => queue[0];

  function next() {
    feedback = null;
    queue.shift();
  }

  return {
    get queuedQuestions() {
      return queue.length - (feedback ? 1 : 0);
    },
    get score() {
      return { answered, correct };
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
      summary = '';
      answered = 0;
      correct = 0;
      activity = 'thinking';
      activityStartedAt = startedAt;
    },

    handleKey(key) {
      const question = current();
      if (!question) return;
      if (feedback) return next();
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
      const summaryBlock = [
        DIM + "What's happening" + RESET,
        ...(summary ? wrap(summary, textWidth) : ['Watching the agent…']).map((line) => INDENT + line),
        '',
      ];
      const questionBlock = renderQuestion(textWidth);

      // The question matters most: trim the summary first when the terminal is short.
      const summaryRoom = Math.max(0, rows - header.length - questionBlock.length);
      const fittedSummary = summaryRoom >= summaryBlock.length ? summaryBlock : [...summaryBlock.slice(0, summaryRoom - 1), ''];
      const screen = [...header, ...(summaryRoom > 1 ? fittedSummary : []), ...questionBlock].slice(0, rows);
      return screen.join('\r\n');
    },
  };

  function statusLine(cols, now) {
    const hint = 'Ctrl-] back to Claude ';
    const left = ` focus · ${activity} · ${formatElapsed(now - activityStartedAt)} `;
    const room = cols - widthOf(hint);
    const fitted = room >= 12 ? truncate(left, room) : truncate(left, cols);
    const padding = ' '.repeat(Math.max(0, cols - widthOf(fitted) - (room >= 12 ? widthOf(hint) : 0)));
    return INVERSE + fitted + padding + (room >= 12 ? hint : '') + RESET;
  }

  function renderQuestion(textWidth) {
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
      INDENT + DIM + 'press any key for the next question' + RESET,
    );
    return lines;

    function optionStyle(index) {
      if (index === question.answer) return GREEN;
      if (index === feedback.chosen) return RED;
      return DIM;
    }
  }
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`;
}
