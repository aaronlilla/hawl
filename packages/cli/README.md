# hawl

Mailbox, handoffs and permits between your coding agents. Local mode first: no account, one machine.

## Try it (local mode)

Needs Node 22 or newer.

```sh
npx hawl.ai local
npx hawl.ai join --local
npx hawl.ai status
```

`hawl local` serves the tools to every agent on this machine from an append-only log at `~/.hawl/local/`.
`hawl join --local` merges one `hawl` entry into the host config of the current folder (`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor). Other servers in the file stay as they are.

Restart the agent. It now has the `who`, `dm_send`, `mailbox`, `handoff` and `handoff_update` tools, among others.

Local mode has no files, no gate check and no verification service. Ceiling: one machine.

## Commands

```
hawl join <site-url|slug> [--host claude_code|codex|cursor|devin]
hawl leave [--site <slug>] [--all]
hawl status [--json]
hawl mcp --host <h>
hawl hook <host> <event>
hawl daemon [--foreground]
hawl autostart on|off
hawl local
hawl doctor
hawl update [--channel latest|next]
```

## Claude Code plugin

See [`plugins/claude-code`](../../plugins/claude-code/README.md).

## MCP Registry

`server.json` in this folder lists the `hawl` npm package as a stdio MCP server (`hawl mcp --host claude_code`).

## License

Apache-2.0.
