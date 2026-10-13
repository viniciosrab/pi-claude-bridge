# pi-claude-bridge (mirror)

[![npm version](https://img.shields.io/npm/v/@viniciosrab/pi-claude-bridge)](https://www.npmjs.com/package/@viniciosrab/pi-claude-bridge)

> **This is an automated mirror of [pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) by [Eli Dickinson](https://github.com/elidickinson)**, published as [`@viniciosrab/pi-claude-bridge`](https://www.npmjs.com/package/@viniciosrab/pi-claude-bridge). Every upstream release is rebuilt with the fork-only additions below and published under the same version number; fork-only changes ship as `X.Y.(Z+1)-fork.N`. See [docs/mirror.md](../docs/mirror.md).

The full documentation is upstream's [README.md](../README.md), kept identical to upstream so merging it never conflicts. This page is shown instead on GitHub because it lives in `.github/`.

## Install

```
pi install npm:@viniciosrab/pi-claude-bridge
```

## Fork-only options

Set under `provider` in `~/.pi/agent/claude-bridge.json` (global) or the project Pi config, next to upstream's options:

- `loadClaudeSettings` — load Claude Code's user/project/local settings in the provider's Claude Code subprocess (default `true`). Set `false` to skip them: settings-sourced hooks and plugins no longer run on every turn, which can noticeably cut tokens and latency when you have many configured. It also drops settings-sourced `env` and `apiKeyHelper`, so keep the default if you rely on those (e.g. Bedrock/Vertex setup in `settings.json`). OAuth login, pi tools and extensions are unaffected. Applies only to the provider path; AskClaude always loads settings.
- `rateLimitWarnings` — show Claude rate-limit notices in pi (default `true`): the usage warning at each 5% step and the notice with the reset time when a request is rejected. Set `false` to hide both. A rejected request's failure is still named as a rate limit (so fallback chains keep working).

The fork also lifts Claude Code's 2,048-character MCP tool description cap (`CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH`), which cut codemode's nested-tool listing and hid codemode-exposed MCP servers from Claude ([issue #4](https://github.com/viniciosrab/pi-claude-bridge/issues/4)).

All fork code lives in [`src/fork.ts`](../src/fork.ts); `src/index.ts` only carries one-line hooks into it.

## Credits

pi-claude-bridge was created by [Eli Dickinson](https://github.com/elidickinson); the original project lives at [elidickinson/pi-claude-bridge](https://github.com/elidickinson/pi-claude-bridge) and on npm as [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge). It was originally based on [claude-agent-sdk-pi](https://github.com/prateekmedia/claude-agent-sdk-pi) by Prateek Sunal.

This repository is maintained by [viniciosrab](https://github.com/viniciosrab). `provider.loadClaudeSettings` was proposed upstream in [issue #141](https://github.com/elidickinson/pi-claude-bridge/issues/141). Licensed under MIT; the original copyright is kept in [LICENSE](../LICENSE).
