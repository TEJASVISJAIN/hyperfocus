#!/usr/bin/env node
import { runFocus } from '../src/app.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';
import { parseFocusArgs } from '../src/cli-args.js';
import { formatStats, readStats } from '../src/history.js';
import { runPlain } from '../src/passthrough.js';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const { claudeArgs, auto, stats } = parseFocusArgs(process.argv.slice(2));

if (stats) {
  process.stdout.write(formatStats(readStats()));
  process.exit(0);
}

const claudePath = resolveClaudeBinary();
if (!claudePath) {
  process.stderr.write(
    'hyperfocus: could not find `claude` on your PATH.\n' +
      'Install Claude Code (https://claude.com/claude-code) or set HYPERFOCUS_CLAUDE_BIN to its path.\n',
  );
  process.exit(127);
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  ensureSpawnHelperIsExecutable();
  await runFocus(claudePath, claudeArgs, { auto });
} else {
  runPlain(claudePath, claudeArgs);
}
