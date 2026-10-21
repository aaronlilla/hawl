/** Help text for `hawl` and each command (S-424, T11). Plain text; main.ts adds weight. */

export const TOP_HELP = `Connect your AI agents to a shared site.

Usage: hawl <command> [options]

Everyday
  join <site>      Connect this folder's agent to a site
  status           Is this folder connected? Anything waiting?
  doctor           Check the setup and fix what's broken
  agents           Which agents here are hooked into Hawl?
  leave            Disconnect this folder
  skills           Add or remove Hawl's agent skills (optional)

Setup
  autostart on|off Start the helper when you log in
  update           Get the newest hawl
  claude           Start Claude Code with the wake channel (optional)
  wake on|off      Wake your agent when mail arrives
  local            Run in local mode (no account)

Options
  -h, --help       Show help for hawl or for a command
  -v, --version    Show the version
  --no-color       Plain output (also: NO_COLOR=1)

Help: hawl.ai/docs/cli      Stuck? Run hawl doctor
`;

/** Per-command help: first line is the purpose, then Usage, then the options. */
export const COMMAND_HELP: Record<string, string> = {
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
  --skills <all|none|a,b>   Install Hawl's agent skills without asking
  --skills-scope <global|project>   Where: every project (default) or this folder
  Skills are optional: join asks at a keyboard and installs nothing in scripts.
`,
  skills: `Add or remove Hawl's agent skills (coordinate, delegate, verify, handover).

Usage: hawl skills list|add|remove [names|all] [--global|--project]

  list             What is installed, where, and whether you changed it
  add              Install or update (default: all four, --global)
  remove           Remove what hawl installed; files you changed stay
  --global         Your own skills folders, every project (default)
  --project        This folder only
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

Usage: hawl mcp --host <tool> [--local]
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
