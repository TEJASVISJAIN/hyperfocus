#!/usr/bin/env node
// Stand-in for `claude` that also answers hyperfocus's quiz calls: `-p` runs go to the fake Haiku,
// everything else to the fake interactive Claude.
if (process.argv.includes('-p')) await import('./fake-haiku.js');
else await import('./fake-claude.js');
