// Translates raw Claude Code hook payloads into the small event vocabulary hyperfocus works with.
// Returns null for payloads hyperfocus doesn't care about or that are missing what it needs:
// hook payloads come from outside, so nothing here may assume a field is present.

/**
 * @typedef {{ before: string, after: string }} Change
 * @typedef {{ type: 'busy', sessionId: string, prompt: string }
 *   | { type: 'read', sessionId: string, target: string }
 *   | { type: 'edit', sessionId: string, path: string, changes: Change[] }
 *   | { type: 'command', sessionId: string, command: string }
 *   | { type: 'task-create', sessionId: string, id: string, subject: string, activeForm: string }
 *   | { type: 'task-update', sessionId: string, id: string, status: string | null, subject: string | null, activeForm: string | null }
 *   | { type: 'todos', sessionId: string, todos: { subject: string, status: string, activeForm: string }[] }
 *   | { type: 'subagent', sessionId: string, description: string }
 *   | { type: 'subagent-done', sessionId: string }
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
      return taskEvent(sessionId, payload.tool_name, input, payload.tool_response) ?? changeEvent(sessionId, payload.tool_name, input);
    case 'SubagentStop':
      return { type: 'subagent-done', sessionId };
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
    case 'Agent':
    case 'Task': // the subagent tool's older name
      return { type: 'subagent', sessionId, description: textOr(input.description, 'working') };
    default:
      return null;
  }
}

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const statusOr = (value, fallback) => (TASK_STATUSES.has(value) ? value : fallback);

// Claude's own plan for the run: TaskCreate/TaskUpdate in current Claude Code, TodoWrite before that.
/** @returns {FocusEvent | null} */
function taskEvent(sessionId, toolName, input, response) {
  switch (toolName) {
    case 'TaskCreate': {
      const id = response?.task?.id;
      if (!isText(id) || !isText(input.subject)) return null;
      return { type: 'task-create', sessionId, id, subject: input.subject, activeForm: textOr(input.activeForm, input.subject) };
    }
    case 'TaskUpdate':
      if (!isText(input.taskId)) return null;
      return {
        type: 'task-update',
        sessionId,
        id: input.taskId,
        status: statusOr(input.status, null),
        subject: textOr(input.subject, null),
        activeForm: textOr(input.activeForm, null),
      };
    case 'TodoWrite':
      if (!Array.isArray(input.todos)) return null;
      return {
        type: 'todos',
        sessionId,
        todos: input.todos
          .filter((todo) => isText(todo?.content))
          .map((todo) => ({ subject: todo.content, status: statusOr(todo.status, 'pending'), activeForm: textOr(todo.activeForm, todo.content) })),
      };
    default:
      return undefined;
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
