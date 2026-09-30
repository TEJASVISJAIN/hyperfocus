import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isStillInCode } from './code-anchors.js';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';
import { readJsonLines } from './jsonl.js';

export const defaultRunsPath = () => join(dataDir(), 'runs.jsonl');

const MAX_HEADING_CHARS = 80;

/** Every finished run, so `hyperfocus --notes` can write up a session afterwards. */
export function createRunLog({ path = defaultRunsPath() } = {}) {
  return {
    append(run, { cwd, sessionId, summary }) {
      const files = new Map();
      for (const edit of run.edits) {
        const anchors = files.get(edit.path) ?? new Set();
        for (const anchor of edit.anchors ?? []) anchors.add(anchor);
        files.set(edit.path, anchors);
      }
      const entry = {
        ts: new Date().toISOString(),
        cwd,
        sessionId,
        prompt: run.prompt,
        summary,
        ...(run.finishedAt ? { durationMs: run.finishedAt - run.startedAt } : {}),
        files: [...files].map(([file, anchors]) => ({ path: file, anchors: [...anchors] })),
      };
      try {
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, JSON.stringify(entry) + '\n');
      } catch (error) {
        debugLog('could not write run log', error.message);
      }
    },
  };
}

/**
 * The latest session's runs in this project, as they stand in the code now. A file whose added
 * lines are gone was reverted or rewritten, so it is left out; a run left with no files is too.
 * Files that can't be checked (only deletions, or secrets hidden) are kept.
 */
export function readNotes({ cwd, path = defaultRunsPath(), readFile = undefined }) {
  const entries = readRuns(path).filter((entry) => entry.cwd === cwd);
  const sessionId = entries.at(-1)?.sessionId;
  const session = entries.filter((entry) => entry.sessionId === sessionId && entry.files.length > 0);
  const stillThere = (file) => file.anchors.length === 0 || isStillInCode({ file: file.path, anchors: file.anchors }, { cwd, readFile });

  const runs = [];
  let leftOut = 0;
  for (const entry of session) {
    const files = entry.files.filter(stillThere).map((file) => file.path);
    if (files.length === 0) leftOut++;
    else runs.push({ prompt: entry.prompt, summary: entry.summary, files, ts: entry.ts });
  }
  return { runs, leftOut };
}

const TYPICAL_RUNS = 20;

/** The median length of this project's latest runs, or null with no history to go on. */
export function medianRunMs({ cwd, path = defaultRunsPath() }) {
  const durations = readRuns(path)
    .filter((entry) => entry.cwd === cwd && Number.isFinite(entry.durationMs))
    .slice(-TYPICAL_RUNS)
    .map((entry) => entry.durationMs)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const middle = Math.floor(durations.length / 2);
  return durations.length % 2 ? durations[middle] : (durations[middle - 1] + durations[middle]) / 2;
}

export function formatNotes({ runs, leftOut }, { project }) {
  if (runs.length === 0 && leftOut === 0) {
    return 'No changes recorded in this project yet. Run `hyperfocus` here and let Claude change something.\n';
  }
  const lines = [`## Session notes · ${project}`, ''];
  for (const run of runs) {
    const heading = (run.prompt.split('\n')[0] || 'Untitled change').trim();
    lines.push(`### ${heading.length > MAX_HEADING_CHARS ? heading.slice(0, MAX_HEADING_CHARS - 1) + '…' : heading}`, '');
    if (run.summary) lines.push(run.summary, '');
    lines.push(...run.files.map((file) => `- \`${file}\``), '');
  }
  if (leftOut) {
    lines.push(`_${leftOut} earlier change${leftOut === 1 ? ' is' : 's are'} left out: ${leftOut === 1 ? 'it is' : 'they are'} no longer in the code._`, '');
  }
  return lines.join('\n');
}

const readRuns = (path) =>
  readJsonLines(path)
    .filter((entry) => entry?.cwd && Array.isArray(entry.files))
    .map((entry) => ({ ...entry, prompt: String(entry.prompt ?? ''), summary: String(entry.summary ?? '') }));
