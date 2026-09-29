import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// focus owns the whole screen, so console output would corrupt it. FOCUS_DEBUG=1 logs here instead.
const logDirectory = join(homedir(), '.focus');
const logPath = join(logDirectory, 'debug.log');

export function debugLog(...parts) {
  if (process.env.FOCUS_DEBUG !== '1') return;
  try {
    mkdirSync(logDirectory, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {
    // Debug logging must never take focus down.
  }
}
