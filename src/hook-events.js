// Translates raw Claude Code hook payloads into the small event vocabulary focus works with.
// Returns null for payloads focus doesn't care about or that are missing what it needs:
// hook payloads come from outside, so nothing here may assume a field is present.

/**
 * @typedef {{ before: string, after: string }} Change
 * @typedef {{ type: 'busy', sessionId: string, prompt: string }
 *   | { type: 'read', sessionId: string, target: string }
 *   | { type: 'edit', sessionId: string, path: string, changes: Change[] }
 *   | { type: 'command', sessionId: string, command: string }
 *   | { type: 'done', sessionId: string }
 *   | { type: 'needs-input', sessionId: string, message: string }} FocusEvent
 */

const isText = (value) => typeof value === 'string';
const textOr = (value, fallback) => (isText(value) ? value : fallback);

/** @returns {FocusEvent | null} */
export function toFocusEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const sessionId = textOr(payload.session_id, '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  switch (payload.hook_event_name) {
    case 'UserPromptSubmit':
      return { type: 'busy', sessionId, prompt: textOr(payload.prompt, '') };
    case 'PreToolUse':
      return readEvent(sessionId, payload.tool_name, input);
    case 'PostToolUse':
      return changeEvent(sessionId, payload.tool_name, input);
    case 'Stop':
      return { type: 'done', sessionId };
    case 'Notification':
      return { type: 'needs-input', sessionId, message: textOr(payload.message, '') };
    default:
      return null;
  }
}

/** @returns {FocusEvent | null} */
function readEvent(sessionId, toolName, input) {
  switch (toolName) {
    case 'Read':
      return isText(input.file_path) ? { type: 'read', sessionId, target: input.file_path } : null;
    case 'Grep':
      return isText(input.pattern)
        ? { type: 'read', sessionId, target: `grep "${input.pattern}"${isText(input.path) ? ` in ${input.path}` : ''}` }
        : null;
    case 'Glob':
      return isText(input.pattern) ? { type: 'read', sessionId, target: `glob ${input.pattern}` } : null;
    default:
      return null;
  }
}

/** @returns {FocusEvent | null} */
function changeEvent(sessionId, toolName, input) {
  if (toolName === 'Bash') return isText(input.command) ? { type: 'command', sessionId, command: input.command } : null;
  if (!isText(input.file_path)) return null;
  const changes = changesOf(toolName, input);
  return changes ? { type: 'edit', sessionId, path: input.file_path, changes } : null;
}

/** @returns {Change[] | null} */
function changesOf(toolName, input) {
  switch (toolName) {
    case 'Edit':
      return [{ before: textOr(input.old_string, ''), after: textOr(input.new_string, '') }];
    case 'MultiEdit':
      return Array.isArray(input.edits)
        ? input.edits.map((edit) => ({ before: textOr(edit?.old_string, ''), after: textOr(edit?.new_string, '') }))
        : null;
    case 'Write':
      return [{ before: '', after: textOr(input.content, '') }];
    default:
      return null;
  }
}
