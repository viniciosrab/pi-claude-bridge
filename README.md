# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@viniciosrab/pi-claude-bridge)](https://www.npmjs.com/package/@viniciosrab/pi-claude-bridge)

Use Claude (Fable, Opus, Sonnet, Haiku) as a model in [pi](https://github.com/earendil-works/pi), through your Claude Code subscription. Every tool call runs in pi's TUI, as with any other model.

What it does for you:

- **Your Claude plan, pi's tools.** Claude Code does the talking to Anthropic; pi runs every tool, skill and extension as usual.
- **The prompt cache survives the usual interruptions.** An abort, an API error, `/fork`, `/clone`, or reopening a session in a new window usually continue Claude Code's own session instead of re-sending the whole conversation.
- **New models without a bridge release.** Claude models pi knows about appear in `/model` after `pi update`, at 200K context until a bridge release adds their 1M.

## Install

```
pi install npm:@viniciosrab/pi-claude-bridge
```

Requires pi 0.86.1 or newer and a Claude Code login: install [Claude Code](https://code.claude.com/docs/en/quickstart), run `claude` and sign in with your Claude subscription when it asks (`/login` signs in again later). The bridge uses that login, so there is no API key to set.

## Use

Pick a model with `/model`, e.g. `claude-bridge/claude-opus-5-5` or `claude-bridge/claude-haiku-5-5`. New Claude models appear on their own after `pi update`.

Skills, AGENTS.md/CLAUDE.md and steering work as usual. pi supplies the instructions, so Claude Code's own `~/.claude/CLAUDE.md`, `.claude/rules/` and output style do not apply.

## What to expect

- **Usage counts against your Claude plan**, the same as Claude Code.
- **pi runs the tools, not Claude Code.** Claude Code's own tools are not used, nor, by default, the MCP servers from `~/.claude.json` and `.mcp.json` (see `strictMcpConfig`); claude.ai's cloud MCP servers are always off. Claude sees pi's tools, skills and extensions.
- **`/compact`, tree navigation or an extension that edits past messages makes the next turn cost more.** pi's history no longer matches Claude Code's session, so the bridge rebuilds it and the next request misses the prompt cache.
- **AGENTS.md and skills are read at the start of a session.** A change takes effect in a new session, or after a rebuild such as `/compact`.

## Configure

Optional. Global: `~/.pi/agent/claude-bridge.json`, or the file the `CLAUDE_BRIDGE_CONFIG` environment variable names. A `.pi/claude-bridge.json` inside a project is ignored, so a cloned repository cannot change these options.

```json
{
  "provider": {
    "plan": "max"
  }
}
```

| `provider` option | Default | What it does |
|---|---|---|
| `plan` | `"pro"` | Set to `"max"` on Max, Team Premium or Enterprise to unlock 1M context on Opus 4.6. |
| `longContextExtraUsage` | `false` | Allow 1M-context models that bill Extra Usage (Sonnet 4.6; Opus 4.6 on Pro). |
| `forceTwoHundredK` | `[]` | Model ids to cap at 200K, if Claude Code refuses 1M for them on your plan. |
| `strictMcpConfig` | `true` | Ignore MCP servers from `~/.claude.json` and `.mcp.json`. |
| `autoMemoryEnabled` | `false` | Turn on Claude Code's auto-memory. |
| `pathToClaudeCodeExecutable` | bundled | Path to your own `claude` binary (e.g. on Nix). |
| `loadClaudeSettings` | `"user"` | Claude Code settings (hooks, plugins, `env`, `apiKeyHelper`) to load: `"user"` for `~/.claude/settings.json` only, `"all"` to add the repository's `.claude/` settings (trusted repositories only), `false` for none. |
| `rateLimitWarnings` | `true` | Set `false` to hide the rate-limit warnings and reset-time notices. |

Context window: the current models (Fable 5 and newer, Opus 4.7 and newer, Sonnet 5 and newer, Haiku 5.5) run with 1M context. Opus 4.6 gets 1M with `plan: "max"` or `longContextExtraUsage`, and Sonnet 4.6 only with `longContextExtraUsage`. A model released after your bridge version runs at 200K until a bridge release adds its 1M context.

Plan access is separate: on Pro, Fable 5 needs Extra Usage (5.1 is assumed the same, not measured); Fable 5.2 answered without it when last measured (2026-11-09).

## Troubleshooting

- **Every turn fails with an auth error.** Unset any `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` you export: they redirect Claude Code away from your subscription.
- **A turn is refused because of the system prompt.** Usually another extension changed or replaced pi's system prompt: fix or disable it. If the error points at your own text, reword it.
- **Claude Code hooks add duplicate guidance.** `~/.claude/settings.json` hooks also fire in bridge turns. Have the hook skip them: `[ -n "$PI_CODING_AGENT" ] && exit 0`.
- **Subagents with @gotgenes/pi-subagents.** Add `{"promptInheritance": {"claude-bridge": "portable"}}` to `~/.pi/agent/subagents.json`. nicobailon/pi-subagents needs no setup.

For bug reports, set `CLAUDE_BRIDGE_DEBUG=1` and attach `claude-bridge.log` plus the matching file in `cc-cli-logs/`, both in pi's agent dir (`~/.pi/agent` by default), to a [new issue](https://github.com/viniciosrab/pi-claude-bridge/issues/new).

Extension authors and contributors: see the [reference](docs/reference.md).

## Credits

This project started from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson, itself based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. It has been developed on its own since 1.0.0. Thank you both.
