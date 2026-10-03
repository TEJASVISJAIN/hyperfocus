// What we ask the quiz model, and how we read its answer.
import { changedFiles } from './activity-log.js';

/**
 * @typedef {'why' | 'bug' | 'output' | 'predict'} QuestionKind
 * @typedef {{
 *   kind: QuestionKind, q: string, options: string[], answer: number | null, why: string,
 *   file?: string, code?: string, codeMarks?: string[], tags?: string[],
 *   anchor?: { file: string, anchors: string[] }, plan?: string, repeat?: boolean
 * }} Question
 * `plan` is the prompt a question about the agent's plan (asked before any edit) is about.
 * `repeat` marks a missed question asked again on schedule (see history.js).
 * @typedef {{ summary: string, questions: Question[] }} Batch
 */

const MAX_CODE_LINES = 10;
// One idea in two lines at most, with options short enough to read at a glance. The prompt asks
// for less; these are the limits past which a question is dropped.
export const MAX_QUESTION_CHARS = 180;
export const MAX_OPTION_CHARS = 90;
// Below this many answers, accuracy says little about how hard the questions should be.
const ANSWERS_BEFORE_ADAPTING = 5;

const KIND_INSTRUCTIONS = {
  why: '"why": why the change is done this way, what could go wrong, edge cases, design tradeoffs.',
  bug:
    '"bug": spot the weakness. Put 2-8 lines copied exactly from the changes in "code" and ask what is wrong with ' +
    'them or what they miss. Only when there is a real weakness; the correct option names it.',
  output:
    '"output": put 2-8 lines copied exactly from the changes in "code" and ask what they return or do for one ' +
    'specific input.',
  predict:
    '"predict": at most one, "Which file will the agent edit next?", with 3-4 file paths as options taken from the ' +
    'files read or changed. Set "answer" to null: what the agent does next decides it.',
};

// A fixed vocabulary, so --stats can group answers the same way over months.
export const CONCEPT_TAGS = [
  'error-handling', 'concurrency', 'state', 'data-flow', 'types', 'api-design',
  'edge-cases', 'testing', 'performance', 'security', 'structure', 'tooling',
];

export const SYSTEM_PROMPT =
  'You help a developer stay engaged with the change an AI coding agent is making in their codebase ' +
  'right now, so they understand it when they review it. Reply with only a JSON object, no prose.';

const briefSection = (brief) => `About this project (background only; ask about the request and the changes, not this):\n<project>\n${brief}\n</project>`;

