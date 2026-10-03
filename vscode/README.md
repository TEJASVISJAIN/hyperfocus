# hyperfocus for VS Code

Your AI agent writes the code. hyperfocus makes sure you understand it.

While Claude Code, Codex CLI or Gemini CLI works, [hyperfocus](https://tejasvisjain.github.io/hyperfocus-web/)
asks you short multiple-choice questions about the change it's making: spot the bug, predict the
behaviour, why this approach. This extension puts those questions in your editor.

![The hyperfocus panel: a live question, the answer, a follow-up and a saved question](https://tejasvisjain.github.io/hyperfocus-web/vscode-live.gif)

## What you get

- **Questions in the sidebar while your agent works.** Click an answer or press `1`–`9`. You see
  right away whether you were right, and why. The terminal stays on your agent; if the sidebar is
  closed, hyperfocus asks there instead.
- **Next, Save, or ask a follow-up** about the answer. Skip or flag a bad question with one click.
- **Jump to the code.** Click the question's file to open it at the lines the question is about.
- **Gutter marks.** Lines you've been quizzed on get a green or red dot. Hover it for the question.
- **Review staged changes.** The 🎓 button in the Source Control view quizzes you on your own staged
  diff before you commit. No agent needed.
- **Your progress:** how many you've answered, how often you're right, your streak, the topics worth
  another look, and your saved questions.
- **Status bar and a notification** when the agent finishes.

## Get started

1. Install a coding agent: [Claude Code](https://claude.com/claude-code), Codex CLI or Gemini CLI.
2. Open the hyperfocus sidebar and click **Start**. It runs your agent through hyperfocus in a
   terminal (with `npx` if you haven't installed it: `npm i -g @ddalus/hyperfocus`).
3. Give the agent a task. Questions show up in the sidebar while it works.

The **Learn while your AI codes** walkthrough (Help → Welcome) goes through the same steps.

## Privacy and cost

The extension never calls a model and never sends anything anywhere. It reads the files hyperfocus
writes in `~/.hyperfocus` and follows a running session over a local socket that only your user can
open. The questions are written by hyperfocus using your agent's own login, about $0.004 per batch
of three on Claude Haiku. [What it costs](https://tejasvisjain.github.io/hyperfocus-web/#cost).

## Settings

| Setting | Default | |
| --- | --- | --- |
| `hyperfocus.agent` | first installed | which agent to run: `claude`, `codex` or `gemini` |
| `hyperfocus.command` | `npx @ddalus/hyperfocus` | left as it is, the extension uses `hyperfocus` when installed; anything else runs exactly as written |
| `hyperfocus.notifications` | on | notify when the agent finishes |
| `hyperfocus.gutterMarks` | on | the green and red marks beside lines you were quizzed on |
| `hyperfocus.home` | `~/.hyperfocus` | where hyperfocus keeps its data |

The live view needs hyperfocus 0.7.0 or later. With an older one the panel says so.

## Developing

`npm test` runs the tests with plain node. `live.test.js` connects to hyperfocus's real bridge from
`../src`, so the two can't drift apart unnoticed. The webview, commands and decorations aren't
tested automatically; before a release, check them by hand in VS Code with the new hyperfocus:

- [ ] Start from the panel (one agent, several, none; hyperfocus installed and not): no prompts
- [ ] Sidebar open: the terminal stays on the agent and the question appears in the panel; sidebar closed: the terminal asks
- [ ] Answer by click and by `1`–`9`; Next, Save, follow-up, skip, not a good question
- [ ] Agent finishes mid-question: notification, Keep answering, Done
- [ ] Click the question's file: the right lines open, highlighted
- [ ] Gutter marks appear after answering, follow edits, hide with the setting
- [ ] Saved questions appear under Your progress; Open the code works
- [ ] Review staged changes: questions appear, End review stops it; nothing staged says so
- [ ] Status bar text and click, with and without a session
- [ ] An older hyperfocus (0.6) shows the update message
