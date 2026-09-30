// Hook payloads as each agent sends them, and its print mode's output, for the adapter contract tests.
export const SAMPLES = {
  claude: {
    prompt: { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'add retry' },
    read: { hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Read', tool_input: { file_path: '/repo/src/auth.ts' } },
    edit: {
      hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit',
      tool_input: { file_path: '/repo/src/auth.ts', old_string: 'return fetchToken();', new_string: 'return withRetry(fetchToken);' },
    },
    command: { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    stop: { hook_event_name: 'Stop', session_id: 's' },
    needsInput: { hook_event_name: 'Notification', session_id: 's', message: 'Claude needs your permission to use Bash' },
    writerOutput: JSON.stringify({ type: 'result', is_error: false, result: '{"summary": "s", "questions": []}' }),
  },
};
