# 15 s demo. Render with: vhs packages/cli/demo/gif.tape
Output demo.gif
Set Shell "bash"
Set FontSize 18
Set Width 1200
Set Height 640
Set TypingSpeed 45ms

# Beat 1 (0-5 s): the old way. Copy-paste between two agents.
Type "# before: you are the clipboard between two agents"
Enter
Sleep 2s
Type "pbpaste | wc -l   # 212 lines of test output, pasted by hand"
Enter
Sleep 2s

# Beat 2 (5-15 s): the handoff.
Type "npx hawl.ai local && npx hawl.ai join --local"
Enter
Sleep 3s
Type "hawl status"
Enter
Sleep 2s
Type "# agent A: handoff -> agent B. B answers with the report. You did nothing."
Enter
Sleep 3s
