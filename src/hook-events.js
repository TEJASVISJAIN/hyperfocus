// Translates raw Claude Code hook payloads into the small event vocabulary focus works with.
// Returns null for payloads focus doesn't care about.

/**
 * @typedef {{ before: string, after: string }} Change
 * @typedef {{ type: 'busy', sessionId: string, prompt: string }
 *   | { type: 'read', sessionId: string, target: string }
 *   | { type: 'edit', sessionId: string, path: string, changes: Change[] }
 *   | { type: 'command', sessionId: string, command: string }
 *   | { type: 'done', sessionId: string }
 *   | { type: 'needs-input', sessionId: string, message: string }} FocusEvent
 */

/** @returns {FocusEvent | null} */
export function toFocusEvent(payload) {
  const sessionId = payload.session_id;
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return { type: 'busy', sessionId, prompt: payload.prompt ?? '' };
    case 'PreToolUse':
      return readEvent(sessionId, payload.tool_name, payload.tool_input ?? {});
    case 'PostToolUse':
      return changeEvent(sessionId, payload.tool_name, payload.tool_input ?? {});
    case 'Stop':
      return { type: 'done', sessionId };
    case 'Notification':
      return { type: 'needs-input', sessionId, message: payload.message ?? '' };
    default:
      return null;
  }
}

/** @returns {FocusEvent | null} */
function readEvent(sessionId, toolName, input) {
  switch (toolName) {
    case 'Read':
      return { type: 'read', sessionId, target: input.file_path };
    case 'Grep':
      return { type: 'read', sessionId, target: `grep "${input.pattern}"${input.path ? ` in ${input.path}` : ''}` };
    case 'Glob':
      return { type: 'read', sessionId, target: `glob ${input.pattern}` };
    default:
      return null;
  }
}

/** @returns {FocusEvent | null} */
function changeEvent(sessionId, toolName, input) {
  switch (toolName) {
    case 'Edit':
      return { type: 'edit', sessionId, path: input.file_path, changes: [{ before: input.old_string, after: input.new_string }] };
    case 'MultiEdit':
      return {
        type: 'edit',
        sessionId,
        path: input.file_path,
        changes: input.edits.map((edit) => ({ before: edit.old_string, after: edit.new_string })),
      };
    case 'Write':
      return { type: 'edit', sessionId, path: input.file_path, changes: [{ before: '', after: input.content }] };
    case 'Bash':
      return { type: 'command', sessionId, command: input.command };
    default:
      return null;
  }
}
