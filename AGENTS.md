# Agent Guidelines

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does -- the bridge writes there too, and CC re-serializes imported records under synthetic ids. Split by provenance (CC-live: real `requestId`/`promptId`; ours: `msg_syn_*`/`req_syn_*`) and regroup by `message.id` (`diag/audit-transcripts.mjs` does both).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins undocumented behavior against the installed CC/SDK; `diag/capture-proxy.mjs` captures request bodies. `claude-code-rip/` is mechanism only, never current behavior. Before reverse-engineering an SDK option, grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` first.

Validate any *rate* from the debug log on a case whose answer you know. Bin by era before comparing groups -- a window straddling the onset credits whatever else changed.

Five wrong conclusions across two sessions came from skipping the above.

## Changelog

Maintain an entry in the `## UNRELEASED` section at the top of `CHANGELOG.md` for every significant change, using the existing format:

```
- **Tag: summary** — detail
```

Do not add changelog entries for docs-only changes. Combine multiple UNRELEASED entries about the same feature into one.

Tags: `Add`, `Fix`, `Refactor`, `Tests`, `Bump`, `Deprecate`, `Remove`.

## Release

No build step — the package ships `src` TypeScript as-is (see `files` in `package.json`). It is published to npm as `@viniciosrab/pi-claude-bridge` by `.github/workflows/release.yml` (npm trusted publishing), never from a local machine. To cut version `X.Y.Z`:

1. **Changelog** — rename the `## UNRELEASED` section to `## X.Y.Z — YYYY-MM-DD`.
2. **Bump** — `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and `package-lock.json`).
3. **Commit** — `git commit -m "Release X.Y.Z"` (changelog, package.json and package-lock.json only).
4. **Tag** — `git tag -a vX.Y.Z -m "X.Y.Z"` (annotated, so `--follow-tags` pushes it; note the `v` prefix).
5. **Push commit and tag together** — `git push --follow-tags`. The tag starts the Release workflow, which checks that the tag matches `package.json`, runs the unit tests and publishes with the `latest` dist-tag.

## Tests

Smoke tests typically need to run outside a sandbox because they access local pi/Claude settings and auth state.
