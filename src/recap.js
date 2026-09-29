import { changedFiles } from './activity-log.js';
import { isStillInCode } from './code-anchors.js';
import { BOLD, DIM, RESET, YELLOW } from './styles.js';
import { truncate, wrap } from './text-layout.js';

const MIN_VISIBLE_MS_FOR_RECAP = 15_000;
const MAX_FILES_LISTED = 8;
const MAX_CHECKLIST_ITEMS = 5;

/**
 * The questions the user got wrong point at the parts of the change they don't understand yet.
 * Only those whose code is still there are worth a look: a missed question about an approach Claude
 * has since reverted or rewritten says nothing about what is being merged.
 * @returns {{ file: string, question: string }[]}
 */
export function reviewChecklist(missedAnswers, { cwd, readFile = undefined }) {
  const items = [];
  for (const { question } of missedAnswers) {
    if (question.kind === 'predict' || !question.anchor) continue;
    if (items.some((item) => item.question === question.q)) continue;
    if (!isStillInCode(question.anchor, { cwd, readFile })) continue;
    items.push({ file: question.anchor.file, question: question.q });
  }
  return items.slice(0, MAX_CHECKLIST_ITEMS);
}

/**
 * The card shown when hyperfocus hands the screen back: what changed while the user was quizzed.
 * Skipped after a brief glance, when there is nothing the user missed.
 */
export function buildRecap({ run, summary, score, visibleMs, answeredThisVisit, reason = 'done', checklist = [] }) {
  if (visibleMs < MIN_VISIBLE_MS_FOR_RECAP && answeredThisVisit === 0 && checklist.length === 0) return null;
  return {
    reason,
    summary,
    changedFiles: changedFiles(run),
    score,
    checklist,
  };
}

/** The recap as a card: its title, a detail for the title bar, and the body lines (no indent). */
export function renderRecap(recap, { width }) {
  const { changedFiles: files, score } = recap;
  const lines = [];
  if (recap.summary) lines.push(...wrap(recap.summary, width), '');

  lines.push(BOLD + (files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed` : 'No files changed') + RESET);
  for (const path of files.slice(0, MAX_FILES_LISTED)) lines.push(DIM + '  ' + truncate(path, width - 2) + RESET);
  if (files.length > MAX_FILES_LISTED) lines.push(DIM + `  … and ${files.length - MAX_FILES_LISTED} more` + RESET);

  if (score.answered) lines.push('', `Quiz: ${score.correct}/${score.answered} correct`);
  if (recap.checklist?.length) {
    lines.push('', YELLOW + BOLD + 'Worth a look before you merge' + RESET);
    const fileWidth = Math.min(Math.max(...recap.checklist.map((item) => item.file.length)), Math.floor(width / 2));
    for (const { file, question } of recap.checklist) {
      const label = truncate(file, fileWidth).padEnd(fileWidth);
      lines.push('  ' + DIM + label + RESET + '  ' + truncate(question, Math.max(4, width - fileWidth - 4)));
    }
  }
  const detail = DIM + (recap.reason === 'done' ? 'Claude finished' : 'Claude needs your input') + RESET;
  return { title: BOLD + 'While you were away' + RESET, detail, lines };
}
