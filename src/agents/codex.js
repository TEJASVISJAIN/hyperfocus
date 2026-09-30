import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { resolveBinary } from '../claude-binary.js';
import { dataDir } from '../data-dir.js';
import { hookCommand } from '../hook-settings.js';

const HOOK_TIMEOUT_SECONDS = 5;
const OWN_HOOKS = 'hooks.json';

/**
 * OpenAI Codex CLI. It reads hooks only from files, so for each launch hyperfocus points
 * CODEX_HOME at a folder that mirrors the user's ~/.codex with symlinks (auth, config, sessions
 * all stay where they are) plus a hooks.json holding the user's hooks and hyperfocus's. The folder
 * never moves, so Codex's hook trust, given once, sticks.
 * @type {import('./claude.js').AgentAdapter}
 */
export const codexAgent = {
  id: 'codex',
  name: 'Codex',
  findBinary: (env = process.env) => resolveBinary('codex', env.HYPERFOCUS_CODEX_BIN, env),
  missingHelp: 'Install Codex CLI (npm install -g @openai/codex) or set HYPERFOCUS_CODEX_BIN to its path.',
  prepareLaunch: ({ socketPath, env = process.env, home = join(dataDir(env), 'codex-home') }) => {
    const realHome = env.CODEX_HOME || join(homedir(), '.codex');
    mirrorHome(realHome, home);
    writeFileSync(join(home, OWN_HOOKS), JSON.stringify(withOwnHooks(readHooks(realHome)), null, 2) + '\n');
    return {
      args: ['--enable', 'hooks'],
      env: { HYPERFOCUS_SOCK: socketPath, CODEX_HOME: home },
      cleanup: () => adoptNewFiles(home, realHome),
    };
  },
  toEvent: codexEvent,
  writer: {
    // A one-shot, read-only, unsaved run; the instructions and the prompt both go in on stdin.
    args: (systemPrompt, model) => [
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--sandbox', 'read-only',
      ...(model ? ['--model', model] : []),
      '-',
    ],
    input: (systemPrompt, prompt) => `${systemPrompt}\n\n${prompt}`,
    env: (env) => env,
    parse: (stdout) => {
      const events = stdout.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const failure = events.find((event) => event?.type === 'error' || event?.type === 'turn.failed');
      if (failure) return { text: String(failure.message ?? failure.error?.message ?? 'Codex failed'), isError: true };
      const message = events.findLast((event) => event?.type === 'item.completed' && event.item?.type === 'agent_message');
      return message ? { text: String(message.item.text ?? ''), isError: false } : null;
    },
    defaultModel: null, // Codex's own default
  },
};

/** The user's hooks, with hyperfocus's added to each event it listens to. */
export function withOwnHooks(userHooks) {
  const command = hookCommand();
  const own = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }] });
  const events = { UserPromptSubmit: own(), PostToolUse: own('.*'), PermissionRequest: own('.*'), Stop: own() };
  const hooks = { ...(userHooks?.hooks ?? {}) };
  for (const [event, entry] of Object.entries(events)) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry];
  return { ...(userHooks ?? {}), hooks };
}

function readHooks(realHome) {
  try {
    return JSON.parse(readFileSync(join(realHome, OWN_HOOKS), 'utf8'));
  } catch {
    return {};
  }
}

// Every entry of the real home, linked into the mirror; hooks.json is the mirror's own.
function mirrorHome(realHome, home) {
  mkdirSync(realHome, { recursive: true });
  mkdirSync(home, { recursive: true });
  for (const name of readdirSync(realHome)) {
    if (name === OWN_HOOKS) continue;
    const link = join(home, name);
    if (isLink(link)) rmSync(link);
    else if (existsSync(link)) continue; // created by Codex in an earlier session; adopted on exit
    symlinkSync(join(realHome, name), link, lstatSync(join(realHome, name)).isDirectory() ? 'junction' : 'file');
  }
}

// Files Codex created in the mirror (a first login's auth.json, say) belong in the real home.
function adoptNewFiles(home, realHome) {
  try {
    for (const name of readdirSync(home)) {
      const path = join(home, name);
      if (name === OWN_HOOKS || isLink(path) || existsSync(join(realHome, name))) continue;
      renameSync(path, join(realHome, name));
    }
  } catch {
    // Left in the mirror, they are still used next time.
  }
}

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const isText = (value) => typeof value === 'string';

/** @returns {import('../hook-events.js').FocusEvent | import('../hook-events.js').FocusEvent[] | null} */
export function codexEvent(payload) {
  const sessionId = isText(payload?.session_id) ? payload.session_id : '';
  const cwd = isText(payload?.cwd) ? payload.cwd : '';
  switch (payload?.hook_event_name) {
    case 'UserPromptSubmit':
      return { type: 'busy', sessionId, prompt: isText(payload.prompt) ? payload.prompt : '' };
    case 'Stop':
      return { type: 'done', sessionId };
    case 'PermissionRequest':
      return { type: 'needs-input', sessionId, message: `Codex wants to use ${isText(payload.tool_name) ? payload.tool_name : 'a tool'}` };
    case 'PostToolUse':
      return toolEvent(sessionId, cwd, payload.tool_name, payload.tool_input ?? {});
    default:
      return null;
  }
}

/** @returns {any} */
function toolEvent(sessionId, cwd, toolName, input) {
  if (toolName === 'apply_patch') {
    const patch = [input.command, input.input, input.patch].find(isText) ?? (isText(input) ? input : null);
    const files = patch ? parsePatch(patch) : [];
    return files.length ? files.map(({ path, changes }) => ({ type: 'edit', sessionId, path: cwd && !isAbsolute(path) ? join(cwd, path) : path, changes })) : null;
  }
  if (toolName === 'update_plan' && Array.isArray(input.plan)) {
    const todos = input.plan.filter((step) => isText(step?.step)).map((step) => ({ subject: step.step, status: isText(step.status) ? step.status : 'pending', activeForm: step.step }));
    return { type: 'todos', sessionId, todos };
  }
  const command = Array.isArray(input.command) ? input.command.filter(isText).join(' ') : input.command;
  if (isText(command) && command) return { type: 'command', sessionId, command };
  return null;
}

/**
 * Codex's patch format: `*** Update File: path` / `*** Add File: path` sections of `-`/`+` lines.
 * @returns {{ path: string, changes: { before: string, after: string }[] }[]}
 */
export function parsePatch(patch) {
  const files = [];
  let current = null;
  let hunk = null;
  const endHunk = () => {
    if (current && hunk && (hunk.before.length || hunk.after.length)) current.changes.push({ before: hunk.before.join('\n'), after: hunk.after.join('\n') });
    hunk = { before: [], after: [] };
  };
  for (const line of patch.split('\n')) {
    const header = line.match(/^\*\*\* (Update|Add|Delete) File: (.+)$/);
    if (header) {
      endHunk();
      current = header[1] === 'Delete' ? null : { path: header[2].trim(), changes: [] };
      if (current) files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@') || line.startsWith('*** ')) endHunk();
    else if (line.startsWith('+')) hunk.after.push(line.slice(1));
    else if (line.startsWith('-')) hunk.before.push(line.slice(1));
  }
  endHunk();
  return files.filter((file) => file.changes.length);
}