export function buildQuizPrompt(run, askedQuestions, { kinds = ['why'], count = 3, accuracy = undefined, context = [], avoid = [], brief = null } = {}) {
  const sections = [];
  if (brief) sections.push(briefSection(brief));
  sections.push(`The developer asked the agent:\n<request>\n${run.prompt || '(no prompt captured)'}\n</request>`);

  if (run.reads.length) sections.push(`Files and searches the agent has looked at:\n${bullets(run.reads)}`);

  sections.push(
    run.edits.length
      ? `Changes so far (- removed, + added):\n${run.edits.map((edit) => `### ${edit.path}\n${edit.diff}`).join('\n\n')}`
      : 'No changes yet: the agent is still reading and planning.',
  );

  if (context.length) {
    sections.push(
      'The code around those changes as it is now, only to understand the changes; every question must still be about the changes above:\n' +
        context.map(({ file, text }) => `<context file="${file}">\n${text}\n</context>`).join('\n'),
    );
  }

  if (run.commands.length) sections.push(`Commands the agent ran:\n${bullets(run.commands)}`);
  if (askedQuestions.length) sections.push(`Questions already asked (do not repeat or rephrase these):\n${bullets(askedQuestions)}`);

  if (avoid.length) sections.push(`The developer rated these questions as bad; do not ask anything like them:\n${bullets(avoid)}`);

  const allowedKinds = kindsFor(run, kinds);
  sections.push(
    [
      'Write:',
      `1. "questions": 1-${count} questions that make the developer think about THIS change. Never syntax or trivia.`,
      '   If there are no changes yet, ask about the plan for the request: what it will need to handle, what could go',
      '   wrong, how the code being read works. Such a question names the request, e.g. "To add retry to token refresh, …".',
      '   One idea per question: at most 120 characters, no preamble. Options of a few words each (at most 8).',
      '   Ask about the code and the request, never about notes, memory or instructions.',
      '   Each question has a "kind", one of:',
      ...allowedKinds.map((kind) => `   - ${KIND_INSTRUCTIONS[kind]}`),
      '   Each question: {"kind": string, "q": string, "options": [3-4 strings], "answer": 0-based index of the one',
      '   correct option, "why": one sentence explaining the answer, "file": the path it is mostly about (optional),',
      `   "code": lines copied exactly from the changes (optional${codeRequiredFor(allowedKinds)})}.`,
      `   Also "tags": 1-2 of ${CONCEPT_TAGS.join(', ')}: what the question is really about.`,
      '   Make the wrong options plausible.',
      ...difficulty(accuracy),
      '2. "summary": 1-3 plain sentences on what the agent is doing and why, for someone who looked away.',
      '',
      'Reply with JSON only, questions first: {"questions": [...], "summary": string}',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

// Predictions need a run still going; with nothing else left, "why" questions stand in.
function kindsFor(run, kinds) {
  const allowed = kinds.filter((kind) => kind !== 'predict' || !run?.finished);
  return allowed.length ? allowed : ['why'];
}

function codeRequiredFor(kinds) {
  const needCode = kinds.filter((kind) => kind === 'bug' || kind === 'output').map((kind) => `"${kind}"`);
  return needCode.length ? `, required for ${needCode.join(' and ')}` : '';
}

function difficulty(accuracy) {
  if (!accuracy || accuracy.answered < ANSWERS_BEFORE_ADAPTING) return [];
  const rate = accuracy.correct / accuracy.answered;
  if (rate >= 0.8) return ['   The developer gets most questions right: make these harder, with subtler failure modes and closer wrong options.'];
  if (rate <= 0.4) return ['   The developer is finding these hard: make them easier, more concrete, with clearly distinct options.'];
  return [];
}

/**
 * Reads the model's reply, keeping only questions that are well formed, of a kind the user wants,
 * and grounded in this run: files it touched and code it really wrote.
 * @returns {Batch | null}
 */
export function parseQuizReply(text, { run, kinds = ['why'] }) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed?.summary !== 'string' || !Array.isArray(parsed.questions)) return null;
  const grounding = groundingFor(run);
  const allowed = kindsFor(run, kinds);
  const questions = parsed.questions.map((question) => toQuestion(question, { run, kinds: allowed, grounding })).filter(Boolean);
  return { summary: parsed.summary.trim(), questions };
}

/**
 * The questions a reply has finished writing so far, in order, before the reply is complete: each
 * object in the "questions" array once its closing brace has arrived. Validate them with
 * `questionChecker` before use.
 * @param {string} text the reply so far
 * @returns {unknown[]}
 */
export function streamedQuestions(text) {
  const key = text.search(/"questions"\s*:\s*\[/);
  if (key === -1) return [];
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let at = text.indexOf('[', key) + 1; at < text.length; at++) {
    const char = text[at];
    if (inString) {
      if (char === '\\') at++;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') {
      if (depth === 0) start = at;
      depth++;
    } else if (char === '}' || char === ']') {
      if (depth === 0) break; // the end of the array
      depth--;
      if (depth === 0 && char === '}') {
        try {
          found.push(JSON.parse(text.slice(start, at + 1)));
        } catch {
          found.push(null);
        }
      }
    }
  }
  return found;
}

/** Checks one raw question the way `parseQuizReply` does, for questions read from a stream. */
export function questionChecker({ run, kinds = ['why'] }) {
  const grounding = groundingFor(run);
  const allowed = kindsFor(run, kinds);
  return (raw) => toQuestion(raw, { run, kinds: allowed, grounding });
}

function toQuestion(raw, { run, kinds, grounding }) {
  if (typeof raw?.q !== 'string' || !isOptionList(raw.options)) return null;
  if (raw.q.trim().length > MAX_QUESTION_CHARS || raw.options.some((option) => option.length > MAX_OPTION_CHARS)) return null;
  const kind = typeof raw.kind === 'string' && raw.kind in KIND_INSTRUCTIONS ? raw.kind : 'why';
  if (!kinds.includes(kind)) return null;

  /** @type {Question} */
  const question = { kind, q: raw.q, options: raw.options, answer: null, why: typeof raw.why === 'string' ? raw.why : '' };
  if (typeof raw.file === 'string' && grounding.files.has(raw.file)) question.file = raw.file;
  const excerpt = typeof raw.code === 'string' ? excerptFrom(raw.code, grounding) : null;
  if (excerpt) Object.assign(question, excerpt);
  const tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((tag) => CONCEPT_TAGS.includes(tag)))].slice(0, 2) : [];
  if (tags.length) question.tags = tags;

  if (kind === 'predict') return run?.finished ? null : question;
  if (!Number.isInteger(raw.answer) || raw.answer < 0 || raw.answer >= raw.options.length || typeof raw.why !== 'string') return null;
  if ((kind === 'bug' || kind === 'output') && !excerpt) return null;
  question.answer = raw.answer;
  return question;
}

