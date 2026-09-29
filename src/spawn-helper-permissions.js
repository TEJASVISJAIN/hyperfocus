import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// node-pty 1.1.0 publishes its macOS prebuilt `spawn-helper` without the execute bit,
// which makes every spawn fail with "posix_spawnp failed". npm doesn't restore it,
// so we fix it at startup instead of relying on a postinstall step (skipped by some installers).
export function ensureSpawnHelperIsExecutable() {
  const require = createRequire(import.meta.url);
  const packageRoot = dirname(require.resolve('node-pty/package.json'));
  const candidates = [
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
  ];

  for (const helperPath of candidates) {
    if (!existsSync(helperPath)) continue;
    const mode = statSync(helperPath).mode;
    if ((mode & 0o111) === 0o111) continue;
    try {
      chmodSync(helperPath, mode | 0o755);
    } catch {
      // Read-only install location: node-pty will report the spawn failure itself.
    }
  }
}
