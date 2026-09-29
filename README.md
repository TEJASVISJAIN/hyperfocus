# hyperfocus

Stay in hyperfocus while your coding agent works, instead of reaching for your phone.

`hyperfocus` runs the real Claude Code. When the agent has been busy for a few seconds, the terminal
switches to a short quiz about **the change Claude is making right now**: why it's done this way,
what could break, which edge cases matter. As soon as Claude finishes or needs you, the terminal
switches back, with a recap of what you missed.

```
 hyperfocus · editing src/auth.ts · 0:14            Ctrl-] back to Claude
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

You need **Node.js 22 or newer** and **[Claude Code](https://claude.com/claude-code), installed and
logged in**. If you already use `claude`, you're set.

```sh
npm install -g hyperfocus
hyperfocus                  # use it exactly like `claude`
```

There is no separate account, sign-up or API key. hyperfocus runs your own `claude`, both for your
session and for the small model calls that write the questions, so it uses whatever login Claude Code
already has: a Claude subscription, an API key, `apiKeyHelper`, or Bedrock/Vertex. The question calls
count toward your own usage, at about $0.003 per batch.

Every argument is passed through to `claude`: `hyperfocus --continue`, `hyperfocus --model sonnet`,
and so on. When input or output is piped (`echo hi | hyperfocus -p`), hyperfocus steps aside and runs
`claude` directly.

**Linux:** installing compiles one native dependency (`node-pty`), so you need `python3`, `make` and a
C++ compiler (`sudo apt install build-essential python3` on Debian/Ubuntu). macOS needs nothing extra.
Windows isn't supported yet.

## Keys

| Key | Where | Does |
| --- | --- | --- |
| `Ctrl-]` | anywhere | switch between Claude and the focus view |
| `1`–`4` | focus view | answer the question |
| `s` | focus view | skip the question |
| `f` | after an answer | ask your own follow-up question; Enter to send, Esc to cancel |
| `Enter` / `c` | when Claude finishes mid-question | go back to Claude / keep going with the quiz |
| any key | after an answer or on the recap | continue |

Keys you press in the focus view never reach Claude.

## When it switches

- **To the focus view:** after the agent has been busy for 8 seconds, and you haven't typed for 2 seconds.
  Quick replies never interrupt you.
- **Back to Claude:** the moment Claude finishes, asks for input (a permission prompt, a question) or
  you interrupt it with Esc. You get a terminal bell and, on macOS, a notification.
  - **In the middle of a question?** It stays on screen with a prompt: `Enter` goes back to Claude, `c`
    (or just answering) keeps going. If you keep going, hyperfocus keeps writing questions about the
    finished change until you go back with `Ctrl-]`.
  - Otherwise, if you were in the focus view for 15 seconds or more, or answered anything, a "while you
    were away" card shows first.
- If you switch back to Claude yourself, hyperfocus stays out of the way until your next prompt.

## Options

| Flag / variable | Default | |
| --- | --- | --- |
| `--no-auto` | off | never open the focus view by itself; `Ctrl-]` still works |
| `--stats` | | print quiz answers and accuracy per project, then exit |
| `HYPERFOCUS_DELAY_MS` | `8000` | how long the agent must be busy before the focus view opens |
| `HYPERFOCUS_DEBUG=1` | off | log hook events and errors to `~/.hyperfocus/debug.log` |
| `HYPERFOCUS_CLAUDE_BIN` | `claude` on `PATH` | the Claude Code executable to run |

## How it works

- **Hooks, without touching your settings.** hyperfocus starts Claude with
  `claude --settings '{"hooks": …}'`. Claude Code merges these hooks with your own, so nothing on disk
  changes. The hooks (`UserPromptSubmit`, `PreToolUse` for reads, `PostToolUse` for edits and commands,
  `Stop`, `Notification`) forward each event to hyperfocus over a unix socket. The hook script never
  prints and always exits 0, so it can't affect Claude.
- **One terminal.** Claude runs in a pseudo-terminal that hyperfocus owns. The focus view is drawn on the
  alternate screen. Claude's output is held back while the quiz is up and replayed exactly when you
  return, so Claude's screen comes back intact.
- **Questions.** A one-shot `claude -p --model haiku` call reads your prompt, the files Claude looked at
  and the diffs it wrote, and returns a summary plus multiple-choice questions. That call has no tools,
  no MCP, none of your hooks and no thinking, which keeps it to about 6 seconds and $0.003. It asks again
  on the first change, after every 3 new edits, or when you run out of questions.
- **Follow-ups.** After an answer, press `f` and ask anything about it ("why not a circuit breaker?").
  The same lean Haiku call answers in a few sentences, using the diff, the question and your earlier
  follow-ups as context. It runs beside question generation and never blocks it.
- **History.** Every answer is appended to `~/.hyperfocus/history.jsonl` for `hyperfocus --stats` (and,
  later, for bringing back the questions you got wrong).

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

## License

[MIT](LICENSE)
