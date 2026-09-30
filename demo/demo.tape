# Records `hyperfocus --demo` for the README and the website: `vhs demo/demo.tape` from the repo root.
Output demo/hyperfocus-demo.gif
Output demo/hyperfocus-demo.mp4

Require node
Set Shell "bash"
Set FontSize 15
Set Width 1100
Set Height 700
Set Padding 18
Set Theme "Catppuccin Mocha"
Set TypingSpeed 45ms

Hide
Type "export HYPERFOCUS_DEMO_SPEED=1.5 PS1='$ ' && alias hyperfocus='node bin/hyperfocus.js' && clear"
Enter
Show

Type "hyperfocus --demo"
Sleep 600ms
Enter
Sleep 2.5s
# Ask the scripted agent for its one change.
Enter
Sleep 6s
# The first time, an intro explains the keys.
Sleep 3s
Space
Sleep 3.5s
Down
Sleep 700ms
Enter
Sleep 3.5s
# The live view: what the agent is doing right now.
Type "l"
Sleep 4s
Type "l"
Sleep 500ms
# Next question: spot the bug, with real lines from the diff.
Space
Sleep 5s
Type "1"
Sleep 3s
# Keep it: w saves the question, your answer and the explanation to your notebook.
Type "w"
Sleep 2.5s
# The agent is done: Esc goes back to it, with a recap of the change.
Escape
Sleep 7s
