#!/usr/bin/env node
import { runFocus } from '../src/app.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';
import { parseFocusArgs } from '../src/cli-args.js';
import { loadConfig } from '../src/config.js';
import { formatStats, projectLabel, readStats } from '../src/history.js';
import { formatNotes, readNotes } from '../src/notes.js';
import { runPlain } from '../src/passthrough.js';
import { runReview } from '../src/review.js';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const { claudeArgs, auto, stats, notes, review } = parseFocusArgs(process.argv.slice(2));
const { config, problems } = loadConfig();
for (const problem of problems) process.stderr.write(`hyperfocus: config: ${problem}\n`);

if (stats) {
  process.stdout.write(formatStats(readStats()));
  process.exit(0);
}
if (notes) {
  const cwd = process.cwd();
  process.stdout.write(formatNotes(readNotes({ cwd }), { project: projectLabel(cwd) }));
  process.exit(0);
}

const claudePath = resolveClaudeBinary();
if (review) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('hyperfocus: --review needs a terminal.\n');
    process.exit(1);
  }
  process.exit(await runReview({ claudePath, config }));
}

if (!claudePath) {
  process.stderr.write(
    'hyperfocus: could not find `claude` on your PATH.\n' +
      'Install Claude Code (https://claude.com/claude-code) or set HYPERFOCUS_CLAUDE_BIN to its path.\n',
  );
  process.exit(127);
}

if (process.stdin.isTTY && process.stdout.isTTY) {
  ensureSpawnHelperIsExecutable();
  await runFocus(claudePath, claudeArgs, { auto, config });
} else {
  runPlain(claudePath, claudeArgs);
}
