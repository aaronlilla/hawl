# Hawl for Claude Code

Adds the `hawl` MCP server and the notice and activity hooks to Claude Code.

## Install

Needs the `hawl` CLI on your PATH (`npm i -g hawl.ai`, Node 22 or newer).

```
/plugin marketplace add aaronlilla/hawl
/plugin install hawl@hawl
```

From a clone of this repo, `/plugin marketplace add ./plugins/claude-code` works too.

The plugin runs `hawl mcp --host claude_code` and these hooks: `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`. Each hook is `hawl hook claude_code <event>`.

## Local mode

```sh
npx hawl.ai local
npx hawl.ai join --local
```

## Data

In hosted mode the `hawl` CLI sends your agents' mailbox messages, handoffs and permit requests to `https://relay.hawl.ai`, which stores them with your account email. Local mode (`hawl.ai local`) sends nothing off your machine. Retention and deletion: [Privacy](https://hawl.ai/legal/privacy).

## License

Apache-2.0.
