import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { dataDir } from './data-dir.js';
import { debugLog } from './debug-log.js';
import { askWriterOnce } from './quiz-engine.js';
import { isSensitivePath, redactSecrets } from './redact.js';

// Each source is capped so a big monorepo costs the same as a small project.
const CAPS = { readme: 4000, notes: 3000, manifest: 1500, tree: 150, commits: 15, changed: 30 };
const TREE_DEPTH = 3;
const MAX_BRIEF_CHARS = 3000; // well under 1,000 tokens
const NON_GIT_MAX_AGE_MS = 24 * 3600_000;
const SKIPPED_FOLDERS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor', '.next', '.nuxt', 'coverage', '__pycache__', '.venv', 'venv', '.turbo', '.cache', '.idea', '.vscode', 'Pods', '.gradle']);
const READMES = ['README.md', 'README', 'README.rst', 'README.txt', 'readme.md'];
const NOTES = ['CLAUDE.md', 'AGENTS.md'];
const MANIFESTS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'mix.exs', 'Package.swift'];

export const BRIEF_SYSTEM_PROMPT =
  'You write a short project brief for someone who writes quiz questions about changes to this codebase. ' +
  'From the material given, describe in plain prose, at most 150 words: what the project is for, how it is ' +
  'laid out (the main folders and what lives in them), the main languages, frameworks and tools, and what is ' +
  'changing lately. No markdown headings, no lists of every file, nothing that is not in the material.';

const git = (cwd, args) =>
  new Promise((resolve) => execFile('git', args, { cwd, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : String(stdout))));

/** Where the brief for `cwd` comes from: the repository root and HEAD, or just the folder outside git. */
export async function projectKey(cwd) {
  const root = (await git(cwd, ['rev-parse', '--show-toplevel']))?.trim() || null;
  const head = root ? (await git(cwd, ['rev-parse', 'HEAD']))?.trim() || 'no-commits' : null;
  return { root: root ?? cwd, head };
}

const capped = (text, limit) => (text.length > limit ? text.slice(0, limit) + '\n… (cut)' : text);

function readSmall(path, limit) {
  if (isSensitivePath(path)) return null;
  try {
    return capped(readFileSync(path, 'utf8'), limit);
  } catch {
    return null;
  }
}

