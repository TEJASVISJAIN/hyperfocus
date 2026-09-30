import { execFile } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join } from 'node:path';
import { probeQuestionWriter } from './quiz-engine.js';

const MIN_NODE = 22;
const MIN_COLS = 60;
const MIN_ROWS = 20;
const MARKS = { ok: '✔', warn: '!', fail: '✘', skip: '-' };

/**
 * @typedef {{ status: 'ok' | 'warn' | 'fail' | 'skip', detail: string, hint?: string }} Finding
 * @typedef {{ name: string, run: () => Finding | Promise<Finding> }} Check
 */

/** Runs the checks in order; one that throws counts as failed, with its message. */
export async function runDoctor(checks) {
  const results = [];
  for (const check of checks) {
    try {
      results.push({ name: check.name, ...(await check.run()) });
    } catch (error) {
      results.push({ name: check.name, status: 'fail', detail: error.message });
    }
  }
  return results;
}

export function formatDoctor(results) {
  const width = Math.max(...results.map((result) => result.name.length)) + 2;
  const lines = ['hyperfocus doctor', ''];
  for (const result of results) {
    lines.push(`  ${MARKS[result.status]} ${result.name.padEnd(width)}${result.detail}`);
    if (result.hint && result.status !== 'ok') lines.push(`    ${' '.repeat(width)}→ ${result.hint}`);
  }
  const failed = results.filter((result) => result.status === 'fail').length;
  lines.push('', failed ? `${failed} problem${failed === 1 ? '' : 's'} to fix.` : 'Everything hyperfocus needs is in place.', '');
  return lines.join('\n');
}

/** @returns {Finding} */
export function checkNode(version = process.versions.node) {
  const major = Number(version.split('.')[0]);
  return major >= MIN_NODE ? { status: 'ok', detail: `v${version}` } : { status: 'fail', detail: `v${version}`, hint: `hyperfocus needs Node.js ${MIN_NODE} or newer` };
}

/** @returns {Finding} */
export function checkTerminal(stdout, stdin) {
  if (!stdin.isTTY || !stdout.isTTY) return { status: 'warn', detail: 'not an interactive terminal', hint: 'run hyperfocus in a terminal; piped, it steps aside and runs claude directly' };
  const size = `${stdout.columns}×${stdout.rows}`;
  if (stdout.columns < MIN_COLS || stdout.rows < MIN_ROWS) return { status: 'warn', detail: size, hint: `questions read best in ${MIN_COLS}×${MIN_ROWS} or larger` };
  return { status: 'ok', detail: size };
}

const run = (command, args, env) =>
  new Promise((resolve) =>
    execFile(command, args, { env, timeout: 15_000 }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })),
  );

const onPath = (name, env) =>
  (env.PATH || '').split(delimiter).some((directory) => {
    try {
      accessSync(join(directory, name), constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });

/** The checks `hyperfocus --doctor` runs, against the real machine. */
export function defaultChecks({ claudePath, config, problems, dataDir, env = process.env, stdout = process.stdout, stdin = process.stdin }) {
  return [
    { name: 'node', run: () => checkNode() },
    {
      name: 'claude',
      run: async () => {
        if (!claudePath) return { status: 'fail', detail: 'not found on PATH', hint: 'install Claude Code, or set HYPERFOCUS_CLAUDE_BIN to its path' };
        const { code, stdout: version } = await run(claudePath, ['--version'], env);
        return code === 0 ? { status: 'ok', detail: `${version.trim()} (${claudePath})` } : { status: 'warn', detail: `${claudePath} did not report a version` };
      },
    },
    {
      name: 'login',
      run: async () => {
        if (!claudePath) return { status: 'skip', detail: 'skipped: no claude' };
        const { code } = await run(claudePath, ['auth', 'status'], env);
        return code === 0 ? { status: 'ok', detail: 'claude is logged in' } : { status: 'fail', detail: 'claude is not logged in', hint: 'run `claude auth login` (or set up an API key)' };
      },
    },
    {
      name: 'node-pty',
      run: async () => {
        await import('node-pty');
        const packageRoot = dirname(createRequire(import.meta.url).resolve('node-pty/package.json'));
        const helper = join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
        if (existsSync(helper) && (statSync(helper).mode & 0o111) !== 0o111) {
          return { status: 'fail', detail: 'spawn-helper is not executable', hint: `chmod +x ${helper}` };
        }
        return { status: 'ok', detail: 'loads' };
      },
    },
    { name: 'terminal', run: () => checkTerminal(stdout, stdin) },
    {
      name: 'TERM',
      run: () => (!env.TERM || env.TERM === 'dumb' ? { status: 'warn', detail: env.TERM || 'not set', hint: 'colours and the full-screen quiz need a real terminal type such as xterm-256color' } : { status: 'ok', detail: env.TERM }),
    },
    { name: 'tmux', run: () => ({ status: 'ok', detail: env.TMUX ? 'inside tmux' : 'not inside tmux' }) },
    {
      name: 'notifications',
      run: () => {
        if (!config.notifications) return { status: 'ok', detail: 'off in config (the bell still rings)' };
        if (process.platform === 'darwin' && onPath('osascript', env)) return { status: 'ok', detail: 'macOS notifications' };
        return { status: 'warn', detail: 'terminal bell only', hint: 'desktop notifications are macOS-only for now' };
      },
    },
    { name: 'config', run: () => (problems.length ? { status: 'warn', detail: problems.join('; '), hint: 'fix these in ~/.hyperfocus/config.json' } : { status: 'ok', detail: 'no problems' }) },
    {
      name: 'data folder',
      run: () => {
        mkdirSync(dataDir, { recursive: true });
        const probe = join(dataDir, `.doctor-${process.pid}`);
        writeFileSync(probe, '');
        rmSync(probe);
        return { status: 'ok', detail: `${dataDir} is writable` };
      },
    },
    {
      name: 'questions',
      run: async () => {
        if (!claudePath) return { status: 'skip', detail: 'skipped: no claude' };
        const { ok, detail } = await probeQuestionWriter({ claudePath, model: config.model, env });
        return ok ? { status: 'ok', detail } : { status: 'fail', detail, hint: 'questions are written with `claude -p`; check that it works in this shell' };
      },
    },
  ];
}
