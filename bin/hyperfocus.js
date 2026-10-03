#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { claudeAgent } from '../src/agents/claude.js';
import { agentNamed } from '../src/agents/index.js';
import { ollamaWriter } from '../src/agents/ollama.js';
import { runFocus } from '../src/app.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';
import { parseFocusArgs } from '../src/cli-args.js';
import { DEFAULT_CONFIG, loadConfig, setProjectSetting } from '../src/config.js';
import { dataDir } from '../src/data-dir.js';
import { defaultChecks, formatDoctor, runDoctor } from '../src/doctor.js';
import { INTRO_TITLE, introLines } from '../src/focus-view.js';
import { formatStats, missedStillInCode, projectLabel, readInsights, readStats } from '../src/history.js';
import { formatBrief, installHook, uninstallHook } from '../src/git-hook.js';
import { defaultSavedPath, formatSaved, notebookPath, readSaved } from '../src/saved.js';
import { formatChecklist, formatNotes, formatTiming, readNotes, readTiming } from '../src/notes.js';
import { prepareDemo } from '../src/demo/prepare-demo.js';
import { runPlain } from '../src/passthrough.js';
import { runReview } from '../src/review.js';
import { runStaged } from '../src/staged.js';
import { ensureSpawnHelperIsExecutable } from '../src/spawn-helper-permissions.js';

const { agent: agentCommand, writer: writerFlag, claudeArgs, auto, stats, notes, review, intro, quiet, here, md, brief, installHook: wantsHook, uninstallHook: wantsNoHook, doctor, demo, saved, staged } = parseFocusArgs(process.argv.slice(2));
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
if (writerFlag !== null) {
  if (writerFlag !== 'auto' && writerFlag !== 'ollama') {
    process.stderr.write(`hyperfocus: --writer must be "auto" or "ollama", not "${writerFlag}".\n`);
    process.exit(1);
  }
  config.writer = writerFlag;
}
if (intro) {
  process.stdout.write([INTRO_TITLE, '', ...introLines(), ''].join('\n'));
  process.exit(0);
}
if (stats) {
  process.stdout.write(formatStats(readStats(), readInsights()) + formatTiming(readTiming()));
  process.exit(0);
}
if (saved) {
  const all = process.argv.includes('--all');
  const path = defaultSavedPath();
  process.stdout.write(formatSaved(readSaved({ path, cwd: all ? undefined : process.cwd() })) + `\nNotebook: ${notebookPath(path)}\n`);
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

if (demo) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write('hyperfocus: --demo needs a terminal.\n');
    process.exit(1);
  }
  ensureSpawnHelperIsExecutable();
  const { agentPath, delayMs } = prepareDemo();
  await runFocus(agentPath, [], { auto: true, config: { ...DEFAULT_CONFIG, delayMs } });
} else {
  await main();
}

// Everything except the demo: hyperfocus around the real agent.
async function main() {
  const claudePath = resolveClaudeBinary();
  if (doctor) {
    ensureSpawnHelperIsExecutable();
    const results = await runDoctor(defaultChecks({ claudePath, config, problems, dataDir: dataDir(), ollama: config.writer === 'ollama' ? { adapter: ollamaWriter, model: config.ollamaModel } : null }));
    process.stdout.write(formatDoctor(results));
    process.exit(results.some((result) => result.status === 'fail') ? 1 : 0);
  }
  if (review) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write('hyperfocus: --review needs a terminal.\n');
      process.exit(1);
    }
    const writer = config.writer === 'ollama' ? { path: '', adapter: ollamaWriter, model: config.ollamaModel } : undefined;
    process.exit(await runReview({ claudePath, config, writer }));
  }

  const agent = agentNamed(agentCommand ?? config.agent) ?? claudeAgent;
  const agentPath = agent === claudeAgent ? claudePath : agent.findBinary();
  if (!agentPath) {
    process.stderr.write(`hyperfocus: could not find \`${agent.id}\` on your PATH.\n${agent.missingHelp}\n`);
    process.exit(127);
  }
  // Claude writes the best questions, so it does whenever it is installed; otherwise the agent itself.
  // With writer "ollama", a model on this machine writes them and no code leaves it.
  const writer =
    config.writer === 'ollama'
      ? { path: '', adapter: ollamaWriter, model: config.ollamaModel }
      : claudePath
        ? { path: claudePath, adapter: claudeAgent.writer, model: config.model }
        : { path: agentPath, adapter: agent.writer, model: config.model === DEFAULT_CONFIG.model ? agent.writer.defaultModel : config.model };

  // `--staged`: questions about `git diff --cached` for the VS Code panel, no agent session.
  if (staged) {
    let diff;
    try {
      diff = execFileSync('git', ['diff', '--cached', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    } catch {
      process.stderr.write('hyperfocus: --staged needs a git repository (git diff --cached failed).\n');
      process.exit(1);
    }
    process.exit(await runStaged({ cwd: process.cwd(), diff, config, writer }));
  }

  if (process.stdin.isTTY && process.stdout.isTTY) {
    ensureSpawnHelperIsExecutable();
    await runFocus(agentPath, claudeArgs, { auto, config, agent, writer });
  } else {
    runPlain(agentPath, claudeArgs);
  }
}
