import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';
import { localEndpoint } from './local-endpoint.js';
import { redactSecrets } from './redact.js';

/**
 * Version of the messages below. A client that doesn't know this number must not guess: it tells
 * the user which hyperfocus it needs instead.
 *
 * server → client, one JSON object per line:
 *   { type: 'hello', protocol, pid, cwd, agent }   once, on connect
 *   { type: 'state', ...FocusSession.snapshot(), quiet }   on connect, then whenever it changes
 *   { type: 'stale', id }   the action named a question that is no longer up
 * client → server:
 *   { type: 'answer', id, chosen } | { type: 'skip', id } | { type: 'next', id } | { type: 'save', id }
 *   { type: 'rate', id, rating: 'bad' } | { type: 'followUp', id, ask }
 *   { type: 'keepGoing' } | { type: 'back' } | { type: 'exit' } (Esc: back to the agent) | { type: 'quiet' }
 */
export const BRIDGE_PROTOCOL = 1;

// A line longer than this is not a panel talking: the client is dropped rather than buffered forever.
const MAX_LINE_CHARS = 64 * 1024;

export const defaultSessionsDir = () => join(dataDir(), 'sessions');

let bridgeCount = 0;

/**
 * Lets other local surfaces (the VS Code extension) follow and drive this session. Listens beside
 * the hook socket and writes a session file saying where, so a client can find the session for its
 * folder. Passive until a client connects; nothing a client sends can take the session down.
 * @param {{
 *   meta: { cwd: string, agent: string },
 *   state: () => object,
 *   act: (action: any) => string,
 *   sessionsDir?: string,
 *   platform?: string,
 * }} options
 */
export async function startBridge({ meta, state, act, sessionsDir = defaultSessionsDir(), platform = process.platform }) {
  // On unix the socket goes in a fresh directory only this user can enter, so no one else can connect
  // even in the moment between listening and tightening the socket's own permissions.
  const privateDir = platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'hf-'));
  const endpoint = privateDir
    ? { path: join(privateDir, 'bridge.sock'), isPipe: false, remove: () => rmSync(privateDir, { recursive: true, force: true }) }
    : localEndpoint(`hyperfocus-bridge-${process.pid}-${bridgeCount++}`, platform);
  const clients = new Set();
  let connections = 0;
  let lastSent = '';

  const stateLine = () => JSON.stringify({ type: 'state', ...redactDeep(state()) }) + '\n';
  const send = (socket, line) => {
    if (!socket.destroyed) socket.write(line);
  };

  const server = createServer((socket) => {
    clients.add(socket);
    connections++;
    socket.setEncoding('utf8');
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    send(socket, JSON.stringify({ type: 'hello', protocol: BRIDGE_PROTOCOL, pid: process.pid, cwd: meta.cwd, agent: meta.agent }) + '\n');
    send(socket, safely(stateLine) ?? '');
    let buffered = '';
    socket.on('data', (chunk) => {
      buffered += chunk;
      if (buffered.length > MAX_LINE_CHARS && !buffered.includes('\n')) {
        debugLog('bridge client sent an over-long line; dropping it');
        return socket.destroy();
      }
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        handleLine(line, socket);
      }
    });
  });

  function handleLine(line, socket) {
    if (!line.trim()) return;
    let action;
    try {
      action = JSON.parse(line);
    } catch {
      return debugLog('unparseable bridge message', line.slice(0, 200));
    }
    if (!action || typeof action.type !== 'string') return;
    const outcome = safely(() => act(action));
    if (outcome === 'stale') send(socket, JSON.stringify({ type: 'stale', id: action.id }) + '\n');
    publish();
  }

  // Sends the state to every client when it has changed since the last send.
  function publish() {
    if (!clients.size) return;
    const line = safely(stateLine);
    if (!line || line === lastSent) return;
    lastSent = line;
    for (const socket of clients) send(socket, line);
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint.path, () => resolve(undefined));
  });
  // Only this user may connect: the panel can answer questions and read the code in them.
  if (!endpoint.isPipe) safely(() => chmodSync(endpoint.path, 0o600));

  const sessionFile = join(sessionsDir, `${process.pid}.json`);
  safely(() => {
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      sessionFile,
      JSON.stringify({ protocol: BRIDGE_PROTOCOL, pid: process.pid, cwd: meta.cwd, agent: meta.agent, endpoint: endpoint.path, startedAt: new Date().toISOString() }) + '\n',
    );
  });

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    process.removeListener('exit', close);
    for (const socket of clients) socket.destroy();
    server.close();
    endpoint.remove();
    rmSync(sessionFile, { force: true });
  };
  process.once('exit', close);

  return {
    socketPath: endpoint.path,
    sessionFile,
    publish,
    close,
    /** Clients connected right now. */
    get clientCount() {
      return clients.size;
    },
    /** Clients that have ever connected. */
    get connectionCount() {
      return connections;
    },
  };
}

/**
 * Running sessions, from their files in `sessionsDir`. A file whose process is gone is removed.
 * @returns {{ protocol: number, pid: number, cwd: string, agent: string, endpoint: string, startedAt: string }[]}
 */
export function listSessions(sessionsDir = defaultSessionsDir()) {
  let names;
  try {
    names = readdirSync(sessionsDir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const name of names) {
    const path = join(sessionsDir, name);
    let session;
    try {
      session = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(session?.pid) || typeof session.endpoint !== 'string') continue;
    if (!isAlive(session.pid)) {
      rmSync(path, { force: true });
      continue;
    }
    sessions.push(session);
  }
  return sessions;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, but someone else's
  }
}

// Every string in the state goes through the same redaction as the prompts the quiz writer sees.
function redactDeep(value) {
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, redactDeep(inner)]));
  return value;
}

function safely(fn) {
  try {
    return fn();
  } catch (error) {
    debugLog('bridge error', error.stack);
    return undefined;
  }
}
