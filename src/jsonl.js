import { existsSync, readFileSync } from 'node:fs';

/** Every parseable JSON line of a file; a half-written or hand-edited line is skipped, never fatal. */
export function readJsonLines(path) {
  if (!existsSync(path)) return [];
  const entries = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  return entries;
}
