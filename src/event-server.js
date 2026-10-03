import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { debugLog } from './debug-log.js';
import { toFocusEvent } from './hook-events.js';
import { localEndpoint } from './local-endpoint.js';

let serverCount = 0;

// Listens on a unix socket (a named pipe on Windows) for payloads from bin/hyperfocus-hook.js and
// emits them as FocusEvents.
/** @param {{ platform?: string, toEvent?: (payload: any) => any }} [options] */
export async function startEventServer({ platform = process.platform, toEvent = toFocusEvent } = {}) {
  const { path: socketPath, remove: removeSocket } = localEndpoint(`hyperfocus-${process.pid}-${serverCount++}`, platform);
  removeSocket();

  const events = new EventEmitter();
  const server = createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => (buffered += chunk));
    socket.on('end', () => {
      for (const line of buffered.split('\n')) handleLine(line, events, toEvent);
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(undefined));
  });

  return {
    socketPath,
    events,
    close() {
      server.close();
      removeSocket();
    },
  };
}

function handleLine(line, events, toEvent) {
  if (!line.trim()) return;
  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    debugLog('unparseable hook payload', line.slice(0, 200));
    return;
  }
  try {
    // One payload can be several events: a Codex patch that touches three files is three edits.
    const result = toEvent(payload);
    const found = Array.isArray(result) ? result : result ? [result] : [];
    debugLog('hook', payload?.hook_event_name, payload?.tool_name ?? '', found.map((event) => event.type).join(',') || '(ignored)');
    for (const event of found) events.emit('event', event);
  } catch (error) {
    // A bug handling one event must never take down the user's Claude session.
    debugLog('error handling hook event', error.stack);
  }
}
