#!/usr/bin/env node
import { runFocus } from '../src/app.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';
import { parseFocusArgs } from '../src/cli-args.js';
import { loadConfig, setProjectSetting } from '../src/config.js';
import { dataDir } from '../src/data-dir.js';
import { defaultChecks, formatDoctor, runDoctor } from '../src/doctor.js';
import { INTRO_LINES, INTRO_TITLE } from '../src/focus-view.js';
import { formatStats, missedStillInCode, projectLabel, readInsights, readStats } from '../src/history.js';
import { formatBrief, installHook, uninstallHook } from '../src/git-hook.js';
import { formatChecklist, formatNotes, readNotes } from '../src/notes.js';
import { runPlain } from '../src/passthrough.js';
import { runReview } from '../src/review.js';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const { claudeArgs, auto, stats, notes, review, intro, quiet, here, md, brief, installHook: wantsHook, uninstallHook: wantsNoHook, doctor } = parseFocusArgs(process.argv.slice(2));
const { config, problems } = loadConfig();
for (const problem of problems) process.stderr.write(`hyperfocus: config: ${problem}\n`);

if (quiet && here) {
  try {
    setProjectSetting(process.cwd(), 'quiet', true);
  } catch (error) {
    process.stderr.write(`hyperfocus: ${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`hyperfocus will stay quiet in ${projectLabel(process.cwd())}: no automatic quizzes (Ctrl-] still opens one).\n`);
  process.exit(0);
}
if (quiet) config.quiet = true;
if (intro) {
  process.stdout.write([INTRO_TITLE, '', ...INTRO_LINES, ''].join('\n'));
  process.exit(0);
}
if (stats) {
  process.stdout.write(formatStats(readStats(), readInsights()));
  process.exit(0);
}
if (notes) {
  const cwd = process.cwd();
  process.stdout.write(formatNotes(readNotes({ cwd }), { project: projectLabel(cwd), checklist: missedStillInCode({ cwd }) }));
  process.exit(0);
}
if (wantsHook || wantsNoHook) {
  try {
    if (wantsHook) {
      const { path, alreadyInstalled } = installHook();
      process.stdout.write(alreadyInstalled ? `Already installed in ${path}\n` : `Installed in ${path}: before each push, missed questions still in the code are listed. It never blocks a push.\n`);
    } else {
      const { path, removed } = uninstallHook();
      process.stdout.write(removed ? `Removed from ${path}\n` : 'No hyperfocus hook to remove here.\n');
    }
  } catch (error) {
    process.stderr.write(`hyperfocus: ${error.message}\n`);
    process.exit(1);
  }
  process.exit(0);
}
if (review && brief) {
  // For the pre-push hook: never fail, never wait for input.
  try {
    process.stdout.write(formatBrief(missedStillInCode({ cwd: process.cwd() })));
  } catch {}
  process.exit(0);
}
if (review && md) {
  const due = missedStillInCode({ cwd: process.cwd() });
  process.stdout.write(due.length ? formatChecklist(due) : 'Nothing to review: no missed questions about code that is still here.\n');
  process.exit(0);
}

const claudePath = resolveClaudeBinary();
if (doctor) {
  ensureSpawnHelperIsExecutable();
  const results = await runDoctor(defaultChecks({ claudePath, config, problems, dataDir: dataDir() }));
  process.stdout.write(formatDoctor(results));
  process.exit(results.some((result) => result.status === 'fail') ? 1 : 0);
}
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
