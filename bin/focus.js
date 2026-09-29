#!/usr/bin/env node
import { runFocus } from '../src/app.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';
import { runPlain } from '../src/passthrough.js';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const claudePath = resolveClaudeBinary();
if (!claudePath) {
  process.stderr.write(
    'focus: could not find `claude` on your PATH.\n' +
      'Install Claude Code (https://claude.com/claude-code) or set FOCUS_CLAUDE_BIN to its path.\n',
  );
  process.exit(127);
}

const args = process.argv.slice(2);

if (process.stdin.isTTY && process.stdout.isTTY) {
  ensureSpawnHelperIsExecutable();
  await runFocus(claudePath, args);
} else {
  runPlain(claudePath, args);
}
