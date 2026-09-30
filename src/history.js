import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { isStillInCode } from './code-anchors.js';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';
import { readJsonLines } from './jsonl.js';

export const defaultHistoryPath = () => join(dataDir(), 'history.jsonl');

const MAX_REVIEW_QUESTIONS = 10;

// Every answered or skipped question, kept for --stats and so --review can bring back the ones you missed.
export function createHistory({ path = defaultHistoryPath() } = {}) {
  return {
    append({ question, chosen, correct, skipped, rating = undefined }, { cwd, sessionId, files, source = 'live' }) {
      const entry = {
        ts: new Date().toISOString(),
        cwd,
        sessionId,
        source,
        kind: question.kind ?? 'why',
        question: question.q,
        options: question.options,
        answer: question.answer,
        why: question.why,
        ...(question.code ? { code: question.code, codeMarks: question.codeMarks } : {}),
        ...(question.anchor ? { anchor: question.anchor } : {}),
        ...(question.tags?.length ? { tags: question.tags } : {}),
        chosen,
        correct,
        skipped,
        ...(rating ? { rating } : {}),
        files,
      };
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(entry) + '\n');
      } catch (error) {
        debugLog('could not write history', error.message);
      }
    },
  };
}

// Entries for questions the user rated bad are left out of everything: review, stats, accuracy.
const readEntries = (path) => {
  const entries = readJsonLines(path).filter((entry) => entry?.cwd);
  const bad = new Set(entries.filter((entry) => entry.rating === 'bad').map((entry) => `${entry.cwd}\0${entry.question}`));
  return entries.filter((entry) => !bad.has(`${entry.cwd}\0${entry.question}`));
};

const AVOID_EXAMPLES = 5;

/** The latest questions rated bad in this project, for the prompt to steer away from. */
export function recentBadQuestions({ cwd, path = defaultHistoryPath() }) {
  const bad = readJsonLines(path).filter((entry) => entry?.cwd === cwd && entry.rating === 'bad' && typeof entry.question === 'string');
  return [...new Set(bad.map((entry) => entry.question))].slice(-AVOID_EXAMPLES);
}
const isText = (value) => typeof value === 'string';

/**
 * Questions in this project whose latest attempt was wrong and whose code is still there, newest
 * first, as questions ready to ask again. A question about a change that was since reverted or
 * rewritten (X, before the user steered Claude to Y) fails the code check and never comes back.
 */
export function missedStillInCode({ cwd, path = defaultHistoryPath(), readFile = undefined }) {
  const latest = new Map();
  for (const entry of readEntries(path)) {
    if (entry.cwd !== cwd || entry.skipped || typeof entry.question !== 'string') continue;
    latest.delete(entry.question); // re-inserting keeps the map in order of the latest attempt
    latest.set(entry.question, entry);
  }
  const due = [];
  for (const entry of [...latest.values()].reverse()) {
    if (entry.correct !== false || entry.kind === 'predict' || !entry.anchor) continue;
    // Hand-edited or damaged lines must not reach the screen: it assumes well-formed questions.
    if (!Array.isArray(entry.options) || entry.options.length < 2 || !entry.options.every(isText)) continue;
    if (!Number.isInteger(entry.answer) || entry.answer < 0 || entry.answer >= entry.options.length) continue;
    if (entry.code !== undefined && (!isText(entry.code) || !Array.isArray(entry.codeMarks))) continue;
    if (!isStillInCode(entry.anchor, { cwd, readFile })) continue;
    due.push({
      kind: entry.kind ?? 'why',
      q: entry.question,
      options: entry.options,
      answer: entry.answer,
      why: isText(entry.why) ? entry.why : '',
      ...(entry.code ? { code: entry.code, codeMarks: entry.codeMarks } : {}),
      anchor: entry.anchor,
    });
    if (due.length === MAX_REVIEW_QUESTIONS) break;
  }
  return due;
}

const RECENT_ANSWERS = 20;

/** How the latest answers in this project went, so new questions can be pitched harder or easier. */
export function recentAccuracy({ cwd, path = defaultHistoryPath() }) {
  const recent = readEntries(path)
    .filter((entry) => entry.cwd === cwd && !entry.skipped)
    .slice(-RECENT_ANSWERS);
  return { answered: recent.length, correct: recent.filter((entry) => entry.correct).length };
}

/** `~/code/app` for paths inside the home folder, the full path otherwise. */
export function projectLabel(path, home = homedir()) {
  return path === home || path.startsWith(home + sep) ? '~' + path.slice(home.length) : path;
}

/** @returns {{ cwd: string, answered: number, correct: number, skipped: number }[]} */
export function readStats(path = defaultHistoryPath()) {
  const byProject = new Map();
  for (const entry of readEntries(path)) {
    const stats = byProject.get(entry.cwd) ?? { cwd: entry.cwd, answered: 0, correct: 0, skipped: 0 };
    if (entry.skipped) stats.skipped++;
    else {
      stats.answered++;
      if (entry.correct) stats.correct++;
    }
    byProject.set(entry.cwd, stats);
  }
  return [...byProject.values()];
}

