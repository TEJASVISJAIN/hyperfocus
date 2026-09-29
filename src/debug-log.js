import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './data-dir.js';

// hyperfocus owns the whole screen, so console output would corrupt it. HYPERFOCUS_DEBUG=1 logs here instead.
export function debugLog(...parts) {
  if (process.env.HYPERFOCUS_DEBUG !== '1') return;
  const logDirectory = dataDir();
  const logPath = join(logDirectory, 'debug.log');
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {
    // Debug logging must never take hyperfocus down.
  }
}
