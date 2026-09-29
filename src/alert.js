import { spawn } from 'node:child_process';

const BELL = '\x07';

// Pulls the user back: a terminal bell always, plus a macOS notification in case they
// looked away from the terminal after all.
export function alertUser(message, write) {
  write(BELL);
  if (process.platform !== 'darwin') return;
  try {
    const child = spawn(
      'osascript',
      ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title "hyperfocus"', '-e', 'end run', message],
      { stdio: 'ignore', detached: true },
    );
    child.on('error', () => {});
    child.unref();
  } catch {
    // The bell already went out; a missing notification is not worth failing over.
  }
}
