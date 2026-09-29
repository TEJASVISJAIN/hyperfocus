import { isAbsolute, relative } from 'node:path';

const MAX_DIFF_CHARS_PER_EDIT = 4000;
const MAX_DIFF_CHARS_PER_RUN = 20_000;
const OMITTED_DIFF = '(older change omitted)';

/**
 * @typedef {{ path: string, diff: string }} Edit
 * @typedef {{
 *   prompt: string, startedAt: number, finished: boolean,
 *   reads: string[], edits: Edit[], commands: string[]
 * }} Run
 */

// Paths inside the project read better relative to it; anything else stays absolute.
export function relativeToProject(path, cwd = process.cwd()) {
  if (!isAbsolute(path)) return path;
  const fromCwd = relative(cwd, path);
  return fromCwd.startsWith('..') ? path : fromCwd;
}

// What the agent has done since the user's last prompt — the raw material for questions and recaps.
export function createActivityLog({ cwd = process.cwd() } = {}) {
  /** @type {Run | null} */
  let run = null;
  /** @type {Run | null} */
  let previousRun = null;

  const displayPath = (path) => relativeToProject(path, cwd);

  function startRun(prompt) {
    if (run) previousRun = run;
    run = { prompt, startedAt: Date.now(), finished: false, reads: [], edits: [], commands: [] };
    return run;
  }

  return {
    get run() {
      return run;
    },
    get previousRun() {
      return previousRun;
    },

    record(event) {
      if (event.type === 'busy') return void startRun(event.prompt);
      const current = run && !run.finished ? run : startRun('');
      switch (event.type) {
        case 'read': {
          const target = displayPath(event.target);
          if (!current.reads.includes(target)) current.reads.push(target);
          break;
        }
        case 'edit':
          current.edits.push({ path: displayPath(event.path), diff: toDiff(event.changes) });
          keepWithinBudget(current.edits);
          break;
        case 'command':
          current.commands.push(event.command);
          break;
        case 'done':
          current.finished = true;
          break;
      }
    },
  };
}

function toDiff(changes) {
  const lines = [];
  for (const { before, after } of changes) {
    if (before) lines.push(...before.split('\n').map((line) => `- ${line}`));
    if (after) lines.push(...after.split('\n').map((line) => `+ ${line}`));
  }
  const diff = lines.join('\n');
  if (diff.length <= MAX_DIFF_CHARS_PER_EDIT) return diff;
  return `${diff.slice(0, MAX_DIFF_CHARS_PER_EDIT)}\n… (truncated)`;
}

// The latest changes matter most for questions about "what just happened", so the oldest go first.
function keepWithinBudget(edits) {
  let total = edits.reduce((sum, edit) => sum + edit.diff.length, 0);
  for (const edit of edits) {
    if (total <= MAX_DIFF_CHARS_PER_RUN) return;
    if (edit.diff === OMITTED_DIFF) continue;
    total -= edit.diff.length - OMITTED_DIFF.length;
    edit.diff = OMITTED_DIFF;
  }
}
