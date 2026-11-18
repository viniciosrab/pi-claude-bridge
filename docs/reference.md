# pi-claude-bridge reference

Details for extension authors and contributors. For installing and configuring the bridge, see the [README](../README.md).

## Provider

Use `/model` to select any Claude model in pi-ai's catalog, e.g. `claude-bridge/claude-fable-5-2`, `claude-bridge/claude-opus-5-5`, or `claude-bridge/claude-haiku-5-5`.

Behind the scenes, pi's tools are bridged to Claude Code but everything works like normal in pi. Bash commands get Claude Code's 120-second default timeout since pi's bash has none, and the bash schema Claude reads says so. pi's whole system prompt — tools, rules, context files, skills and extensions' sections, as pi renders it — reaches Claude after Claude Code's own `claude_code` preset (or alone, with `provider.systemPromptPreset: false`), and steering mid-turn reaches Claude at the next tool boundary. Claude Code cuts each MCP tool description at 2,048 characters; the bridge lifts that limit, so long descriptions reach Claude whole. A tool call lost between Claude Code and pi ends the turn with an error naming the tool instead of leaving it on "Working".

The model list comes from pi-ai's Anthropic catalog automatically — when pi-ai adds a new Claude model, it appears in `/model` after updating the package, no bridge update needed. Dated snapshot ids (e.g. `claude-opus-4-5-20251101`) are not shown.

Claude Mythos 5.2 and 5.1 are listed too (at the bottom), though pi-ai leaves them out; each copies the limits of its Fable sibling. Anthropic serves Mythos only to approved programs, so on accounts without access requests fail with a 404 "There's an issue with the selected model".

