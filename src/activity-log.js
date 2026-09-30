import { isAbsolute, relative } from 'node:path';
import { anchorsFrom } from './code-anchors.js';
import { isSensitivePath, redactSecrets } from './redact.js';

const MAX_DIFF_CHARS_PER_EDIT = 4000;
const MAX_DIFF_CHARS_PER_RUN = 20_000;
const OMITTED_DIFF = '(older change omitted)';
const HIDDEN_DIFF = '(contents hidden: this file usually holds secrets)';
const MAX_TIMELINE_STEPS = 30;

/**
 * @typedef {{ path: string, diff: string, anchors: string[] }} Edit
 * @typedef {{ kind: 'read' | 'edit' | 'command' | 'subagent', text: string, added?: number, removed?: number }} Step
 * @typedef {{
 *   prompt: string, startedAt: number, finished: boolean, finishedAt?: number,
 *   reads: string[], edits: Edit[], commands: string[], timeline: Step[]
 * }} Run
 * @typedef {{ id: string, subject: string, activeForm: string, status: string }} Task
 */

// Paths inside the project read better relative to it; anything else stays absolute.
export function relativeToProject(path, cwd = process.cwd()) {
  if (!isAbsolute(path)) return path;
  const fromCwd = relative(cwd, path);
  return fromCwd.startsWith('..') ? path : fromCwd;
}

// Each file the run edited, once, in the order first edited.
export const changedFiles = (run) => [...new Set((run?.edits ?? []).map((edit) => edit.path))];

// What the agent has done since the user's last prompt — the raw material for questions and recaps.
export function createActivityLog({ cwd = process.cwd() } = {}) {
  /** @type {Run | null} */
  let run = null;
  /** @type {Run | null} */
  let previousRun = null;
  // Claude's own plan. It belongs to the Claude session, not one prompt, so it outlives runs.
  /** @type {Map<string, Task>} */
  let tasks = new Map();

  const displayPath = (path) => relativeToProject(path, cwd);

  let sessionId = null;

  function startRun(prompt) {
    if (run) previousRun = run;
    run = { prompt: redactSecrets(prompt), startedAt: Date.now(), finished: false, reads: [], edits: [], commands: [], timeline: [] };
    return run;
  }

  return {
    get run() {
      return run;
    },
    get previousRun() {
      return previousRun;
    },
    /** How far through its plan Claude is, or null when it has no unfinished plan. */
    get progress() {
      const live = [...tasks.values()].filter((task) => task.status !== 'deleted');
      const done = live.filter((task) => task.status === 'completed').length;
      if (live.length === 0 || done === live.length) return null;
      return { done, total: live.length, current: live.find((task) => task.status === 'in_progress')?.activeForm ?? null };
    },

    record(event) {
      // A new Claude session (e.g. after /clear) has none of the old session's plan.
      if (event.sessionId && event.sessionId !== sessionId) {
        if (sessionId !== null) tasks = new Map();
        sessionId = event.sessionId;
      }
      if (event.type === 'busy') return void startRun(event.prompt);
      if (recordTask(event)) return;
      // Claude Code's own background agents (prompt suggestions) stop after the run is over: not work.
      if (event.type === 'subagent-done') return;
      const runIsOpen = run && !run.finished;
      // Stop or the idle reminder with no open run carry no new work; starting a run for them
      // would push the run the user just watched out of reach of the recap and history.
      if (!runIsOpen && (event.type === 'done' || event.type === 'needs-input')) return;
      const current = runIsOpen ? run : startRun('');
      switch (event.type) {
        case 'read': {
          const target = displayPath(event.target);
          if (!current.reads.includes(target)) current.reads.push(target);
          addStep(current, { kind: 'read', text: target });
          break;
        }
        case 'edit': {
          const path = displayPath(event.path);
          const diff = isSensitivePath(event.path) ? HIDDEN_DIFF : toDiff(event.changes);
          current.edits.push({ path, diff, anchors: anchorsFrom(diff) });
          keepWithinBudget(current.edits);
          addStep(current, { kind: 'edit', text: path, ...lineCounts(event.changes) });
          break;
        }
        case 'command': {
          const command = redactSecrets(event.command);
          current.commands.push(command);
          addStep(current, { kind: 'command', text: command.split('\n')[0] });
          break;
        }
        case 'subagent':
          addStep(current, { kind: 'subagent', text: event.description });
          break;
        case 'done':
          current.finished = true;
          current.finishedAt = Date.now();
          break;
      }
    },
  };

  function recordTask(event) {
    switch (event.type) {
      case 'task-create':
        tasks.set(event.id, { id: event.id, subject: event.subject, activeForm: event.activeForm, status: 'pending' });
        return true;
      case 'task-update': {
        const task = tasks.get(event.id);
        if (task) {
          if (event.status) task.status = event.status;
          if (event.subject) task.subject = event.subject;
          if (event.activeForm) task.activeForm = event.activeForm;
        }
        return true;
      }
      case 'todos':
        tasks = new Map(event.todos.map((todo, index) => [String(index), { id: String(index), ...todo }]));
        return true;
      default:
        return false;
    }
  }
}

function addStep(run, step) {
  run.timeline.push(step);
  if (run.timeline.length > MAX_TIMELINE_STEPS) run.timeline.shift();
}

const countLines = (text) => (text ? text.split('\n').length : 0);
const lineCounts = (changes) => ({
  added: changes.reduce((sum, change) => sum + countLines(change.after), 0),
  removed: changes.reduce((sum, change) => sum + countLines(change.before), 0),
});

function toDiff(changes) {
  const lines = [];
  for (const { before, after } of changes) {
    if (before) lines.push(...before.split('\n').map((line) => `- ${line}`));
    if (after) lines.push(...after.split('\n').map((line) => `+ ${line}`));
  }
  const diff = redactSecrets(lines.join('\n'));
  if (diff.length <= MAX_DIFF_CHARS_PER_EDIT) return diff;
  // Cut at a line boundary: a half line would read as code Claude never wrote.
  const lastWholeLine = diff.lastIndexOf('\n', MAX_DIFF_CHARS_PER_EDIT);
  return `${diff.slice(0, lastWholeLine > 0 ? lastWholeLine : MAX_DIFF_CHARS_PER_EDIT)}\n… (truncated)`;
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
