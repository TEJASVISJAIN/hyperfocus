# Contributing

Thanks for helping. Bug reports, small fixes and reports from platforms we haven't tested on (Windows,
Codex, Gemini CLI, Open VSX editors) are all welcome.

## Getting started

You need Node.js 22 or newer. On Linux, `npm ci` compiles `node-pty`, so you also need `python3`,
`make` and a C++ compiler.

```sh
git clone https://github.com/TEJASVISJAIN/hyperfocus.git
cd hyperfocus
npm ci
npm test               # the whole suite; no agent or network needed
npm run typecheck
node bin/hyperfocus.js --demo   # the real quiz on a scripted change
```

Run one file while you work: `node --test test/quiz-engine.test.js`.

The VS Code extension lives in `vscode/` and has its own tests: `cd vscode && npm test`.

## How it fits together

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) covers the processes, modules and why they are shaped
the way they are. [`docs/FORMATS.md`](docs/FORMATS.md) is the contract for the panel bridge, the config
file and the data files: within 1.x these only grow, so a change there must only add.

## Pull requests

- Keep each pull request to one change, with tests at the same level as the ones beside it. Tests
  check behaviour through public interfaces (a fake `claude` in `test/fixtures/`, a fake Ollama server),
  not internals.
- Match the surrounding code: its naming, its comment density, plain ESM JavaScript with JSDoc types.
- `npm test` and `npm run typecheck` must pass. CI runs them on macOS, Linux and Windows.
- User-facing changes get a line in `CHANGELOG.md` under an `Unreleased` heading.

Issues labelled [good first issue](https://github.com/TEJASVISJAIN/hyperfocus/labels/good%20first%20issue)
are small and self-contained. Comment on one before you start, so two people don't take it.

## Reporting a bug

Include the output of `hyperfocus --doctor`, your OS and terminal, and the agent and its version.
Run with `HYPERFOCUS_DEBUG=1` for a debug log if you can. Never paste a diff or log that contains
secrets; hyperfocus redacts what it recognises, but check before you post.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).