const DAY_MS = 24 * 3600_000;
const LATELY_DAYS = 30;
const MIN_TAG_ANSWERS = 3;
const WEAKEST_TAGS = 3;
const KIND_NAMES = { why: 'why', bug: 'spot the bug', output: 'what does it do', predict: 'predict' };

const tally = (entries) => ({ answered: entries.length, correct: entries.filter((entry) => entry.correct === true).length });
const localDay = (time) => new Date(time).toLocaleDateString('en-CA'); // YYYY-MM-DD in local time

/** What --stats says beyond the per-project table: trends, kinds, weak concepts, and the streak. */
export function readInsights({ path = defaultHistoryPath(), cwd = process.cwd(), now = Date.now() } = {}) {
  const answers = readEntries(path).filter((entry) => !entry.skipped && typeof entry.correct === 'boolean');
  const time = (entry) => Date.parse(entry.ts);

  const byKind = {};
  for (const entry of answers) {
    const kind = entry.kind in KIND_NAMES ? entry.kind : 'why';
    byKind[kind] = { answered: (byKind[kind]?.answered ?? 0) + 1, correct: (byKind[kind]?.correct ?? 0) + (entry.correct ? 1 : 0) };
  }

  const byTag = new Map();
  for (const entry of answers) {
    for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
      const counts = byTag.get(tag) ?? { tag, answered: 0, correct: 0 };
      counts.answered++;
      if (entry.correct) counts.correct++;
      byTag.set(tag, counts);
    }
  }
  const weakest = [...byTag.values()]
    .filter((counts) => counts.answered >= MIN_TAG_ANSWERS && counts.correct < counts.answered)
    .sort((a, b) => a.correct / a.answered - b.correct / b.answered || a.tag.localeCompare(b.tag))
    .slice(0, WEAKEST_TAGS);

  // Days in a row with at least one answer, ending today or yesterday.
  const days = new Set(answers.filter((entry) => Number.isFinite(time(entry))).map((entry) => localDay(time(entry))));
  let streak = 0;
  let day = days.has(localDay(now)) ? now : now - DAY_MS;
  while (days.has(localDay(day))) {
    streak++;
    day -= DAY_MS;
  }

  return {
    allTime: tally(answers),
    lately: tally(answers.filter((entry) => time(entry) >= now - LATELY_DAYS * DAY_MS)),
    byKind,
    weakest,
    project: tally(answers.filter((entry) => entry.cwd === cwd)),
    streak,
  };
}

const rightOf = ({ answered, correct }) => `${correct} of ${answered} right (${answered ? Math.round((correct / answered) * 100) : 0}%)`;

function formatInsights(insights) {
  const rows = [
    ['last 30 days', rightOf(insights.lately)],
    ['this project', rightOf(insights.project)],
    ...Object.entries(insights.byKind).map(([kind, counts]) => [KIND_NAMES[kind], rightOf(counts)]),
  ];
  const lines = ['', ...rows.filter(([, value]) => !value.startsWith('0 of 0')).map(([label, value]) => `  ${label.padEnd(16)}${value}`)];
  if (insights.weakest.length) lines.push('', '  worth studying', ...insights.weakest.map((counts) => `    ${counts.tag.padEnd(14)}${rightOf(counts)}`));
  if (insights.streak) lines.push('', `  ${'streak'.padEnd(16)}${insights.streak} day${insights.streak === 1 ? '' : 's'} in a row`);
  return [...lines, ''];
}

export function formatStats(stats, insights = undefined) {
  if (!stats.length) return 'No quiz answers recorded yet. Run `hyperfocus` and answer a few questions while Claude works.\n';

  const rows = stats.map((project) => ({ ...project, label: projectLabel(project.cwd) }));
  const total = rows.reduce(
    (sum, project) => ({ ...sum, answered: sum.answered + project.answered, correct: sum.correct + project.correct, skipped: sum.skipped + project.skipped }),
    { label: 'total', answered: 0, correct: 0, skipped: 0 },
  );
  const labelWidth = Math.max(7, ...rows.map((project) => project.label.length));
  const accuracy = ({ correct, answered }) => `${correct} (${answered ? Math.round((correct / answered) * 100) : 0}%)`;
  const format = (project) =>
    `  ${project.label.padEnd(labelWidth)}  ${String(project.answered).padStart(8)}  ${accuracy(project).padStart(9)}  ${String(project.skipped).padStart(7)}`;

  return [
    'hyperfocus quiz history',
    '',
    `  ${'project'.padEnd(labelWidth)}  ${'answered'.padStart(8)}  ${'correct'.padStart(9)}  ${'skipped'.padStart(7)}`,
    ...rows.map(format),
    format(total),
    ...(insights ? formatInsights(insights) : []),
    '',
  ].join('\n');
}