const isOptionList = (options) => Array.isArray(options) && options.length >= 2 && options.every((option) => typeof option === 'string');

// What a question may point at: the files the run touched and the lines its diffs added or removed.
function groundingFor(run) {
  const files = new Set([...changedFiles(run), ...(run?.reads ?? [])]);
  const lineMarks = new Map();
  for (const edit of run?.edits ?? []) {
    for (const line of edit.diff.split('\n')) {
      const mark = line.slice(0, 1);
      if ((mark !== '+' && mark !== '-') || line[1] !== ' ') continue;
      const text = line.slice(2).trim();
      if (text && lineMarks.get(text) !== '+') lineMarks.set(text, mark);
    }
  }
  return { files, lineMarks };
}

// A code excerpt is shown as real code, so every line of it must come from the run's diffs.
function excerptFrom(code, { lineMarks }) {
  const lines = code.split('\n').filter((line) => line.trim()).slice(0, MAX_CODE_LINES);
  if (lines.length === 0 || !lines.every((line) => lineMarks.has(line.trim()))) return null;
  const indent = Math.min(...lines.map((line) => line.length - line.trimStart().length));
  return { code: lines.map((line) => line.slice(indent)).join('\n'), codeMarks: lines.map((line) => lineMarks.get(line.trim())) };
}

/** Options in a random order, so the right answer's position gives nothing away. */
export function shuffleOptions(question, random = Math.random) {
  const order = question.options.map((_, index) => index);
  for (let index = order.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [order[index], order[other]] = [order[other], order[index]];
  }
  return {
    ...question,
    options: order.map((index) => question.options[index]),
    answer: question.answer === null ? null : order.indexOf(question.answer),
  };
}

const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

export const FOLLOW_UP_SYSTEM_PROMPT =
  'You answer a developer\'s follow-up question about a quiz question on the change an AI coding agent ' +
  'is making in their codebase. Answer in 2-4 plain sentences, grounded in the change shown. Stay on the quiz ' +
  'question\'s topic: if the follow-up wanders off it, answer briefly and bring it back. No markdown, no preamble.';

export const LESSON_SYSTEM_PROMPT =
  'You give a developer a short lesson after they got a quiz question wrong about the change an AI coding agent ' +
  'is making in their codebase. Name the idea behind the question, explain it in 3-5 plain sentences using their ' +
  'own code shown as the example, and say why the right answer follows. No markdown, no preamble.';

export const LESSON_ASK = 'Teach me the idea behind this question.';

/**
 * The prompt for a follow-up, or for the lesson after a miss (`ask` is then `LESSON_ASK`). Both are
 * anchored to the question and the code it is about, so the answer doesn't drift.
 * @param {any} run
 * @param {{ question: Question, chosen: number | null, ask: string, thread: { ask: string, answer: string }[], context?: { file: string, text: string }[], brief?: string | null }} request
 */
export function buildFollowUpPrompt(run, { question, chosen, ask, thread, context = [], brief = null }) {
  const sections = [];
  if (brief) sections.push(briefSection(brief));
  sections.push(`The developer asked the agent:\n<request>\n${run?.prompt || question.plan || '(no prompt captured)'}\n</request>`);
  if (run?.edits.length) {
    sections.push(`Changes (- removed, + added):\n${run.edits.map((edit) => `### ${edit.path}\n${edit.diff}`).join('\n\n')}`);
  }
  sections.push(
    [
      `Quiz question: ${question.q}`,
      ...(question.code ? [`Code it is about:\n${question.code}`] : []),
      ...question.options.map((option, index) => `${index + 1}) ${option}`),
      question.answer === null
        ? 'This is a prediction about what the agent does next; there is no answer yet.'
        : `Correct answer: ${question.answer + 1}) ${question.options[question.answer]}`,
      `The developer picked: ${chosen === null ? '(skipped)' : `${chosen + 1}) ${question.options[chosen]}`}`,
      `Explanation shown: ${question.why}`,
    ].join('\n'),
  );
  if (context.length) sections.push('The code the question is about, as it is now:\n' + context.map(({ file, text }) => `<context file="${file}">\n${text}\n</context>`).join('\n'));
  if (thread.length) {
    sections.push(`Earlier follow-ups:\n${thread.map((turn) => `Developer: ${turn.ask}\nYou: ${turn.answer}`).join('\n\n')}`);
  }
  sections.push(`The developer's follow-up question:\n${ask}`);
  return sections.join('\n\n');
}
