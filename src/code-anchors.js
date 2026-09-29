import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// Short lines ("}", "return;") appear everywhere, so they say nothing about whether a change survived.
const MIN_ANCHOR_CHARS = 12;
const MAX_ANCHORS = 8;
const UNRELIABLE = /\[redacted\]|\(older change omitted\)|… \(truncated\)/;

/**
 * The lines a diff added that identify it: if they are no longer in the file, the change was
 * reverted or rewritten. This is how hyperfocus tells a discarded change from one that stuck,
 * without depending on git or on what the user meant to do.
 */
export function anchorsFrom(diff) {
  const lines = new Set();
  for (const line of String(diff ?? '').split('\n')) {
    if (!line.startsWith('+ ')) continue;
    const text = line.slice(2).trim();
    if (text.length >= MIN_ANCHOR_CHARS && !UNRELIABLE.test(text)) lines.add(text);
  }
  return [...lines].sort((a, b) => b.length - a.length).slice(0, MAX_ANCHORS);
}

/**
 * True while at least half of a change's anchor lines are still lines of its file.
 * Anything that can't be checked (no anchors, unreadable file) counts as gone.
 * @param {{ file?: string, anchors?: string[] }} anchor
 * @param {{ cwd: string, readFile?: (path: string) => string }} where
 */
export function isStillInCode({ file, anchors } = {}, { cwd, readFile = (path) => readFileSync(path, 'utf8') }) {
  if (typeof file !== 'string' || !Array.isArray(anchors) || anchors.length === 0) return false;
  let text;
  try {
    text = readFile(isAbsolute(file) ? file : join(cwd, file));
  } catch {
    return false;
  }
  const present = new Set(String(text).split('\n').map((line) => line.trim()));
  const surviving = anchors.filter((anchor) => present.has(anchor)).length;
  return surviving * 2 >= anchors.length;
}

/**
 * What to check later to know whether a question is still about real code: the lines it quotes,
 * else what the run added to the file it names, else the run's latest edit. Questions asked before
 * any edit are about the plan and get no anchor.
 * @returns {{ file: string, anchors: string[] } | null}
 */
export function anchorFor(question, run) {
  const edits = (run?.edits ?? []).map((edit) => ({ ...edit, anchors: edit.anchors ?? anchorsFrom(edit.diff) }));
  if (edits.length === 0) return null;

  if (question.code) {
    const added = question.code.split('\n').filter((line, index) => question.codeMarks?.[index] === '+').map((line) => line.trim());
    const quoted = added.filter((line) => line.length >= MIN_ANCHOR_CHARS && !UNRELIABLE.test(line));
    const adds = (edit) => edit.diff.split('\n').some((line) => line.startsWith('+ ') && quoted.includes(line.slice(2).trim()));
    const homes = edits.filter(adds).map((edit) => edit.path);
    const home = homes.includes(question.file) ? question.file : homes.at(-1);
    if (home && quoted.length) return { file: home, anchors: quoted.slice(0, MAX_ANCHORS) };
  }
  if (question.file) {
    const anchors = [...new Set(edits.filter((edit) => edit.path === question.file).flatMap((edit) => edit.anchors))];
    if (anchors.length) return { file: question.file, anchors: anchors.slice(0, MAX_ANCHORS) };
  }
  const latest = edits.findLast((edit) => edit.anchors.length > 0);
  return latest ? { file: latest.path, anchors: latest.anchors } : null;
}
