import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { debugLog } from './debug-log.js';

export const defaultHistoryPath = () => join(homedir(), '.focus', 'history.jsonl');

// Every answered or skipped question, kept so a later version can bring back the ones you missed.
export function createHistory({ path = defaultHistoryPath() } = {}) {
  return {
    append({ question, chosen, correct, skipped }, { cwd, sessionId, files }) {
      const entry = {
        ts: new Date().toISOString(),
        cwd,
        sessionId,
        question: question.q,
        options: question.options,
        answer: question.answer,
        chosen,
        correct,
        skipped,
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

/** @returns {{ cwd: string, answered: number, correct: number, skipped: number }[]} */
export function readStats(path = defaultHistoryPath()) {
  if (!existsSync(path)) return [];
  const byProject = new Map();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry?.cwd) continue;
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

export function formatStats(stats) {
  if (!stats.length) return 'No quiz answers recorded yet. Run `focus` and answer a few questions while Claude works.\n';

  const home = homedir();
  const rows = stats.map((project) => ({ ...project, label: project.cwd.startsWith(home) ? '~' + project.cwd.slice(home.length) : project.cwd }));
  const total = rows.reduce(
    (sum, project) => ({ ...sum, answered: sum.answered + project.answered, correct: sum.correct + project.correct, skipped: sum.skipped + project.skipped }),
    { label: 'total', answered: 0, correct: 0, skipped: 0 },
  );
  const labelWidth = Math.max(7, ...rows.map((project) => project.label.length));
  const accuracy = ({ correct, answered }) => `${correct} (${answered ? Math.round((correct / answered) * 100) : 0}%)`;
  const format = (project) =>
    `  ${project.label.padEnd(labelWidth)}  ${String(project.answered).padStart(8)}  ${accuracy(project).padStart(9)}  ${String(project.skipped).padStart(7)}`;

  return [
    'focus quiz history',
    '',
    `  ${'project'.padEnd(labelWidth)}  ${'answered'.padStart(8)}  ${'correct'.padStart(9)}  ${'skipped'.padStart(7)}`,
    ...rows.map(format),
    format(total),
    '',
  ].join('\n');
}
