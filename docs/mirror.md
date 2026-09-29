# npm mirror: `@viniciosrab/pi-claude-bridge`

This fork publishes [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge) (by Eli Dickinson, MIT) as `@viniciosrab/pi-claude-bridge`, with one addition: the `provider.loadClaudeSettings` option ([upstream PR #142](https://github.com/elidickinson/pi-claude-bridge/pull/142)). Versions match upstream exactly.

## How it works

The workflow [`.github/workflows/mirror-release.yml`](../.github/workflows/mirror-release.yml) runs every 6 hours and on demand. It calls [`scripts/mirror-release.sh`](../scripts/mirror-release.sh) twice:

1. **Release**
   - Reads the latest upstream version and its `gitHead` from npm (upstream does not use GitHub Releases, so npm is the source of truth).
   - Stops if `@viniciosrab/pi-claude-bridge@<version>` already exists.
   - In a temporary worktree at `gitHead`, cherry-picks the fix commits from the `patches` branch. Commits upstream already contains become empty and are dropped.
   - Applies the fork identity at build time only: package name, repository/homepage/bugs URLs, a fork note in the README and the npm badge. None of this is committed.
   - Runs `npm ci`, `npm run test:unit` and `npm run typecheck`.
   - Publishes with `npm publish --provenance --access public` through npm Trusted Publishing (OIDC, no token).
   - Force-pushes the rebuilt fix commits to `patches` and tags them `mirror-v<version>`.
2. **Sync main** (`--sync-main`): merges `upstream/main` into `main` with a merge commit and pushes. It never rebases, and it refuses if the merge would change `.github/workflows/` (the workflow token cannot push those).

Branches:

- `patches`: only the fix commits, on top of the upstream release they were last built on. No CI files.
- `main`: upstream `main` + the fix + this workflow and script.

## One-time setup

1. First publish (npm needs the package to exist before a Trusted Publisher can be attached). From a clean checkout, logged in with `npm login`:

   ```sh
   NPM_PUBLISH_ARGS='--access public' scripts/mirror-release.sh
   ```

   This also pushes `patches` and the `mirror-v<version>` tag to `origin`.
2. On npmjs.com, package settings -> Trusted Publisher -> GitHub Actions:
   - Organization or user: `viniciosrab`
   - Repository: `pi-claude-bridge`
   - Workflow filename: `mirror-release.yml`
   - Environment: leave blank
3. Enable Actions on the fork (forks start with Actions disabled) and make sure scheduled workflows are enabled.

## Running it by hand

- Dry run locally: `scripts/mirror-release.sh --dry-run [--version X]` builds and tests in a temporary worktree and runs `npm publish --dry-run`. Your checkout is not touched.
- In GitHub: Actions -> Mirror release -> Run workflow, with an optional `version` and `dry_run`.

## When it fails

A failure publishes nothing and opens (or comments on) the issue **Mirror release failed** with the summary and a link to the run.

- **Cherry-pick conflicted**: upstream changed the code our fix touches. Rebase the fix onto the new release:

  ```sh
  git fetch upstream
  git switch patches
  git rebase --onto <gitHead> "$(git merge-base patches <gitHead>)" patches   # resolve conflicts
  npm ci && npm run test:unit && npm run typecheck
  git push --force-with-lease origin patches
  ```

  Then re-run the workflow. `<gitHead>` is in the issue (or `npm view pi-claude-bridge gitHead`).
- **Tests or typecheck failed**: reproduce with `scripts/mirror-release.sh --dry-run --version <version>`, fix on `patches`, push, re-run.
- **Merge of upstream/main conflicted or touches workflows**: merge `upstream/main` into `main` locally, resolve, push.
- **Published, but pushing `patches` or the tag failed**: the package is out; push `patches` and the `mirror-v<version>` tag by hand so the next release starts from the right commits.

Close the issue once a run succeeds.
