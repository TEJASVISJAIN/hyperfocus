import { fileURLToPath } from 'node:url';

const hookScript = fileURLToPath(new URL('../bin/hyperfocus-hook.js', import.meta.url));
const HOOK_TIMEOUT_SECONDS = 5;

// Passed to `claude --settings`. Claude Code merges these hooks with the user's own
// settings files, so nothing on disk needs to change for hyperfocus to work.
export function buildHookSettings() {
  const command = `"${process.execPath}" "${hookScript}"`;
  const hook = (matcher) => ({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_SECONDS }],
  });

  return {
    hooks: {
      UserPromptSubmit: [hook()],
      PreToolUse: [hook('Read|Grep|Glob|Agent|Task')],
      PostToolUse: [hook('Edit|MultiEdit|Write|Bash|TaskCreate|TaskUpdate|TodoWrite')],
      SubagentStop: [hook()],
      Stop: [hook()],
      Notification: [hook()],
    },
  };
}
