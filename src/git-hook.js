import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

const START = '# >>> hyperfocus: review missed questions before pushing (hyperfocus --uninstall-hook removes this) >>>';
const END = '# <<< hyperfocus <<<';
// Keeps the status the hook had before this block, so it never changes whether a push goes ahead.
const BLOCK = [
  START,
  'hyperfocus_status=$?',
  'if command -v hyperfocus >/dev/null 2>&1; then hyperfocus --review --brief || true; fi',
  '(exit $hyperfocus_status)',
  END,
].join('\n');
const MAX_BRIEF = 8;

function hookPath(cwd) {
  let hooks;
  try {
    // Honours core.hooksPath and worktrees.
    hooks = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new Error('not a git repository: run this inside the repository you push from');
  }
  return join(isAbsolute(hooks) ? hooks : join(cwd, hooks), 'pre-push');
}

export function installHook({ cwd = process.cwd() } = {}) {
  const path = hookPath(cwd);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (existing?.includes(START)) return { path, alreadyInstalled: true };
  const script = existing === null ? `#!/bin/sh\n${BLOCK}\n` : `${existing}${existing.endsWith('\n') ? '' : '\n'}${BLOCK}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return { path, alreadyInstalled: false };
}

export function uninstallHook({ cwd = process.cwd() } = {}) {
  const path = hookPath(cwd);
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const start = existing.indexOf(START);
  if (start === -1) return { path, removed: false };
  const endAt = existing.indexOf(END, start);
  // The end marker was edited away: removing up to a guess could eat the user's own lines.
  if (endAt === -1) throw new Error(`the hyperfocus block in ${path} has no end marker; remove it by hand`);
  const end = endAt + END.length;
  const rest = existing.slice(0, start) + existing.slice(end).replace(/^\n/, '');
  if (rest.trim() === '#!/bin/sh') rmSync(path);
  else writeFileSync(path, rest);
  return { path, removed: true };
}

/** A few lines for the pre-push hook: missed questions about code that is still here, or nothing. */
export function formatBrief(due) {
  if (due.length === 0) return '';
  const lines = [`hyperfocus: ${due.length} question${due.length === 1 ? '' : 's'} you missed ${due.length === 1 ? 'is' : 'are'} about code that is still here:`];
  for (const question of due.slice(0, MAX_BRIEF)) {
    lines.push(`  - ${question.anchor ? `${question.anchor.file}: ` : ''}${question.q} — ${question.options[question.answer]}`);
  }
  if (due.length > MAX_BRIEF) lines.push(`  … and ${due.length - MAX_BRIEF} more: hyperfocus --review`);
  return lines.join('\n') + '\n';
}
