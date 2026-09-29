// What we ask the quiz model, and how we read its answer.

/**
 * @typedef {{ q: string, options: string[], answer: number, why: string }} Question
 * @typedef {{ summary: string, questions: Question[] }} Batch
 */

export const SYSTEM_PROMPT =
  'You help a developer stay engaged with the change an AI coding agent is making in their codebase ' +
  'right now, so they understand it when they review it. Reply with only a JSON object, no prose.';

export function buildQuizPrompt(run, askedQuestions) {
  const sections = [`The developer asked the agent:\n<request>\n${run.prompt || '(no prompt captured)'}\n</request>`];

  if (run.reads.length) sections.push(`Files and searches the agent has looked at:\n${bullets(run.reads)}`);

  sections.push(
    run.edits.length
      ? `Changes so far (- removed, + added):\n${run.edits.map((edit) => `### ${edit.path}\n${edit.diff}`).join('\n\n')}`
      : 'No changes yet: the agent is still reading and planning.',
  );

  if (run.commands.length) sections.push(`Commands the agent ran:\n${bullets(run.commands)}`);
  if (askedQuestions.length) sections.push(`Questions already asked (do not repeat or rephrase these):\n${bullets(askedQuestions)}`);

  sections.push(
    [
      'Write:',
      '1. "summary": 1-3 plain sentences on what the agent is doing and why, for someone who looked away.',
      '2. "questions": 1-3 multiple-choice questions that make the developer think about THIS change: why it is',
      '   done this way, what could go wrong, edge cases, design tradeoffs. Never syntax or trivia.',
      '   If there are no changes yet, ask how the code being read currently works, or what the change will need to handle.',
      '   Each question: {"q": string, "options": [3-4 strings], "answer": 0-based index of the one correct option,',
      '   "why": one sentence explaining the answer}. Make the wrong options plausible.',
      '',
      'Reply with JSON only: {"summary": string, "questions": [...]}',
    ].join('\n'),
  );

  return sections.join('\n\n');
}

/** @returns {Batch | null} */
export function parseQuizReply(text) {
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
  return { summary: parsed.summary.trim(), questions: parsed.questions.filter(isWellFormedQuestion) };
}

function isWellFormedQuestion(question) {
  return (
    typeof question?.q === 'string' &&
    Array.isArray(question.options) &&
    question.options.length >= 2 &&
    question.options.every((option) => typeof option === 'string') &&
    Number.isInteger(question.answer) &&
    question.answer >= 0 &&
    question.answer < question.options.length &&
    typeof question.why === 'string'
  );
}

const bullets = (items) => items.map((item) => `- ${item}`).join('\n');

export const FOLLOW_UP_SYSTEM_PROMPT =
  'You answer a developer\'s follow-up question about a quiz question on the change an AI coding agent ' +
  'is making in their codebase. Answer in 2-4 plain sentences, grounded in the change shown. No markdown, no preamble.';

export function buildFollowUpPrompt(run, { question, chosen, ask, thread }) {
  const sections = [`The developer asked the agent:\n<request>\n${run?.prompt || '(no prompt captured)'}\n</request>`];
  if (run?.edits.length) {
    sections.push(`Changes (- removed, + added):\n${run.edits.map((edit) => `### ${edit.path}\n${edit.diff}`).join('\n\n')}`);
  }
  sections.push(
    [
      `Quiz question: ${question.q}`,
      ...question.options.map((option, index) => `${index + 1}) ${option}`),
      `Correct answer: ${question.answer + 1}) ${question.options[question.answer]}`,
      `The developer picked: ${chosen === null ? '(skipped)' : `${chosen + 1}) ${question.options[chosen]}`}`,
      `Explanation shown: ${question.why}`,
    ].join('\n'),
  );
  if (thread.length) {
    sections.push(`Earlier follow-ups:\n${thread.map((turn) => `Developer: ${turn.ask}\nYou: ${turn.answer}`).join('\n\n')}`);
  }
  sections.push(`The developer's follow-up question:\n${ask}`);
  return sections.join('\n\n');
}
