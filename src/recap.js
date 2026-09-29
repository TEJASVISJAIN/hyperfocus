import { changedFiles } from './activity-log.js';
import { BOLD, DIM, INDENT, RESET } from './styles.js';
import { truncate, wrap } from './text-layout.js';

const MIN_VISIBLE_MS_FOR_RECAP = 15_000;
const MAX_FILES_LISTED = 8;

/**
 * The card shown when focus hands the screen back: what changed while the user was quizzed.
 * Skipped after a brief glance, when there is nothing the user missed.
 */
export function buildRecap({ run, summary, score, visibleMs, answeredThisVisit, reason = 'done' }) {
  if (visibleMs < MIN_VISIBLE_MS_FOR_RECAP && answeredThisVisit === 0) return null;
  return {
    reason,
    summary,
    changedFiles: changedFiles(run),
    score,
  };
}

export function renderRecap(recap, { cols }) {
  const textWidth = Math.max(10, cols - INDENT.length * 2);
  const { changedFiles: files, score } = recap;
  const heading = recap.reason === 'done' ? 'Claude finished' : 'Claude needs your input';

  const lines = [`${BOLD}While you were away${RESET}${DIM} · ${heading}${RESET}`, ''];
  if (recap.summary) lines.push(...wrap(recap.summary, textWidth).map((line) => INDENT + line), '');

  lines.push(INDENT + (files.length ? `${files.length} file${files.length === 1 ? '' : 's'} changed` : 'No files changed'));
  for (const path of files.slice(0, MAX_FILES_LISTED)) lines.push(INDENT + DIM + '  ' + truncate(path, textWidth - 2) + RESET);
  if (files.length > MAX_FILES_LISTED) lines.push(INDENT + DIM + `  … and ${files.length - MAX_FILES_LISTED} more` + RESET);

  if (score.answered) lines.push('', INDENT + `Quiz: ${score.correct}/${score.answered} correct`);
  lines.push('', INDENT + DIM + 'press any key to go back to Claude' + RESET);
  return lines;
}
