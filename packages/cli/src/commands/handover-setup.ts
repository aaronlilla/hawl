/**
 * What `hawl handover setup` prints: a prompt the person pastes to their own agent, which sets up
 * auto-clear for its own terminal and proves it (SPEC H28). Commands per terminal from the official
 * docs (checked 2026-10-21): tmux man7.org/linux/man-pages/man1/tmux.1.html (send-keys -t pane id from
 * TMUX_PANE; a string that is no key name goes in as characters, then the key Enter, in one call); WezTerm wezterm.org/cli/cli/send-text.html (--pane-id,
 * --no-paste; Enter as a CR byte is unverified); kitty sw.kovidgoyal.net/kitty/remote-control/ (text
 * uses Python escapes; needs allow_remote_control, and --to because the clear step has no
 * controlling terminal); iTerm2 iterm2.com/3.4/documentation-scripting.html (write text adds a
 * newline; unique id = the part of ITERM_SESSION_ID after ":" is unverified). Windows consoles
 * (Windows Terminal, conhost, the VS Code terminal, mintty on a pseudo console) have no command that
 * types into a pane, so Hawl's own step writes key events into the agent's console (handover-console.ts).
 */
export const SETUP_PROMPT = `Paste this to your Claude Code agent in this folder:

---
Set up Hawl's automatic handover clear for this terminal, then prove it. Report each step to me.

1. Find your terminal from your own environment: run \`env\` (or \`Get-ChildItem env:\` in PowerShell) and look only at TMUX, TMUX_PANE, WEZTERM_PANE, KITTY_WINDOW_ID, KITTY_LISTEN_ON, ITERM_SESSION_ID, TERM_PROGRAM, WT_SESSION.
2. Pick the clear command for it and write it as JSON to a file (for example clear.json). {text} is filled by Hawl with /clear and nothing else; \${NAME} is read from your environment.
   - tmux (TMUX_PANE set): [["tmux","send-keys","-t","\${TMUX_PANE}","{text}","Enter"]]
   - WezTerm (WEZTERM_PANE set): [["wezterm","cli","send-text","--pane-id","\${WEZTERM_PANE}","--no-paste","{text}\\r"]]
   - kitty (KITTY_WINDOW_ID and KITTY_LISTEN_ON set; kitty.conf needs allow_remote_control and listen_on): [["kitten","@","--to","\${KITTY_LISTEN_ON}","send-text","--match","id:\${KITTY_WINDOW_ID}","{text}\\\\r"]]
   - iTerm2 (ITERM_SESSION_ID set; macOS may ask to allow automation): [["osascript","-e","set sid to \\"\${ITERM_SESSION_ID}\\"","-e","set uid to text ((offset of \\":\\" in sid) + 1) thru -1 of sid","-e","tell application \\"iTerm2\\"","-e","repeat with w in windows","-e","repeat with t in tabs of w","-e","repeat with s in sessions of t","-e","if unique id of s is uid then tell s to write text \\"{text}\\"","-e","end repeat","-e","end repeat","-e","end repeat","-e","end tell"]]
   - Windows, in Windows Terminal (WT_SESSION set), Git Bash's window (TERM_PROGRAM=mintty), the VS Code terminal or a plain console (tested with real Claude Code 2.1.301 in a plain Windows console (conhost), Git Bash's window (mintty) and Windows Terminal; untested in the VS Code terminal; needs Claude Code 2.x, which runs as claude.exe): [["hawl:windows-console","{text}"]]
   - The VS Code terminal on macOS or Linux, or nothing you recognise: stop here. Tell me no outside command can type into this terminal today, so I type /clear myself after a handover; writing and picking up handovers still work. If you are not sure which terminal this is, ask me instead of guessing.
3. Run: hawl handover config --on --template-file clear.json
4. Run: hawl handover test
   Then end your turn at once. About 2 seconds after your turn ends, a plain-text marker like hawl-handover-test-... is typed into this terminal and sent as your next prompt, an ordinary prompt, and Hawl tells you PASSED or FAILED. That causes one short extra turn: reply ok (or nothing) and carry on. Nothing is cleared by the test.
5. Tell me the result. On FAILED, auto-clear stays off: tell me the reason and what you would change, and ask me before trying another command.
---

After it passes, the agent ends a handover with \`hawl handover write\` and then \`hawl handover clear\` as its very last step. Turn it off any time with hawl handover config --off.

Terminal support: tmux (tested in a real pane), WezTerm, kitty and iTerm2, with commands from each terminal's docs; on Windows, Hawl's own console step (tested with real Claude Code 2.1.301 in a plain Windows console (conhost), Git Bash's window (mintty) and Windows Terminal; the VS Code terminal untested). WezTerm, kitty, iTerm2 and Windows Terminal have not been run yet, so the test is what proves them. The VS Code terminal on macOS or Linux: type /clear yourself. Codex is not supported (it blocks /clear while a task runs).`;
