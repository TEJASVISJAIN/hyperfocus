import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';
import { readJsonLines } from './jsonl.js';

export const defaultSavedPath = () => join(dataDir(), 'saved.jsonl');
/** The readable notebook next to the log: rewritten from it after every save. */
export const notebookPath = (path = defaultSavedPath()) => path.replace(/\.jsonl$/, '') + '.md';

/**
 * Questions the user pressed `w` on: the question, their answer, how it went, the code it was about,
 * and any follow-up they asked. Kept as JSON lines, with a Markdown notebook rebuilt beside them.
 */
export function saveQuestion({ question, chosen, correct, thread = [] }, { cwd, files = [], path = defaultSavedPath(), now = new Date() }) {
  const entry = {
    ts: now.toISOString(),
    cwd,
    kind: question.kind ?? 'why',
    question: question.q,
    options: question.options,
    answer: question.answer,
    why: question.why,
    chosen,
    correct,
    ...(question.file ? { file: question.file } : {}),
    ...(question.code ? { code: question.code } : {}),
    ...(question.tags?.length ? { tags: question.tags } : {}),
    ...(thread.length ? { thread } : {}),
    files,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + '\n');
    writeFileSync(notebookPath(path), formatSaved(readSaved({ path })));
    return true;
  } catch (error) {
    debugLog('could not save question', error.message);
    return false;
  }
}

/** Saved questions, oldest first; only those from `cwd` when it is given. */
export function readSaved({ path = defaultSavedPath(), cwd = undefined } = {}) {
  return readJsonLines(path).filter((entry) => typeof entry?.question === 'string' && (!cwd || entry.cwd === cwd));
}

const letter = (index) => String.fromCharCode(65 + index);

function outcome(entry) {
  if (entry.chosen === null || entry.chosen === undefined) return 'skipped';
  if (entry.correct === true) return '✅ right';
  if (entry.correct === false) return '❌ wrong';
  return '⏳ waiting on the next edit';
}

/** The notebook: newest project first, and within it the questions in the order they were saved. */
export function formatSaved(entries) {
  if (!entries.length) return '# hyperfocus notebook\n\nNothing saved yet. Press `w` after answering a question to keep it here.\n';
  const projects = new Map();
  for (const entry of entries) projects.set(entry.cwd, [...(projects.get(entry.cwd) ?? []), entry]);
  const order = [...projects.entries()].sort((a, b) => b[1].at(-1).ts.localeCompare(a[1].at(-1).ts));
  const out = ['# hyperfocus notebook', ''];
  for (const [cwd, saved] of order) {
    out.push(`## ${basename(cwd) || cwd}`, '', `\`${cwd}\``, '');
    for (const entry of saved) {
      out.push(`### ${entry.question}`, '');
      out.push(`*${entry.ts.slice(0, 16).replace('T', ' ')} · ${entry.kind}${entry.tags?.length ? ' · ' + entry.tags.join(', ') : ''}${entry.file ? ' · `' + entry.file + '`' : ''}*`, '');
      if (entry.code) out.push('```', entry.code, '```', '');
      entry.options?.forEach((option, index) => {
        const marks = [index === entry.answer ? 'answer' : '', index === entry.chosen ? 'you' : ''].filter(Boolean);
        out.push(`- **${letter(index)}.** ${option}${marks.length ? ` ← ${marks.join(', ')}` : ''}`);
      });
      out.push('', `**Result:** ${outcome(entry)}`, '');
      if (entry.why) out.push(`**Why:** ${entry.why}`, '');
      for (const { ask, answer } of entry.thread ?? []) out.push(`> **You asked:** ${ask}`, '>', `> ${answer.replace(/\n/g, '\n> ')}`, '');
      if (entry.files?.length) out.push(`Files in that change: ${entry.files.map((file) => '`' + file + '`').join(', ')}`, '');
      out.push('---', '');
    }
  }
  return out.join('\n');
}
