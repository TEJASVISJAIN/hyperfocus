import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const agentPath = fileURLToPath(new URL('./demo-agent.js', import.meta.url));
const DEMO_DELAY_MS = 3000;

/**
 * Sets up `hyperfocus --demo`: a throwaway project folder to work in and a throwaway data folder,
 * so the demo's answers never reach the user's own history, stats or config.
 */
export function prepareDemo(env = process.env) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hyperfocus-demo-')));
  env.HYPERFOCUS_HOME = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(project, { recursive: true });
  process.chdir(project);
  const speed = Number(env.HYPERFOCUS_DEMO_SPEED) || 1;
  return { agentPath, delayMs: DEMO_DELAY_MS / speed };
}
