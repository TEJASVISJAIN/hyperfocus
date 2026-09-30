import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveBinary } from '../claude-binary.js';
import { dataDir } from '../data-dir.js';
import { hookCommand } from '../hook-settings.js';

const HOOK_TIMEOUT_MS = 5000;
const SYSTEM_SETTINGS = {
  darwin: '/Library/Application Support/GeminiCli/settings.json',
  win32: 'C:\\ProgramData\\gemini-cli\\settings.json',
};

/**
 * Google Gemini CLI. It reads hooks only from settings files; GEMINI_CLI_SYSTEM_SETTINGS_PATH
 * points it at another system settings file for one launch. hyperfocus writes a copy of the real
 * system settings (usually none) with its hooks added, so the user's own files never change.
 * @type {import('./claude.js').AgentAdapter}
 */
export const geminiAgent = {
  id: 'gemini',
  name: 'Gemini',
  findBinary: (env = process.env) => resolveBinary('gemini', env.HYPERFOCUS_GEMINI_BIN, env),
  missingHelp: 'Install Gemini CLI (npm install -g @google/gemini-cli) or set HYPERFOCUS_GEMINI_BIN to its path.',
  prepareLaunch: ({ socketPath, env = process.env, home = dataDir(env) }) => {
    const realPath = env.GEMINI_CLI_SYSTEM_SETTINGS_PATH || SYSTEM_SETTINGS[process.platform] || '/etc/gemini-cli/settings.json';
    let system = {};
    try {
      system = JSON.parse(readFileSync(realPath, 'utf8'));
    } catch (error) {
      // No system settings is the normal case; unreadable ones must not be silently dropped.
      if (error.code !== 'ENOENT') throw new Error(`can't read Gemini's system settings at ${realPath}, so hyperfocus left them alone`);
    }
    mkdirSync(home, { recursive: true });
    const path = join(home, 'gemini-system-settings.json');
    writeFileSync(path, JSON.stringify(withOwnHooks(system), null, 2) + '\n');
    return { args: [], env: { HYPERFOCUS_SOCK: socketPath, GEMINI_CLI_SYSTEM_SETTINGS_PATH: path }, cleanup: () => {} };
  },
  toEvent: geminiEvent,
  writer: {
    // Headless and read-only; -p is appended to stdin, so the instructions go there and the prompt on stdin.
    args: (systemPrompt, model) => ['-p', systemPrompt, '--output-format', 'json', '--approval-mode', 'plan', ...(model ? ['--model', model] : [])],
    env: (env) => env,
    parse: (stdout) => {
      try {
        const reply = JSON.parse(stdout.slice(stdout.indexOf('{')));
        if (reply.error) return { text: String(reply.error.message ?? 'Gemini failed'), isError: true };
        return typeof reply.response === 'string' ? { text: reply.response, isError: false } : null;
      } catch {
        return null;
      }
    },
    defaultModel: null, // Gemini CLI's own default
  },
};

export function withOwnHooks(settings) {
  const own = (matcher) => ({ ...(matcher ? { matcher } : {}), hooks: [{ name: 'hyperfocus', type: 'command', command: hookCommand(), timeout: HOOK_TIMEOUT_MS }] });
  const events = { BeforeAgent: own(), AfterTool: own('.*'), AfterAgent: own(), Notification: own() };
  const hooks = { ...(settings?.hooks ?? {}) };
  for (const [event, entry] of Object.entries(events)) hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] : []), entry];
  return { ...(settings ?? {}), hooks };
}

const isText = (value) => typeof value === 'string';

/** @returns {any} */
export function geminiEvent(payload) {
  const sessionId = isText(payload?.session_id) ? payload.session_id : '';
  switch (payload?.hook_event_name) {
    case 'BeforeAgent':
      return { type: 'busy', sessionId, prompt: isText(payload.prompt) ? payload.prompt : '' };
    case 'AfterAgent':
      return { type: 'done', sessionId };
    case 'Notification':
      return { type: 'needs-input', sessionId, message: isText(payload.message) ? payload.message : 'Gemini needs you' };
    case 'AfterTool':
      return toolEvent(sessionId, payload.tool_name, payload.tool_input ?? {});
    default:
      return null;
  }
}

function toolEvent(sessionId, toolName, input) {
  switch (toolName) {
    case 'read_file':
      return isText(input.file_path) ? { type: 'read', sessionId, target: input.file_path } : null;
    case 'write_file':
      return isText(input.file_path) ? { type: 'edit', sessionId, path: input.file_path, changes: [{ before: '', after: isText(input.content) ? input.content : '' }] } : null;
    case 'replace':
      return isText(input.file_path)
        ? { type: 'edit', sessionId, path: input.file_path, changes: [{ before: isText(input.old_string) ? input.old_string : '', after: isText(input.new_string) ? input.new_string : '' }] }
        : null;
    case 'run_shell_command':
      return isText(input.command) ? { type: 'command', sessionId, command: input.command } : null;
    case 'write_todos':
      return Array.isArray(input.todos)
        ? { type: 'todos', sessionId, todos: input.todos.filter((todo) => isText(todo?.description)).map((todo) => ({ subject: todo.description, status: isText(todo.status) ? todo.status : 'pending', activeForm: todo.description })) }
        : null;
    default:
      return null;
  }
}
