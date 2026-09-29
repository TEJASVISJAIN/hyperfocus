import { debugLog } from './debug-log.js';
import { startEventServer } from './event-server.js';
import { buildHookSettings } from './hook-settings.js';
import { exitCodeFor, startClaudeInPty, takeOverTerminal } from './passthrough.js';

export async function runFocus(claudePath, args) {
  const eventServer = await startEventServer();
  eventServer.events.on('event', (event) => debugLog('event', JSON.stringify(event).slice(0, 300)));

  const env = { ...process.env, CLAUDE_FOCUS_SOCK: eventServer.socketPath };
  const claudeArgs = ['--settings', JSON.stringify(buildHookSettings()), ...args];

  const child = startClaudeInPty(claudePath, claudeArgs, {
    env,
    onOutput: (data) => process.stdout.write(data),
    onExit: (result) => {
      restoreTerminal();
      eventServer.close();
      process.exit(exitCodeFor(result));
    },
  });
  const restoreTerminal = takeOverTerminal((chunk) => child.write(chunk.toString('utf8')));
  process.stdout.on('resize', () => child.resize(process.stdout.columns, process.stdout.rows));
}
