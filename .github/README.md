# pi-claude-bridge

[![npm version](https://img.shields.io/npm/v/@viniciosrab/pi-claude-bridge)](https://www.npmjs.com/package/@viniciosrab/pi-claude-bridge)

Use Claude (Fable, Opus, Sonnet, Haiku) as a model in [pi](https://github.com/earendil-works/pi), through your Claude Code subscription. Every tool call runs in pi's TUI, as with any other model.

> Automated mirror of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by Eli Dickinson, with a few [fork-only options](#fork-only-options). Versions match upstream; `X.Y.(Z+1)-fork.N` is upstream `X.Y.Z` plus newer fork changes.

<p>
<a href="https://github.com/viniciosrab/pi-claude-bridge/blob/main/assets/claude-bridge1.png"><img src="https://raw.githubusercontent.com/viniciosrab/pi-claude-bridge/main/assets/claude-bridge1.png" width="49%"></a>&nbsp;
<a href="https://github.com/viniciosrab/pi-claude-bridge/blob/main/assets/claude-bridge2.png"><img src="https://raw.githubusercontent.com/viniciosrab/pi-claude-bridge/main/assets/claude-bridge2.png" width="49%"></a>
</p>

## Install

```
pi install npm:@viniciosrab/pi-claude-bridge
```

Requires pi 0.86.1 or newer and a Claude Code login. Usage counts against your Claude plan, the same as Claude Code.

## Use

Pick a model with `/model`, e.g. `claude-bridge/claude-opus-5` or `claude-bridge/claude-haiku-4-5`. New Claude models appear on their own after `pi update`.

Skills, AGENTS.md/CLAUDE.md and steering work as usual.

## Configure

Optional. Global: `~/.pi/agent/claude-bridge.json`. Per project: `.pi/claude-bridge.json`, merged over the global file.

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

Fable 5/5.1, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5 and Haiku 5.5 get 1M context on every plan. Newer models start at 200K until the bridge adds them. Fable is not included in Pro without Extra Usage.

### Fork-only options

Also under `provider`:

| Option | Default | What it does |
|---|---|---|
| `loadClaudeSettings` | `true` | Set `false` to skip Claude Code's `settings.json` hooks and plugins on each turn. That cuts tokens and latency, but it also drops `env` and `apiKeyHelper` from those settings. |
| `rateLimitWarnings` | `true` | Set `false` to hide the rate-limit warnings and reset-time notices. |

The fork also removes Claude Code's 2,048-character cap on MCP tool descriptions, which hid codemode's MCP servers from Claude.

## Troubleshooting

- **Every turn fails with an auth error.** Unset any `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` you export: they redirect Claude Code away from your subscription.
- **A turn is refused because of the system prompt.** Usually another extension changed or replaced pi's system prompt: fix or disable it. If the error points at your own text, reword it.
- **Updated AGENTS.md or skills are ignored.** The prompt is captured at the start of a session. Start a new session.
- **A turn costs more after an abort, `/compact` or a branch switch.** The bridge resends the whole conversation, which usually misses the prompt cache. This is expected.
- **Claude Code hooks add duplicate guidance.** `~/.claude/settings.json` hooks also fire in bridge turns. Have the hook skip them: `[ -n "$PI_CODING_AGENT" ] && exit 0`.
- **Subagents with @gotgenes/pi-subagents.** Add `{"promptInheritance": {"claude-bridge": "portable"}}` to `~/.pi/agent/subagents.json`.

For bug reports, set `CLAUDE_BRIDGE_DEBUG=1` and attach `~/.pi/agent/claude-bridge.log` plus the matching file in `~/.pi/agent/cc-cli-logs/`.

Extension authors and contributors: see upstream's [full README](https://github.com/elidickinson/pi-claude-bridge#readme).

