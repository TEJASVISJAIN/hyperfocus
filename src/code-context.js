import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { anchorsFrom } from './code-anchors.js';
import { isSensitivePath, redactSecrets } from './redact.js';

const RECENT_EDITS = 3;
const LINES_AROUND = 10;
const MAX_LINES_PER_EDIT = 40;
const MAX_LINES = 100;

/**
 * The code around the run's latest edits, as it is on disk now, so questions can be about why a
 * change was made and not only about the lines it touched. Each edit contributes the lines around
 * the ones it added; files that are sensitive, gone, or no longer hold the edit contribute nothing.
 * @param {any} run
 * @param {{ cwd: string, readFile?: (path: string) => string }} where
 * @returns {{ file: string, text: string }[]}
 */
export function surroundingCode(run, where) {
  const { cwd, readFile = (path) => readFileSync(path, 'utf8') } = where;
  const context = [];
  let budget = MAX_LINES;
  for (const edit of [...(run?.edits ?? [])].reverse().slice(0, RECENT_EDITS)) {
    if (budget <= 0) break;
    if (isSensitivePath(edit.path)) continue;
    let text;
    try {
      text = String(readFile(isAbsolute(edit.path) ? edit.path : join(cwd, edit.path)));
    } catch {
      continue;
    }
    const lines = text.split('\n');
    const anchors = new Set(edit.anchors ?? anchorsFrom(edit.diff));
    const wanted = new Set();
    lines.forEach((line, index) => {
      if (!anchors.has(line.trim())) return;
      for (let at = Math.max(0, index - LINES_AROUND); at <= Math.min(lines.length - 1, index + LINES_AROUND); at++) wanted.add(at);
    });
    if (wanted.size === 0) continue;

    const shown = [];
    let previous = -1;
    for (const index of [...wanted].sort((a, b) => a - b)) {
      if (shown.length >= Math.min(MAX_LINES_PER_EDIT, budget)) break;
      if (previous !== -1 && index !== previous + 1) shown.push('…');
      shown.push(lines[index]);
      previous = index;
    }
    const fitted = shown.slice(0, Math.min(MAX_LINES_PER_EDIT, budget));
    budget -= fitted.length;
    context.push({ file: edit.path, text: redactSecrets(fitted.join('\n')) });
  }
  return context;
}
