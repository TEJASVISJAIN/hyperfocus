# Architecture

`hyperfocus` is a transparent wrapper around the real Claude Code CLI. It owns the terminal, watches
what the agent does through Claude Code hooks, and, while the agent is busy, swaps Claude's screen
for a quiz about the change being made. This document covers how the pieces fit together and why
they are shaped this way.

- [System overview](#system-overview)
- [Processes and boundaries](#processes-and-boundaries)
- [Modules](#modules)
- [Sequences](#sequences)
- [State machines](#state-machines)
- [Data model](#data-model)
- [Terminal handling](#terminal-handling)
- [Failure handling](#failure-handling)
- [Testing strategy](#testing-strategy)
- [Design decisions](#design-decisions)
- [Known limitations](#known-limitations)

## System overview

```mermaid
flowchart LR
    user([Developer]) <-->|keys / screen| tty[Real terminal]
    tty <--> hyperfocus

    subgraph hyperfocus["hyperfocus (node process)"]
        direction TB
        screen[Screen<br/>claude view ⇄ focus view]
        policy[Auto-switch policy]
        session[Focus session]
        log[Activity log]
        engine[Quiz engine]
        view[Focus view<br/>quiz + recap]
        server[Event server<br/>unix socket]
        history[(~/.hyperfocus/history.jsonl)]
    end

    hyperfocus <-->|pseudo-terminal| claude[claude<br/>interactive Claude Code]
    claude -->|runs on each hook| hook[hyperfocus-hook.js]
    hook -->|JSON line| server
    engine -->|stdin prompt / JSON reply| haiku[claude -p --model haiku]
    haiku --> api[(Claude API<br/>via user's login)]
    claude --> api

    server --> session
    server --> policy
    session --> log
    session --> engine
    session --> view
    policy --> screen
    view --> screen
    session --> history
```

There are three kinds of process:

| Process | Lifetime | Role |
| --- | --- | --- |
| `hyperfocus` | the whole session | owns the real terminal, runs the logic |
| `claude` (interactive) | the whole session, child of hyperfocus in a PTY | the real Claude Code, unmodified |
| `hyperfocus-hook.js` | milliseconds, once per hook event | forwards one hook payload to hyperfocus |
| `claude -p --model haiku` | about 6s, once per question batch | writes the summary and questions |

## Processes and boundaries

```mermaid
flowchart TB
    subgraph terminal["User's terminal (raw mode)"]
        stdin[/stdin/]
        stdout[/stdout/]
    end

    subgraph focusproc["hyperfocus process"]
        router{{Screen.input}}
        mirror[xterm headless mirror]
        hold[held-back output]
    end

    subgraph pty["PTY"]
        claude[claude]
    end

    stdin --> router
    router -->|claude view| claude
    router -->|focus view| quiz[Focus view keys]
    router -->|"Ctrl-]"| toggle[toggle view]

    claude -->|output| mirror
    claude -->|output, claude view| stdout
    claude -->|output, focus view| hold
    hold -->|replayed on return| stdout
    quiz -->|frames| stdout

    claude -. "claude --settings {hooks}" .-> hooks[hyperfocus-hook.js]
    hooks -. "HYPERFOCUS_SOCK" .-> sock[(unix socket)]
    sock -.-> focusproc
```

Where the boundaries are, and what crosses them:

| Boundary | Mechanism | Payload |
| --- | --- | --- |
| user ↔ hyperfocus | the real TTY in raw mode | keystrokes in, ANSI out |
| hyperfocus ↔ claude | `node-pty` pseudo-terminal | raw bytes both ways, plus resizes |
| claude → hyperfocus | Claude Code hooks → `bin/hyperfocus-hook.js` → unix socket | one JSON hook payload per line |
| hyperfocus → quiz model | `claude -p` subprocess | prompt on stdin, `--output-format json` on stdout |
| hyperfocus → disk | append-only file | one JSON line per answered question |

Hooks are injected with `claude --settings '<json>'`. Claude Code **merges** these with the user's
own settings files (verified: a project `Stop` hook and the injected one both fire), so hyperfocus never
writes to the user's configuration.

## Modules

```mermaid
flowchart TB
    bin[bin/hyperfocus.js<br/>entry, flag parsing] --> app[app.js<br/>wiring]
    bin --> passthrough
    bin --> history
    app --> passthrough[passthrough.js<br/>PTY + raw TTY]
    app --> screen[screen.js<br/>view switching]
    app --> autoswitch[auto-switch.js<br/>when to switch]
    app --> server[event-server.js<br/>socket → events]
    app --> session[focus-session.js<br/>events → state]
    app --> recap[recap.js]
    app --> alert[alert.js<br/>bell + notification]
    app --> history[history.js]
    app --> hooksettings[hook-settings.js]
    server --> hookevents[hook-events.js<br/>payload → FocusEvent]
    session --> activity[activity-log.js]
    session --> engine[quiz-engine.js<br/>cadence + subprocess]
    session --> view[focus-view.js<br/>render + keys]
    engine --> prompt[quiz-prompt.js<br/>prompt + parser]
    view --> recap
    view --> layout[text-layout.js]
    hookbin[bin/hyperfocus-hook.js] -. socket .-> server
```

| Module | Responsibility | Tested at |
| --- | --- | --- |
| `bin/hyperfocus.js` | entry point: `--stats`, finding claude, TTY vs piped mode | CLI tests |
| `bin/hyperfocus-hook.js` | forward a hook payload to the socket; never print, always exit 0 | `events.test.js` |
| `src/app.js` | wires everything together; the only module that knows about all the others | end-to-end PTY tests |
| `src/passthrough.js` | spawn claude in a PTY; raw mode; signals; exit codes; piped fallback | `passthrough.test.js` |
| `src/screen.js` | which view is on screen; alternate screen; hold back and replay output; key routing | `passthrough.test.js` |
| `src/auto-switch.js` | the switching rules (delay, typing grace, manual override) | `auto-switch.test.js` (fake clock) |
| `src/event-server.js` + `hook-events.js` | unix socket server; hook payload → `FocusEvent` | `events.test.js` |
| `src/focus-session.js` | routes events to the log, engine and view; status line labels | via end-to-end tests |
| `src/activity-log.js` | per-run record of prompt, reads, diffs, commands, with size caps | `activity-log.test.js` |
| `src/quiz-engine.js` + `quiz-prompt.js` | when to ask the model; the subprocess; parsing and validating replies | `quiz-engine.test.js` (stub binary) |
| `src/focus-view.js` + `recap.js` + `text-layout.js` | pure rendering and key handling for the quiz and recap | `focus-view.test.js`, `recap.test.js` |
| `src/history.js` | append answers; aggregate `--stats` | `history.test.js` |
| `src/alert.js`, `debug-log.js`, `cli-args.js`, `claude-binary.js`, `spawn-helper-permissions.js` | small utilities | indirectly |

### Event vocabulary

Every Claude Code hook payload that hyperfocus cares about becomes one of six events
(`src/hook-events.js`):

| Hook | Tool matcher | `FocusEvent` |
| --- | --- | --- |
| `UserPromptSubmit` | | `busy { prompt }` |
| `PreToolUse` | `Read`, `Grep`, `Glob` | `read { target }` |
| `PostToolUse` | `Edit`, `MultiEdit`, `Write` | `edit { path, changes[{before, after}] }` |
| `PostToolUse` | `Bash` | `command { command }` |
| `Stop` | | `done` |
| `Notification` | | `needs-input { message }` |

## Sequences

### Startup

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant F as hyperfocus
    participant S as Event server
    participant C as claude (PTY)

    U->>F: hyperfocus [claude args]
    F->>F: parse focus-only flags (--no-auto, --stats)
    F->>F: find claude on PATH, chmod +x node-pty spawn-helper
    F->>S: listen on $TMPDIR/focus-<pid>.sock
    F->>C: spawn claude --settings {hooks} [args]<br/>env HYPERFOCUS_SOCK
    F->>F: TTY raw mode, resize listener, 1s clock
    C-->>U: Claude Code UI (passed straight through)
```

### One agent turn: auto-open, quiz, hand back

```mermaid
sequenceDiagram
    autonumber
    actor U as User
    participant C as claude
    participant H as hyperfocus-hook.js
    participant F as hyperfocus
    participant P as Auto-switch
    participant Q as Quiz engine
    participant M as claude -p haiku

    U->>C: types prompt + Enter (keys pass through)
    C->>H: UserPromptSubmit
    H->>F: {hook_event_name: UserPromptSubmit, prompt}
    F->>P: busy → start 8s timer
    F->>Q: update(run) — nothing yet but the prompt
    Q->>M: prompt + "No changes yet"
    C->>H: PreToolUse Read src/auth.ts
    H->>F: read event → status "reading src/auth.ts"
    Note over P: 8s busy and no typing for 2s
    P->>F: openFocus()
    F->>U: enter alternate screen, draw focus view
    M-->>Q: {"summary", "questions":[…]}
    Q->>F: batch → summary + questions shown
    U->>F: presses 2 (goes to the quiz, never to Claude)
    F->>U: ✔/✘ + explanation, appended to history
    C->>H: PostToolUse Edit src/auth.ts
    H->>F: edit event (first diff → fresh batch)
    F->>Q: update(run with diff)
    Q->>M: prompt + diff + questions already asked
    Note over C,F: Claude's output meanwhile is held back, not drawn
    C->>H: Stop
    H->>F: done
    F->>Q: cancel in-flight call
    F->>P: done → returnToClaude
    alt focus visible ≥15s or answered something
        F->>U: "While you were away" recap + bell + notification
        U->>F: any key (swallowed)
    else brief glance
        F->>U: bell + notification
    end
    F->>U: leave alternate screen, replay held-back output
```

### Permission prompt in the middle of a turn

```mermaid
sequenceDiagram
    autonumber
    participant C as claude
    participant F as hyperfocus
    participant P as Auto-switch
    actor U as User

    Note over F: focus view is up
    C->>F: Notification "Claude needs your permission to use Bash"
    F->>P: needs-input
    P->>F: returnToClaude("needs-input")
    F->>U: back to Claude + bell + notification with the message
    U->>C: approves
    C->>F: PostToolUse Bash (no new prompt event)
    F->>P: tool activity while idle → busy again, 8s timer
    P->>F: openFocus() — the unanswered question is still there
```

### Question generation

```mermaid
sequenceDiagram
    autonumber
    participant S as Focus session
    participant Q as Quiz engine
    participant M as claude -p

    S->>Q: update(run, {queuedQuestions})
    alt call in flight, run finished, or nothing to go on
        Q-->>S: (no-op)
    else first diff, or 3 new edits, or queue empty and something changed
        Q->>M: spawn with HYPERFOCUS_CHILD=1, MAX_THINKING_TOKENS=0,<br/>--tools "" --strict-mcp-config, disableAllHooks
        M-->>Q: JSON envelope with result text (often a fenced JSON block)
        alt reply is not valid JSON
            Q->>M: retry once
        end
        Q->>Q: drop malformed questions, remember asked ones
        Q-->>S: emit batch
    end
```

### Screen switch mechanics

```mermaid
sequenceDiagram
    autonumber
    participant C as claude output
    participant Sc as Screen
    participant T as Real terminal

    C->>Sc: bytes
    Sc->>Sc: mirror.write(bytes) (always)
    Sc->>T: bytes (claude view)
    Note over Sc: showFocus()
    alt Claude on its main screen
        Sc->>T: ESC[?1049h (terminal saves Claude's screen)
    else Claude already on the alternate screen
        Sc->>Sc: remember: repaint from the mirror later
    end
    Note over Sc,T: Claude's alternate-screen state is tracked from its output as it arrives,<br/>because the mirror parses asynchronously
    Sc->>T: sync-frame( hide cursor, clear, focus view )
    C->>Sc: bytes → held back
    C->>Sc: over 1MB held back → drop it, repaint later
    Note over Sc: showClaude()
    alt normal case
        Sc->>T: ESC[?1049l + cursor state + held-back bytes, verbatim
    else repaint (Claude was on its alternate screen, or over 1MB)
        Sc->>Sc: wait for the mirror to finish parsing
        alt Claude on its alternate screen now
            Sc->>T: clear + alternate buffer only
        else Claude on its main screen now
            Sc->>T: ESC[?1049l + clear + main buffer only
        end
        Sc->>T: output that arrived during the repaint
    end
    opt terminal resized while away
        Sc->>C: resize rows-1 then rows (Claude re-renders)
    end
```

## State machines

### Screen and auto-switch

```mermaid
stateDiagram-v2
    [*] --> Claude
    Claude --> Waiting: busy (prompt, or tool activity after needs-input)
    Waiting --> Claude: done / needs-input before the delay
    Waiting --> Claude: Esc / Ctrl-C (no Stop hook fires on an interrupt)
    Waiting --> Waiting: user typed within 2s (postpone)
    Waiting --> Focus: 8s elapsed and not typing
    Claude --> Focus: Ctrl-]
    Focus --> Claude: Ctrl-] (suppresses auto-open until the next prompt)
    Focus --> Finished: done / needs-input while a question is on screen
    Finished --> Claude: Enter or Ctrl-]
    Finished --> Focus: c or answering (keep going, questions keep coming)
    Focus --> Recap: done / needs-input, no question on screen, and visible ≥15s or answered ≥1
    Focus --> Claude: done / needs-input, no question on screen, brief glance
    Recap --> Claude: any key or Ctrl-]
```

### Focus view

```mermaid
stateDiagram-v2
    [*] --> Thinking: no question queued
    Thinking --> Asking: batch arrives
    Asking --> Feedback: 1–4 (answer recorded)
    Asking --> Asking: s (skip, recorded) and more queued
    Asking --> Thinking: s and queue empty
    Feedback --> Typing: f
    Typing --> Feedback: Esc
    Typing --> Answering: Enter (sent to Haiku with the diff and the thread)
    Answering --> Feedback: answer or failure shown (f asks again)
    Feedback --> Asking: any key, more queued
    Feedback --> Thinking: any key, queue empty (engine asks for more)
    Asking --> Asking: new run (unanswered question carried over)
```

## Data model

```mermaid
classDiagram
    class Run {
        string prompt
        number startedAt
        boolean finished
        string[] reads
        Edit[] edits
        string[] commands
    }
    class Edit {
        string path  "relative to project"
        string diff  "- removed / + added lines"
    }
    class Batch {
        string summary
        Question[] questions
    }
    class Question {
        string q
        string[] options  "2-4"
        int answer  "0-based"
        string why
    }
    class HistoryEntry {
        string ts
        string cwd
        string sessionId
        string question
        string[] options
        int answer
        int chosen
        bool correct
        bool skipped
        string[] files
    }
    Run "1" *-- "many" Edit
    Batch "1" *-- "1..3" Question
    Question ..> HistoryEntry : answered or skipped
```

Size limits keep the quiz call small and cheap: a diff is capped at 4KB per edit and 20KB per
run, and the **oldest** diffs are dropped first. Every edited file stays listed, with its diff
replaced by `(older change omitted)`.

## Terminal handling

- **Raw mode** is on for hyperfocus's whole lifetime and is restored on exit, crash or signal
  (`process.on('exit')`).
- **Alternate screen (`?1049`)** holds the focus view, so Claude's main screen and scrollback are
  never drawn over.
- **Replay beats repaint.** Claude Code draws its UI with relative cursor movements. Replaying its
  bytes exactly is the only way to keep its own idea of the screen correct, so the headless mirror is
  only a fallback for when Claude itself was on the alternate screen.
- **Ctrl-] detection** accepts `0x1d`, kitty (`CSI 93;5u`) and modifyOtherKeys (`CSI 27;5;93~`),
  because Claude Code turns on enhanced keyboard modes. The key is found anywhere in an input chunk,
  since fast typing and pastes merge keys into one chunk.
- **Synchronized output (`?2026`)** wraps every focus frame, so terminals that support it don't flicker
  on the 1-second clock redraw.
- **Piped mode:** if stdin or stdout isn't a TTY, hyperfocus runs `claude` with inherited stdio and does
  nothing else.

## Failure handling

| Failure | Behaviour |
| --- | --- |
| `claude` not on PATH | clear message, exit 127 |
| node-pty `spawn-helper` shipped without +x | fixed at startup (`spawn-helper-permissions.js`) |
| user interrupts Claude with Esc / Ctrl-C | Claude Code sends no `Stop` hook, so the key press itself ends the run and cancels the pending switch |
| Claude prints a lot while the focus view is up | past 1MB of held-back output, it is dropped and Claude's current screen is repainted from the mirror on return |
| malformed hook payload | fields are checked and bad payloads dropped; handler errors are caught so they can't kill the session |
| hyperfocus exits unexpectedly | the exit handler always switches the terminal back to Claude's screen |
| hyperfocus not listening / socket missing | hook exits 0 in milliseconds, prints nothing |
| hook takes too long | the hook script gives up after 500ms; Claude's hook timeout is 5s |
| quiz model returns prose or broken JSON | one retry, then skip that batch quietly |
| quiz model API error | no retry; the view keeps showing the summary and "Thinking of a question…" |
| model returns some malformed questions | those questions are dropped, the rest are kept |
| agent finishes mid-call | the call is killed and its result ignored |
| history file can't be written | logged with `HYPERFOCUS_DEBUG=1`; the session carries on |
| hyperfocus-spawned `claude -p` would trigger hooks | `HYPERFOCUS_CHILD=1` makes our hook a no-op, and `disableAllHooks` stops the user's hooks while their settings (and auth) still load |

## Testing strategy

Tests sit at seven agreed seams, all behind public interfaces:

1. **Hook → socket → events:** the real hook script against a real socket.
2. **Activity log:** fed recorded hook payloads through the same translation the server uses.
3. **Quiz engine:** against a stub `claude` binary (`test/fixtures/fake-haiku.js`) that records its
   argv, env and stdin.
4. **Auto-switch policy:** with `node:test` mock timers.
5. **Focus view and recap:** rendering as a function of state and size, plus key handling.
6. **History and `--stats`:** including the CLI with a temporary `HOME`.
7. **End to end in a PTY:** `hyperfocus` runs inside an outer pseudo-terminal against
   `test/fixtures/fake-claude.js`, which reports what it receives and can run the injected hook
   commands the way Claude Code would.

On top of that, hyperfocus was run against real Claude Code 2.1.285 in a throwaway project: auto-open,
a generated question, an answer, two real `Write` hooks, `Stop`, the recap and an intact return.

## Design decisions

| Decision | Chosen | Rejected, and why |
| --- | --- | --- |
| Where the quiz lives | wrapper that owns the terminal | second window (people won't switch views); a new frontend on the Agent SDK (would mean rebuilding Claude Code's UI) |
| Seeing agent activity | hooks via `--settings` | parsing the transcript JSONL (lags, undocumented format); editing `settings.json` (touches user config) |
| Hook → hyperfocus transport | unix socket, one line per payload | file tailing (polling, cleanup); HTTP (a port to manage) |
| Screen switching | alternate screen + byte replay | always repainting from the mirror (drifts from Claude's own screen model) |
| Question model | `claude -p --model haiku`, lean flags, no thinking, user settings kept for auth | Anthropic SDK (needs an API key the user may not have); default flags (~21k context tokens, ~30s with thinking) |
| When to ask again | first diff, every 3 edits, or when the queue is empty | one call per event (cost, noise) |
| Language | plain Node ESM, JSDoc types checked by `tsc` | TypeScript build step (slower hook startup, more tooling) |

## Known limitations

- **Linux:** node-pty 1.1.0 ships prebuilt binaries only for macOS and Windows, so on Linux it
  compiles on install (needs `python3`, `make` and a C++ compiler). Desktop notifications are
  macOS-only; the bell works everywhere.
- **Windows:** untested. Named pipes would replace the unix socket.
- **One session:** hyperfocus follows only the Claude process it started.
- **Subagents:** `SubagentStop` isn't hooked, so subagent activity shows up only through its tool events.
- **Replay after a resize while away:** held-back output was laid out for the old size. The resize
  nudge makes Claude re-render, but a brief glitch is possible.
- **Transcript and context:** the quiz model sees at most about 20KB of diffs per run, not the whole
  conversation.
