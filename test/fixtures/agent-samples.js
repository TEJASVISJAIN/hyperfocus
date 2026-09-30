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
  // From Codex's hooks docs (learn.chatgpt.com/docs/hooks) and `codex exec --json`; not yet captured from a real run.
  codex: {
    prompt: { hook_event_name: 'UserPromptSubmit', session_id: 's', cwd: '/repo', prompt: 'add retry' },
    edit: {
      hook_event_name: 'PostToolUse', session_id: 's', cwd: '/repo', tool_name: 'apply_patch',
      tool_input: { command: '*** Begin Patch\n*** Update File: src/auth.ts\n@@\n-  return fetchToken();\n+  return withRetry(fetchToken);\n*** End Patch' },
    },
    command: { hook_event_name: 'PostToolUse', session_id: 's', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    stop: { hook_event_name: 'Stop', session_id: 's', cwd: '/repo', stop_hook_active: false },
    needsInput: { hook_event_name: 'PermissionRequest', session_id: 's', cwd: '/repo', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } },
    writerOutput: [
      '{"type":"thread.started","thread_id":"t"}',
      '{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"{\\"summary\\": \\"s\\", \\"questions\\": []}"}}',
      '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
    ].join('\n'),
  },
  // From Gemini CLI's hooks reference (geminicli.com/docs/hooks/reference) and `gemini -o json`.
  gemini: {
    prompt: { hook_event_name: 'BeforeAgent', session_id: 's', cwd: '/repo', prompt: 'add retry' },
    read: { hook_event_name: 'AfterTool', session_id: 's', tool_name: 'read_file', tool_input: { file_path: '/repo/src/auth.ts' } },
    edit: {
      hook_event_name: 'AfterTool', session_id: 's', tool_name: 'replace',
      tool_input: { file_path: '/repo/src/auth.ts', old_string: 'return fetchToken();', new_string: 'return withRetry(fetchToken);' },
    },
    command: { hook_event_name: 'AfterTool', session_id: 's', tool_name: 'run_shell_command', tool_input: { command: 'npm test' } },
    stop: { hook_event_name: 'AfterAgent', session_id: 's', prompt: 'add retry', prompt_response: 'Done.' },
    needsInput: { hook_event_name: 'Notification', session_id: 's', notification_type: 'ToolPermission', message: 'Allow run_shell_command?' },
    writerOutput: JSON.stringify({ response: '{"summary": "s", "questions": []}', stats: {} }),
  },
};
