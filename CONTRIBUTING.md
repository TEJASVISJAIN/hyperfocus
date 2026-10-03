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

`main` is protected: every change, including the maintainer's, lands through a pull request that
passes CI and is squash-merged. Fork the repository, branch from `main`, and open a pull request.

CI runs on every pull request: the tests and typecheck on macOS and Linux with Node 22 and 24, the
npm package installed and run the way users get it, and the VS Code extension's tests and package
(downloadable from the run as `hyperfocus-vsix`). **CI passed** must be green to merge. Windows runs
too, but is experimental and not required yet. A first-time contributor's run waits for a maintainer
to approve it.

- Keep each pull request to one change, with tests at the same level as the ones beside it. Tests
  check behaviour through public interfaces (a fake `claude` in `test/fixtures/`, a fake Ollama server),
  not internals.
- Match the surrounding code: its naming, its comment density, plain ESM JavaScript with JSDoc types.
- User-facing changes get a line in `CHANGELOG.md` under an `Unreleased` heading.

Issues labelled [good first issue](https://github.com/TEJASVISJAIN/hyperfocus/labels/good%20first%20issue)
are small and self-contained. Comment on one before you start, so two people don't take it.

## Reporting a bug

Include the output of `hyperfocus --doctor`, your OS and terminal, and the agent and its version.
Run with `HYPERFOCUS_DEBUG=1` for a debug log if you can. Never paste a diff or log that contains
secrets; hyperfocus redacts what it recognises, but check before you post.

Security problems go privately, not in an issue: see [SECURITY.md](SECURITY.md).

## Releases

The maintainer bumps the version in `package.json` and `CHANGELOG.md` in a pull request, then tags the
merged commit `vX.Y.Z`. The release workflow checks the tag, the changelog and the tests, waits for
approval, publishes to npm with provenance, and creates a GitHub Release with the changelog section
and the VS Code extension package.
