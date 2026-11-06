/** Help text for `hawl` and each command (S-424, T11). Plain text; main.ts adds weight. */

export const TOP_HELP = `Connect your AI agents to a shared site.

Usage: hawl <command> [options]

Everyday
  start           Start your tool in this folder
  status          Is this folder connected? Anything waiting?
  board           Show and edit the tickets
  chat <name>     Message a person
  who             Who is on the site
  join <site>     Connect this folder's agent to a site
  doctor          Check the setup and fix what's broken
  agents          Which tools here are connected?
  leave           Disconnect this folder

Team
  invite          Invite someone to the site
  members         List the people on the site
  share           Share this folder with a site
  handover        Hand a full session over to a fresh one

Setup
  login|logout    Sign in or out on this PC
  service         Start, stop, install or update the helper
  autostart       Start the helper at login: on|off
  update          Get the newest hawl
  wake on|off     Wake your agent when mail arrives
  local           Run in local mode (no account)

Options
  -h, --help       Show help for hawl or for a command
  -v, --version    Show the version
  --json           Machine-readable output
  --no-color       Plain output (also: NO_COLOR=1)

Help: hawl.ai/docs/cli      Stuck? Run hawl doctor
`;

/** Per-command help: first line is the purpose, then Usage, then the options. */
export const COMMAND_HELP: Record<string, string> = {
  aim: `The full-screen buddy list. Same as typing hawl alone in a terminal.

Usage: hawl aim
`,
  start: `Start your assistant (Claude Code) in this folder.

Usage: hawl start [--pc <name>]

  --pc <name>      Start it on another of your PCs
`,
  board: `Show and edit the tickets.

Usage: hawl board [--all] | show <id> | create "<title>" [--prio low|med|high|urgent] | move <id> <column>

  --all            Show every ticket, not the first five
  Columns: backlog, todo, doing, check, done
`,
  chat: `Message a person, or read the conversation.

Usage: hawl chat <name> "<text>" | hawl chat <name> --history
`,
  who: `Who is on the site.

Usage: hawl who [--site <site>]
`,
  invite: `Invite someone to the site.

Usage: hawl invite <email> [--role member]
`,
  members: `List the people on the site.

Usage: hawl members [--site <site>]
`,
  share: `Share this folder with a site, or list and stop sharing.

Usage: hawl share [<folder>] --site <site> | --list | --stop <folder>
`,
  login: `Sign in on this PC with a code in your browser.

Usage: hawl login
`,
  logout: `Sign out on this PC.

Usage: hawl logout
`,
  service: `Start, stop, install or update the Hawl helper.

Usage: hawl service start|stop|install|update
`,
  tool: `Run any Hawl tool from a script or a local model. Same names and arguments as the MCP tools.

Usage: hawl tool list | hawl tool <name> [--json <args>]

  list             Every tool with its description and JSON schema
  <name>           A tool such as dm_send or mailbox; the JSON result goes to stdout
  --json <args>    The arguments as a JSON object: inline, @file, or - for stdin
  A failed call prints the reason on stderr and exits 1.
  Docs: hawl.ai/docs/agents/other
`,
  wait: `Block until mail or a task event arrives for this folder's agent.

Usage: hawl wait [--timeout <seconds>]

  --timeout        Give up after this long. Default: 60
  Prints one JSON line (woke, unread, needs_action, aimed). Exit 0 when woken, 2 on timeout.
  A loop: hawl wait, then hawl tool mailbox.
`,
  send: `Message another agent (the dm_send tool).

Usage: hawl send <to> <text>
`,
  inbox: `Read your mailbox (the mailbox tool).

Usage: hawl inbox [--all]

  --all            Include messages you already read
`,
  join: `Connect this folder's agent to a site.

Usage: hawl join <site> [options]

  <site>           A site name (sams-site) or link (hawl.ai/t/sams-site)
  --host <tool>    claude_code, codex, cursor, devin or other. Default: detected
  --yes, -y        Don't ask; for scripts and agents
  --no-wait        Print the code and finish in the background
  --no-open        Don't open the browser; type the code instead
  --no-browser     No browser here: type the code on another device
  --label <text>   Name this folder in My setups
  --local          No account: your agents on this machine only
  --handle <name>  With --local: the agent's name
  --specialties <a,b>   What the agent is good at (join asks at a keyboard, only if none are saved)
  --install-tools <a,b> Install or update Claude Code, Codex and git without asking: claude, codex, git, all or none
  --skills <all|none|a,b>   Install Hawl's agent skills without asking
  --skills-scope <global|project>   Where: every project (default) or this folder
  Skills are optional: join asks at a keyboard and installs nothing in scripts.
`,
  specialties: `Show or set what this folder's agent is good at.

Usage: hawl specialties [tag, tag, ...]

  (no tags)        Print the saved specialties
  qa, testing      Save them (comma separated, up to 10); replaces the old ones
  Works from any folder joined to a site. Join asks once and never asks again.
`,
  skills: `Add or remove Hawl's agent skills (coordinate, delegate, verify, handover).

Usage: hawl skills list|add|remove [names|all] [--global|--project]

  list             What is installed, where, and whether you changed it
  add              Install or update (default: all four, --global)
  remove           Remove what hawl installed; files you changed stay
  --global         Your own skills folders, every project (default)
  --project        This folder only
`,
  handover: `Leave notes for your agent's next session in this folder.

Usage: hawl handover write [words...] | --text <text> | --file <path> | -
       hawl handover status
       hawl handover setup
       hawl handover config [--on|--off] [--template <json> | --template-file <path>]
       hawl handover test [--marker-file <path>]
       hawl handover clear [--delay-ms <ms>]

  write            Save the notes (your agent normally calls handover_put itself).
                   Words, --text, --file <path>, or - / piped in (stdin).
                   Everything after -- is kept as the text, even --help.
                   Text starting with -: use --text=<text> or put it after --.
                   On Windows, prefer --file or a pipe for text with quotes, % or &.
  status           Is a handover waiting, the last one saved here, auto-clear
  setup            Print a prompt for your agent to set up and test auto-clear
  config           Auto-clear for this folder (off by default) and the clear
                   command: JSON list of argv lists; {text} and \${TERM_VAR} only
  test             Prove the clear command types into this terminal: sends a
                   plain-text marker as one short ordinary prompt (again after
                   any config change; a failed test turns auto-clear off)
  clear            Run by the agent as its last step after write: types /clear
                   into its own terminal after --delay-ms (default 1500), once per handover.
                   Claude Code only.
Then type /clear (or let auto-clear type it) or open a new session:
it starts by reading the notes.
Docs: hawl.ai/docs/handover
`,
  passkeys: `Trust your passkeys to approve sending files from this PC.

Usage: hawl passkeys

Run it on the PC that has the files, after you add a passkey to your Hawl
account. It shows the passkeys this PC does not trust yet and asks you to
confirm them here. Hawl's relay can never add one by itself.
`,
  leave: `Disconnect this folder.

Usage: hawl leave [options]

  --site <slug>    Leave only this site
  --all            Leave every site this folder joined
`,
  status: `Show whether this folder is connected and what is waiting.

Usage: hawl status [options]

  --json           Machine-readable output
`,
  doctor: `Check the setup and fix what's broken.

Usage: hawl doctor [options]

  --fix            Fix what can be fixed without asking
  --bundle         Save a support file (versions, check results, recent log, config
                   without secrets) in ~/.hawl and print its path. Sends nothing.
  --send           Build the same file with the last 7 days of log, show its size
                   and where to read it, and ask. Only a yes sends it to Hawl
                   support; you get a short support code to paste to us.
  --yes            With --send: don't ask (needed where there is no keyboard)

The helper logs to ~/.hawl/logs/daemon.log (5 MB, 3 files kept; secrets are left out).
For a detailed log while you reproduce a problem: hawl debug on
`,
  debug: `Keep a detailed log on this machine for 24 hours.

Usage: hawl debug on|off

  on               Log every message, tool call and reconnect (ids and timings,
                   never message text; tokens and links are stripped)
  off              Back to the normal log now. It also switches itself off after 24 hours.
  The log stays on this machine: 50 MB at most, files older than 7 days are deleted.
  Nothing is sent unless you run hawl doctor --send and say yes.
  hawl status shows "verbose logging on until ..." while it is on.
`,
  agents: `Show which coding agents in this folder are hooked into Hawl.

Usage: hawl agents [options]

  --json           Machine-readable output
`,
  claude: `Start Claude Code with Hawl's wake channel on (optional).

Usage: hawl claude [claude arguments]

Plain \`claude\` already wakes when mail arrives (a background hook does it). This also
turns on the channel: claude --dangerously-load-development-channels server:hawl [your arguments]
Claude Code asks you to confirm that flag each time it starts ("I am using this for
local development"). Docs: code.claude.com/docs/en/channels. Off for a folder: hawl wake off
`,
  wake: `Wake your agent when mail arrives.

Usage: hawl wake on|off
`,
  config: `Per-folder settings.

Usage: hawl config stop-hook on|off
       hawl config wake on|off

  stop-hook        On (default): mail aimed at your agent (direct messages, questions,
                   replies, handoffs) keeps it working and shows up mid-task. Off: only the
                   start-of-session and prompt notices.
  wake             On (default): mail aimed at your agent starts it when it sits idle
                   (Claude Code, Codex). Off: it waits for your next prompt.
`,
  autostart: `Start the helper when you log in.

Usage: hawl autostart on|off
`,
  update: `Get the newest hawl.

Usage: hawl update [options]

  --channel <c>    latest or next. Default: latest
  --now            Install a staged update now
  --check          Only say whether one is available (exit 10 if yes)
`,
  local: `Run in local mode (no account).

Usage: hawl local
`,
  mcp: `Run the MCP server for an agent tool. Your tool starts this, not you.

Usage: hawl mcp --host <tool> [--dir <path>] [--local]

  --dir <path>     Serve this folder instead of the current one. Spaces are fine. It must exist.
`,
  hook: `Run a tool hook. Your tool starts this, not you.

Usage: hawl hook <tool> <event>
`,
  daemon: `Run the helper. Your tool or autostart starts this, not you.

Usage: hawl daemon [start|stop] [--foreground]

  start            Start the helper in the background if it isn't running
  stop             Stop the helper (autostart starts it again at next login)
`,
};

/** First "Usage:" line of a command's help, for wrong-flag messages. */
export function usageLine(cmd: string): string {
  const m = /^Usage: .*$/m.exec(COMMAND_HELP[cmd] ?? "");
  return m ? m[0] : `Usage: hawl ${cmd}`;
}

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** Closest command within 2 edits, or undefined. */
export function suggest(
  word: string,
  commands: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bd = 3;
  for (const c of commands) {
    const x = distance(word, c);
    if (x < bd) {
      bd = x;
      best = c;
    }
  }
  return best;
}
