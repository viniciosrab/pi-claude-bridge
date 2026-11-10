# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@viniciosrab/pi-claude-bridge)](https://www.npmjs.com/package/@viniciosrab/pi-claude-bridge)

Use Claude (Fable, Opus, Sonnet, Haiku) as a model in [pi](https://github.com/earendil-works/pi), through your Claude Code subscription. Every tool call runs in pi's TUI, as with any other model.

What it does for you:

- **Your Claude plan, pi's tools.** Claude Code does the talking to Anthropic; pi runs every tool, skill and extension as usual.
- **The prompt cache survives the usual interruptions.** An abort, an API error, `/fork`, `/clone`, or reopening a session in a new window continue Claude Code's own session instead of re-sending the whole conversation.
- **Turns that don't hang.** A tool call lost between Claude Code and pi, or parallel calls after a non-streaming fallback, end the turn with a clear error instead of leaving it on "Working".
- **Full tool descriptions.** Claude Code cuts each MCP tool description at 2,048 characters; the bridge lifts that limit, so long descriptions such as codemode's list of MCP servers reach Claude whole.
- **New models without a bridge release.** Claude models pi knows about appear in `/model` after `pi update`.

## Install

```
pi install npm:@viniciosrab/pi-claude-bridge
```

Requires pi 0.86.1 or newer and a Claude Code login. Usage counts against your Claude plan, the same as Claude Code.

## Use

Pick a model with `/model`, e.g. `claude-bridge/claude-opus-5` or `claude-bridge/claude-haiku-4-5`. New Claude models appear on their own after `pi update`.

Skills, AGENTS.md/CLAUDE.md and steering work as usual.

## Configure

Optional. Global: `~/.pi/agent/claude-bridge.json`. Per project: `.pi/claude-bridge.json`, merged over the global file, except `provider`: its options are read from the global file only, so a cloned repository cannot change them.

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
| `loadClaudeSettings` | `"user"` | Which Claude Code settings (hooks, plugins, `env`, `apiKeyHelper`) apply on each turn. `"user"` loads `~/.claude/settings.json` only. `"all"` also loads the repository's `.claude/settings.json` and `.claude/settings.local.json`: use it only in repositories you trust. `false` loads none, which cuts tokens and latency. |
| `rateLimitWarnings` | `true` | Set `false` to hide the rate-limit warnings and reset-time notices. |

Context window: Fable 5/5.1/5.2, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5 and Haiku 5.5 always run with 1M context. Opus 4.6 gets 1M with `plan: "max"` or `longContextExtraUsage`, and Sonnet 4.6 only with `longContextExtraUsage`. Any other model runs at 200K until its 1M context is measured and added to the bridge.

Plan access is separate: on Pro, Fable 5 and 5.1 need Extra Usage (Fable 5.2 answered without it when measured on 2026-11-09).

## Troubleshooting

- **Every turn fails with an auth error.** Unset any `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` you export: they redirect Claude Code away from your subscription.
- **A turn is refused because of the system prompt.** Usually another extension changed or replaced pi's system prompt: fix or disable it. If the error points at your own text, reword it.
- **Updated AGENTS.md or skills are ignored.** The prompt is captured at the start of a session. Start a new session.
- **A turn costs more after `/compact` or a branch switch.** pi's history no longer matches Claude Code's session, so the bridge rebuilds it and the next request misses the prompt cache. This is expected. An abort, an API error, `/fork`, `/clone` and reopening a session (`pi --continue`, `/resume`, a new window) keep the cache.
- **Claude Code hooks add duplicate guidance.** `~/.claude/settings.json` hooks also fire in bridge turns. Have the hook skip them: `[ -n "$PI_CODING_AGENT" ] && exit 0`.
- **Subagents with @gotgenes/pi-subagents.** Add `{"promptInheritance": {"claude-bridge": "portable"}}` to `~/.pi/agent/subagents.json`.

For bug reports, set `CLAUDE_BRIDGE_DEBUG=1` and attach `~/.pi/agent/claude-bridge.log` plus the matching file in `~/.pi/agent/cc-cli-logs/` to a [new issue](https://github.com/viniciosrab/pi-claude-bridge/issues/new).

Extension authors and contributors: see the [reference](docs/reference.md).

## Credits

This project started from [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson, itself based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal. It has been developed on its own since 0.9.4-fork.13. Thank you both.
