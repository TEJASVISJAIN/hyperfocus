# hyperfocus for VS Code

A sidebar for [hyperfocus](https://tejasvisjain.github.io/hyperfocus-web/), the quiz that runs while
your coding agent works.

- **Stats:** questions answered, how often you're right over 30 days, and your day streak.
- **Weak spots:** the concepts you miss most.
- **Saved questions:** everything you pressed `w` on, with your answer, the right one, the code and
  your follow-ups. **Open the notebook** shows them all as Markdown.
- **Recently missed:** the last questions you got wrong.
- **Start hyperfocus in a terminal**, in this workspace.

It reads the files hyperfocus writes in `~/.hyperfocus` and updates as you answer. Nothing leaves
your machine.

Settings: `hyperfocus.command` (default `npx @ddalus/hyperfocus`; try `hyperfocus codex`) and
`hyperfocus.home`.
