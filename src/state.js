import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';

// What hyperfocus remembers for itself (unlike config.json, which is the user's to edit).
export const defaultStatePath = () => join(dataDir(), 'state.json');

export function readState({ path = defaultStatePath() } = {}) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    return state && typeof state === 'object' && !Array.isArray(state) ? state : {};
  } catch {
    return {};
  }
}

export function updateState(changes, { path = defaultStatePath() } = {}) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...readState({ path }), ...changes }, null, 2) + '\n');
  } catch (error) {
    debugLog('could not write state', error.message);
  }
}
