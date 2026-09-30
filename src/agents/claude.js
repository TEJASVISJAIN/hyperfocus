import { resolveClaudeBinary } from '../claude-binary.js';
import { toFocusEvent } from '../hook-events.js';
import { buildHookSettings } from '../hook-settings.js';

/**
 * Everything hyperfocus knows about one coding agent, so the rest of it can wrap any of them:
 * finding it, attaching hyperfocus's hooks to one launch, reading its hook payloads, and writing
 * questions with its print mode.
 *
 * @typedef {{
 *   args: (systemPrompt: string, model: string | null) => string[],
 *   env: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv,
 *   parse: (stdout: string) => { text: string, isError: boolean } | null,
 *   input?: (systemPrompt: string, prompt: string) => string,
 *   defaultModel: string | null,
 * }} QuestionWriter
 * @typedef {{
 *   id: string,
 *   name: string,
 *   findBinary: (env?: NodeJS.ProcessEnv) => string | null,
 *   missingHelp: string,
 *   prepareLaunch: (options: { socketPath: string, env?: NodeJS.ProcessEnv, home?: string }) => { args: string[], env: NodeJS.ProcessEnv, cleanup: () => void },
 *   toEvent: (payload: any) => import('../hook-events.js').FocusEvent | import('../hook-events.js').FocusEvent[] | null,
 *   writer: QuestionWriter,
 * }} AgentAdapter
 */

/** @type {AgentAdapter} */
export const claudeAgent = {
  id: 'claude',
  name: 'Claude',
  findBinary: (env = process.env) => resolveClaudeBinary(env),
  missingHelp: 'Install Claude Code (https://claude.com/claude-code) or set HYPERFOCUS_CLAUDE_BIN to its path.',
  // Claude Code merges hooks passed with --settings into the user's own: nothing on disk changes.
  prepareLaunch: ({ socketPath }) => ({
    args: ['--settings', JSON.stringify(buildHookSettings())],
    env: { HYPERFOCUS_SOCK: socketPath },
    cleanup: () => {},
  }),
  toEvent: toFocusEvent,
  writer: {
    // A lean one-shot Claude: no tools, no MCP, no hooks, no saved session, and our own system prompt.
    // Cutting the default context this way makes each call roughly 70x cheaper. The user's settings
    // files still load, because that is where auth such as apiKeyHelper lives.
    args: (systemPrompt, model) => [
      '-p',
      ...(model ? ['--model', model] : []),
      '--output-format', 'json',
      '--tools', '',
      '--no-session-persistence',
      '--setting-sources', 'user,project,local',
      '--settings', JSON.stringify({ disableAllHooks: true }),
      '--strict-mcp-config',
      '--system-prompt', systemPrompt,
    ],
    // Haiku thinks for ~3k tokens by default here, which turned a 6s batch into 30s.
    env: (env) => ({ ...env, MAX_THINKING_TOKENS: '0' }),
    parse: (stdout) => {
      try {
        const { result, is_error: isError } = JSON.parse(stdout);
        return { text: String(result ?? ''), isError: Boolean(isError) };
      } catch {
        return null;
      }
    },
    defaultModel: 'haiku',
  },
};