**1M Context:** Fable 5/5.1/5.2, Opus 5.5/5/4.8/4.7, Sonnet 5.5/5 and Haiku 5.5 get 1M context. Opus 4.6 gets 1M only on a Max plan or with Extra Usage, and Sonnet 4.6 only with Extra Usage — set `provider.plan` and/or `provider.longContextExtraUsage` as described in [Configuration](#configuration).

## Configuration

Config: `~/.pi/agent/claude-bridge.json` (global). `provider` in a project's `.pi/claude-bridge.json` is ignored, so a cloned repository cannot change them. Set `CLAUDE_BRIDGE_CONFIG` to a file path to use that file as the global config instead.

```json
{
  "provider": {
    "plan": "max",
    "longContextExtraUsage": false,
    "strictMcpConfig": true,
    "pathToClaudeCodeExecutable": "/home/you/.nix-profile/bin/claude"
  }
}
```

`provider`:
- `plan` (default `"pro"`) — set to `"max"` if you have a Max (or Team Premium/Enterprise) Anthropic plan. This enables Opus 4.6 with 1M context; newer Opus models get 1M on every plan.
- `longContextExtraUsage` — set to `true` to enable 1M context models even if they cost money through Extra Usage on your plan. It enables Sonnet 4.6 with 1M on every plan and Opus 4.6 with 1M on Pro. Not needed for Opus 4.7 or 4.8.
- `forceTwoHundredK` — array of model ids to pin to 200K context (bare id, no `[1m]` suffix). Use if pi-ai declares a model at 1M but Claude Code won't serve it on your plan.
- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json` (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `autoMemoryEnabled` — enable Claude Code's auto-memory system (default `false`)
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful if your OS/filesystem has the SDK's bundled musl/glibc binaries in a place where they can't run. For example, with Nix you can set the binary to e.g. `"/home/you/.nix-profile/bin/claude"`.
- `loadClaudeSettings` — which Claude Code settings (hooks, plugins, `env`, `apiKeyHelper`) apply on each turn. `"user"` (default) loads `~/.claude/settings.json` only; `"all"` (or `true`) also loads the repository's `.claude/settings.json` and `.claude/settings.local.json`, for repositories you trust; `false` loads none.
- `rateLimitWarnings` — set `false` to hide the rate-limit warnings and reset-time notices (default `true`).
- `systemPromptPreset` — `true` (default) sends Claude Code's own `claude_code` preset first, with pi's whole system prompt as its append; `false` sends pi's prompt alone as the whole system prompt. Upstream's spellings work too (`"claude_code"` means on, `null` off); any other value is reported once and ignored. Changing the setting rebuilds the session at the next prompt, as a system prompt change does. Compaction and branch summaries always send pi's summarization prompt alone.


**Leftover keys:** the bridge never writes to its config. A `startupNoticeShown` mark left by older versions, and the `askClaude` section and `askClaudeDeprecationShown` left by the removed AskClaude tool, are ignored.

**Extension providers and models.json:** pi's `modelOverrides` in `~/.pi/agent/models.json` do not currently apply to extension-registered providers (like claude-bridge). Overriding `contextWindow` or other fields requires editing `src/models.ts` directly — to pin a model to 200K, use `provider.forceTwoHundredK` instead.

## Tests

`npm run test:unit` for offline tests. `npm test` adds integration tests that hit APIs; set `CLAUDE_BRIDGE_TESTING_ALT_PROVIDER` and `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the alt-provider tests (session resume, image session).

Integration tests spawn real `pi` and Claude Code subprocesses and need write access to `~/.claude` — a sandbox that blocks it makes `--resume` fail with `No conversation found with session ID`.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to enable debug output:

- **Bridge log** at `claude-bridge.log` in pi's agent dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`) — provider calls, session sync decisions, tool results, CC stderr. Override location with `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `cc-cli-logs/<timestamp>-<tag>-<seq>.log` in the same directory — the subprocess's own debug stream; tag is `provider` or `compact-summary`. Shows CC's view of session loading, API requests, and tool calls.

When filing a bug about a session-resume failure (e.g. "No conversation found"), the most useful attachments are the `syncResult:` lines from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Compatibility with other extensions

### System prompt and message injection

The bridge forwards pi's system prompt and messages whole, as pi renders them, so any injection route pi honors reaches Claude Code: `before_agent_start` (`message`, `systemPrompt`, `systemPromptOptions.sections`), `context` and `context_with_system` edits, `--system-prompt` and `--append-system-prompt` alike. A prompt that replaces pi's is forwarded as it is; nothing is matched or refused. The system prompt follows Claude Code's own `claude_code` preset unless `provider.systemPromptPreset` is `false`.

Claude Code itself loads no `CLAUDE.md`, `AGENTS.md` or `.claude/rules/` on the provider path: pi's context files are already in pi's prompt.

### Hooks written for Claude Code

`~/.claude/settings.json` hooks fire inside bridge turns, so a hook injecting Claude-specific guidance duplicates what pi's extensions already provide. pi sets `PI_CODING_AGENT=true` for child processes, including the Claude Code child; a hook can skip itself on that:

```sh
[ -n "$PI_CODING_AGENT" ] && exit 0
```

Hooks do not fire on isolated summary queries.

### Compaction and branch summaries

pi runs compaction and branch summaries natively. The bridge routes their `cacheRetention: "none"` calls to isolated Claude Code queries, leaving the live session untouched until pi completes the history rewrite. Other extensions can provide summaries through pi's hooks.

### pi's harness in the system prompt

The bridge forwards pi's whole prompt, pi's own wording and the two documentation paths `docs/custom-provider.md` and `docs/packages.md` included, and so does a subagent that embeds its parent's whole prompt. Up to pi 1.4, Anthropic billed a request carrying pi's harness as Extra Usage (or failed it with a 400 "out of extra usage"); the wording pi renders since 1.5.1 is served on the plan, so the bridge requires pi 1.5.1 or newer. Upstream measured pi's own prompt (elidickinson/pi-claude-bridge `diag/EXTRA-USAGE-400.md` and `diag/third-party-gate/`); this fork's `diag/EXTRA-USAGE-400.md` ("A real pi setup's whole prompt") adds a 104,653-character prompt from a pi 1.5.2 setup with other extensions loaded, served on the plan with Extra Usage off, both after the preset and alone.

If Claude Code reports a request billed to Extra Usage while no plan limit was reached, the bridge shows a warning once per query, unless that model's 1M context runs on Extra Usage because you set `longContextExtraUsage`. An "out of extra usage" failure with no plan limit reached gets the same explanation appended.

### Plan usage for footers and quota extensions

The bridge does not show plan usage itself. Claude Code sends a `rate_limit_event` when a usage window changes, and the bridge passes it to pi's `after_provider_response` event as `anthropic-ratelimit-unified-*` headers. Events are not tied to one response: one that arrives after a turn has ended on a tool call is reported on the next provider call, and only the latest is kept. The headers use the names that the Anthropic API uses (for example `anthropic-ratelimit-unified-5h-utilization`). The bridge sends only the headers that it can make from the event: the status, the reset time, the representative claim, the overage status and reset, and the utilization and reset of each window. The status code is always 200. An extension that reads these headers for the built-in `anthropic` provider can also accept `claude-bridge` without other changes.

## Known issues

**A session rebuild re-sends the whole conversation.** The bridge rewrites Claude Code's session from pi's history whenever pi rewrites that history — `/compact`, tree navigation, or an extension that edits past messages — or pi's system prompt changes, and the next request usually misses the prompt cache for everything past the system prompt. An abort, an API error, `/fork`, `/clone` and reopening a session resume Claude Code's own session file instead, and keep the cache, unless the system prompt changed meanwhile (see `CHANGELOG.md`).

**Files Claude Code edits are not carried across a rebuild.** The edit itself survives in the history as a tool call and result — what's lost is the post-edit file snapshot. `@file` expansions *are* carried.

**A system prompt change rebuilds the session, and waits for the next prompt.** Claude Code records the prompt a session was created with and re-sends it on every resume, ignoring the one the bridge passes (`tests/int-cc-contracts.mjs`). So the bridge keeps a digest of the prompt it sends (the `systemPromptPreset` setting plus pi's whole prompt) with the session's mirror in `claude-bridge-mirrors/`, and when the next prompt's digest differs (a tool turned on, an extension's section, a changed `systemPromptPreset`) it rebuilds Claude Code's session from pi's history instead of resuming it, after an abort, an API error, a `/reload` or in a new window too; a `/fork` rebuilds instead of forking a parent made with another prompt. That request re-caches the whole conversation once, as a changed system prompt does on any provider. A change pi makes while a turn runs, between tool calls, reaches Claude at the next prompt: the running Claude Code query keeps the prompt it started with.

**Exported Anthropic environment variables override the Claude Code child (issue #107).** An exported `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, or `ANTHROPIC_AUTH_TOKEN` redirects Claude Code to that gateway and every turn fails with its auth error. Unset them for the pi process.
