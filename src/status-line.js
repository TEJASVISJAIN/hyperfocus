import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CYAN, DIM, RESET, colorAllowed, stripColor } from './styles.js';

const statusScript = fileURLToPath(new URL('../bin/hyperfocus-status.js', import.meta.url));

/**
 * What the status line under Claude's input box shows, so it's always clear hyperfocus is running.
 * @typedef {{ ready: number, answered: number, correct: number, quiet: boolean }} Status
 */

/** @param {Status} status */
export function statusLineText({ ready, answered, correct, quiet }, env = process.env) {
  const parts = [
    ...(quiet ? ['quiet'] : []),
    ...(ready > 0 ? [`${ready} question${ready === 1 ? '' : 's'} ready`] : []),
    ...(answered > 0 ? [`${correct}/${answered} right`] : []),
    ready > 0 ? 'Ctrl-] to answer' : 'Ctrl-] for the quiz',
  ];
  const text = `${CYAN}◐ hyperfocus${RESET}${DIM} · ${parts.join(' · ')}${RESET}`;
  return colorAllowed(env) ? text : stripColor(text);
}

/** The status from the same snapshot the panel bridge publishes. */
export function statusFromSnapshot({ question, feedback, queued, score, quiet = false }) {
  return {
    ready: (question && !feedback ? 1 : 0) + queued,
    answered: score.answered,
    correct: score.correct,
    quiet: Boolean(quiet),
  };
}

/** Written whenever the session changes; the status-line script reads it each time Claude asks. */
export function writeStatus(path, status) {
  writeFileSync(path + '.tmp', JSON.stringify(status));
  renameSync(path + '.tmp', path);
}

/** @returns {Status} */
export function readStatus(path) {
  try {
    return { ready: 0, answered: 0, correct: 0, quiet: false, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ready: 0, answered: 0, correct: 0, quiet: false };
  }
}

/**
 * The user's own status line command, if they have one. hyperfocus's status line replaces it for
 * the session (settings passed with --settings win), so the script runs it and keeps its output.
 * Ranked the way Claude Code ranks settings files: project local, then project, then user.
 */
export function userStatusLine({ cwd = process.cwd(), home = homedir() } = {}) {
  const files = [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json'), join(home, '.claude', 'settings.json')];
  for (const file of files) {
    try {
      const command = JSON.parse(readFileSync(file, 'utf8'))?.statusLine?.command;
      if (typeof command === 'string' && command.trim()) return command;
    } catch {
      // missing or unreadable: the next file decides
    }
  }
  return null;
}

/** Passed to `claude --settings` beside the hooks. */
export const statusLineSettings = () => ({
  statusLine: { type: 'command', command: `"${process.execPath}" "${statusScript}"`, padding: 0 },
});
