# claude-focus

Stay with your code while Claude works, instead of reaching for your phone.

`focus` runs the real Claude Code. When the agent has been busy for a few seconds, the terminal
switches to a short quiz about **the change Claude is making right now**: why it's done this way,
what could break, which edge cases matter. As soon as Claude finishes or needs you, the terminal
switches back, with a recap of what you missed.

```
 focus · editing src/auth.ts · 0:14                 Ctrl-] back to Claude
──────────────────────────────────────────────────────────────────────────

What's happening
  The agent is wrapping refreshToken() in a withRetry helper with 3
  attempts and a 200ms backoff.

Question 1
  With a fixed 200ms backoff used by many concurrent clients, what
  problem could emerge?

  1) Thundering herd: synchronized retry waves hammering the auth server
  2) Individual clients experience exponential slowdown
  3) The auth server runs out of file descriptors

  press 1-3 to answer · s to skip
```

## Install

Requires Node 22+ and [Claude Code](https://claude.com/claude-code), logged in.

```sh
npm install -g claude-focus   # or run from a checkout: node bin/focus.js
focus                          # use it exactly like `claude`
```

Every argument is passed through to `claude`: `focus --continue`, `focus --model sonnet`, and so on.
When input or output is piped (`echo hi | focus -p`), focus steps aside and runs `claude` directly.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| `Ctrl-]` | anywhere | switch between Claude and the focus view |
| `1`–`4` | focus view | answer the question |
| `s` | focus view | skip the question |
| any key | after an answer or on the recap | continue |

Keys you press in the focus view never reach Claude.

## When it switches

- **To focus:** after the agent has been busy for 8 seconds, and you haven't typed for 2 seconds.
  Quick replies never interrupt you.
- **Back to Claude:** the moment Claude finishes or asks for input (a permission prompt, a question).
  You get a terminal bell and a macOS notification. If you were in the focus view for 15 seconds
  or more, or answered anything, a "while you were away" card shows first.
- If you switch back to Claude yourself, focus stays out of the way until your next prompt.

## Options

| Flag / variable | Default | |
| --- | --- | --- |
| `--no-auto` | off | never open the focus view by itself; `Ctrl-]` still works |
| `--stats` | | print quiz answers and accuracy per project, then exit |
| `FOCUS_DELAY_MS` | `8000` | how long the agent must be busy before focus opens |
| `FOCUS_DEBUG=1` | off | log hook events and errors to `~/.focus/debug.log` |
| `FOCUS_CLAUDE_BIN` | `claude` on `PATH` | the Claude Code executable to run |

## How it works

- **Hooks, without touching your settings.** focus starts Claude with `claude --settings '{"hooks": …}'`.
  Claude Code merges these hooks with your own, so nothing on disk changes. The hooks (`UserPromptSubmit`,
  `PreToolUse` for reads, `PostToolUse` for edits and commands, `Stop`, `Notification`) forward
  each event to focus over a unix socket. The hook script never prints and always exits 0, so it
  can't affect Claude.
- **One terminal.** Claude runs in a pseudo-terminal that focus owns. The focus view is drawn on the
  alternate screen. Claude's output is held back while the quiz is up and replayed exactly when
  you return, so Claude's screen comes back intact.
- **Questions.** A one-shot `claude -p --model haiku` call (using your Claude login, with no tools,
  no settings, no MCP and thinking turned off) reads your prompt, the files Claude looked at and
  the diffs it wrote, and returns a summary plus multiple-choice questions. It asks again after
  every 3 new edits or when you run out of questions. A batch takes about 6 seconds and costs about $0.003.
- **History.** Every answer is appended to `~/.focus/history.jsonl` for `focus --stats` (and, later,
  for bringing back the questions you got wrong).

For diagrams, sequences, state machines and design decisions, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Privacy

The quiz model sees what the main agent already sees: your prompt, file paths, and the diffs Claude
wrote (up to about 20KB per run). It goes through your own Claude Code login, the same as Claude itself.
Nothing is sent anywhere else.

## Development

```sh
npm install
npm test           # node:test suite, includes PTY-driven end-to-end tests with a fake claude
npm run typecheck  # tsc over the JS sources
```