// Folders first, depth-limited, dependency and build folders left out, at most CAPS.tree entries.
function folderTree(root) {
  const lines = [];
  const walk = (folder, depth) => {
    let entries;
    try {
      entries = readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (lines.length >= CAPS.tree) return;
      if (entry.isDirectory() ? SKIPPED_FOLDERS.has(entry.name) : isSensitivePath(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      const path = join(folder, entry.name);
      lines.push(relative(root, path) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory() && depth < TREE_DEPTH) walk(path, depth + 1);
    }
  };
  walk(root, 1);
  return lines;
}

/**
 * What the brief is written from: README, CLAUDE.md or AGENTS.md, build manifests, a folder tree,
 * recent commit subjects and the files with uncommitted changes. Each is size-capped; sensitive files
 * are never read; everything passes through secret redaction.
 * @returns {Promise<string>}
 */
export async function gatherSources(root, { isGit = true } = {}) {
  const sections = [];
  const first = (names, limit) => {
    for (const name of names) {
      const text = readSmall(join(root, name), limit);
      if (text !== null) return { name, text };
    }
    return null;
  };
  const readme = first(READMES, CAPS.readme);
  if (readme) sections.push(`<file name="${readme.name}">\n${readme.text}\n</file>`);
  for (const name of NOTES) {
    const text = readSmall(join(root, name), CAPS.notes);
    if (text !== null) sections.push(`<file name="${name}">\n${text}\n</file>`);
  }
  for (const name of MANIFESTS) {
    const text = readSmall(join(root, name), CAPS.manifest);
    if (text !== null) sections.push(`<file name="${name}">\n${text}\n</file>`);
  }
  const tree = folderTree(root);
  if (tree.length) sections.push(`<tree>\n${tree.join('\n')}\n</tree>`);
  if (isGit) {
    const commits = (await git(root, ['log', `-${CAPS.commits}`, '--format=%s']))?.trim();
    if (commits) sections.push(`<recent-commits>\n${commits}\n</recent-commits>`);
    // `XY path` lines; names only, and not the files that hold secrets or the folders left out above.
    const status = await git(root, ['status', '--porcelain', '--untracked-files=normal']);
    const changed = (status ?? '')
      .split('\n')
      .map((line) => line.slice(3).replace(/^.* -> /, ''))
      .filter((path) => path && !isSensitivePath(path) && !path.split('/').some((part) => SKIPPED_FOLDERS.has(part)))
      .slice(0, CAPS.changed);
    if (changed.length) sections.push(`<uncommitted>\n${changed.join('\n')}\n</uncommitted>`);
  }
  return redactSecrets(sections.join('\n\n'));
}

const cachePath = (folder, root) => join(folder, createHash('sha256').update(root).digest('hex').slice(0, 16) + '.json');

function readCache(path) {
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    return typeof cached?.brief === 'string' ? cached : null;
  } catch {
    return null;
  }
}

/**
 * A short description of the project, built once in the background and cached per repository
 * until HEAD moves (outside git: per folder, for a day). `get()` never waits: it is null until the
 * first brief is ready, and questions asked before then go without it.
 *
 * @param {{
 *   cwd: string,
 *   writer: { path: string, adapter: import('./agents/claude.js').QuestionWriter, model: string | null },
 *   env?: NodeJS.ProcessEnv,
 *   folder?: string,
 *   now?: () => number,
 * }} options
 */
export function createProjectBrief({ cwd, writer, env = process.env, folder = join(dataDir(env), 'briefs'), now = Date.now }) {
  let brief = null;
  let building = null; // the build in progress, so two prompts never start two
  let builtFor = null; // the head the current brief describes

  async function build(key) {
    const prompt = await gatherSources(key.root, { isGit: key.head !== null });
    if (!prompt.trim()) return null;
    const text = await askWriterOnce(writer, { systemPrompt: BRIEF_SYSTEM_PROMPT, prompt, env });
    if (!text) return null;
    const fitted = redactSecrets(capped(text, MAX_BRIEF_CHARS));
    try {
      mkdirSync(folder, { recursive: true });
      const path = cachePath(folder, key.root);
      writeFileSync(path + '.tmp', JSON.stringify({ v: 1, root: key.root, head: key.head, builtAt: new Date(now()).toISOString(), brief: fitted }) + '\n');
      renameSync(path + '.tmp', path);
    } catch (error) {
      debugLog('could not cache the project brief', error.message);
    }
    return fitted;
  }

  // Uses the cached brief when it still describes the project; otherwise builds a new one.
  async function refresh() {
    if (building) return building;
    building = (async () => {
      const key = await projectKey(cwd);
      if (brief !== null && key.head !== null && builtFor === key.head) return;
      const cached = readCache(cachePath(folder, key.root));
      const fresh = cached && (key.head !== null ? cached.head === key.head : now() - Date.parse(cached.builtAt) < NON_GIT_MAX_AGE_MS);
      if (fresh) {
        brief = cached.brief;
        builtFor = key.head;
        return;
      }
      if (cached && brief === null) brief = cached.brief; // older, but better than nothing meanwhile
      const built = await build(key);
      if (built) {
        brief = built;
        builtFor = key.head;
      }
    })()
      .catch((error) => debugLog('project brief failed', error.message))
      .finally(() => (building = null));
    return building;
  }

  return {
    /** The brief, or null while none is ready. */
    get: () => brief,
    /** Checks the brief still matches the project and rebuilds it in the background if not. */
    refresh,
  };
}
