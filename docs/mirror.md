# npm mirror: `@viniciosrab/pi-claude-bridge`

This fork publishes [`pi-claude-bridge`](https://www.npmjs.com/package/pi-claude-bridge) (by Eli Dickinson, MIT) as `@viniciosrab/pi-claude-bridge`, with one addition: the `provider.loadClaudeSettings` option ([upstream PR #142](https://github.com/elidickinson/pi-claude-bridge/pull/142)). Versions match upstream exactly.

## How it works

The workflow [`.github/workflows/mirror-release.yml`](../.github/workflows/mirror-release.yml) runs every 6 hours and on demand. Each job calls [`scripts/mirror-release.sh`](../scripts/mirror-release.sh). The jobs are split by privilege, so the code that runs upstream's scripts never holds a write token.

| Job | Permissions | Runs upstream code | What it does |
| --- | --- | --- | --- |
| `build` | `contents: read`, token not persisted | yes | `build`: picks the versions to mirror, cherry-picks the fix, applies the fork identity, runs `npm ci`, `test:unit`, `typecheck`, `npm pack`. Uploads the tarballs plus metadata. |
| `publish` | `contents: write`, `id-token: write` | no | `publish`: publishes the tarballs, then pushes `patches` and the tags. |
| `sync-main` | `contents: write` | no | `sync-main`: merges `upstream/main` into `main` and pushes. |
| `report-failure` | `issues: write` | no | Opens or updates the **Mirror release failed** issue. |

### Which versions are mirrored

- If the fork already has versions: every stable upstream version newer than the fork's `latest`, oldest first. The run stops at the first failure, so the issue names the blocked version. Versions built before the failure are still published.
- If the fork has no stable version yet (no versions, or prereleases only): only the upstream `latest`. History is not backfilled.
- With `--version X` (or the workflow's `version` input): only `X`.

Each version is read from npm along with its `gitHead`. Upstream does not use GitHub Releases, so npm is the source of truth.

### Build (per version)

1. Creates a temporary worktree at the version's `gitHead`.
2. Cherry-picks the fix commits: the commits on `patches` that upstream history does not contain. Commits upstream already has become empty and are dropped (`--empty=drop`). If a release is the one `patches` already sits on, those exact commits are reused. When several versions are built, each one builds on the fix commits rebuilt for the version before it.
3. Applies the fork identity at build time only: package name, repository/homepage/bugs URLs, a fork note in the README and the npm badge. None of this is committed.
4. Runs `npm ci`, `npm run test:unit`, `npm run typecheck` and `npm pack`.

The artifact holds these files:

| File | Contents |
| --- | --- |
| `*.tgz` | The packed tarballs. |
| `manifest.tsv` | One line per version: version, dist-tag, upstream `gitHead`, rebuilt fix commit, tarball name. |
| `patches-base.txt` | The fork's `patches` SHA as seen before the build. Empty if the branch does not exist. |
| `fixes.bundle` | A self-contained git bundle of the rebuilt fix commits. |

### Publish

The artifact comes from the unprivileged job, so `publish` validates all of it before using any of it. Any mismatch rejects the whole publish, with a summary. The checks, per version:

- **Version:** strict semver, not duplicated, and one of the upstream versions npm lists (re-read in this job).
- **Dist-tag:** `latest` or `backfill` for a stable version, `next` for a prerelease.
- **Tarball:** named `viniciosrab-pi-claude-bridge-<version>.tgz`, and a regular file inside the artifact directory. Its `package/package.json`, read with `tar`, must have the fork's name and this version. No package code runs.
- **Upstream `gitHead`:** must equal npm's `gitHead` for the version.
- **Fix commit:** a 40-hex SHA that is the bundle's `refs/mirror-build/<version>`, and a descendant of that `gitHead`.

Checks on the artifact as a whole:

- **`patches-base`:** a 40-hex SHA, or empty.
- **The bundle:** it must verify and may only carry `refs/mirror-build/*` refs. Only those refs are fetched from it.

Once validated:

- Each tarball goes out with `npm publish <tarball> --provenance --access public --tag <tag> --ignore-scripts`. npm runs no lifecycle scripts when publishing a tarball (it only runs them for directory publishes), and `--ignore-scripts` makes that explicit. Versions that are already published are skipped.
- Dist-tags:
  - `latest`: only for a stable version newer than the fork's current `latest`.
  - `backfill`: an older stable version.
  - `next`: a prerelease. Prereleases never get `latest`.
- Pushes the last published fix commit to `patches` with `--force-with-lease=refs/heads/patches:<patches-base>`. The lease is the SHA recorded before the build, so a concurrent change to `patches` rejects the push. When the branch did not exist yet, the empty lease requires it to still be absent.
- Pushes one tag per version, `mirror-v<version>`, pointing at that version's fix commits. Tags do not depend on `patches`, so they are pushed even when the lease rejects the `patches` push.
- If a publish, or the check for whether a version is already published, fails, it stops at that version. It still pushes `patches` and the tags for the versions already published, then fails with a summary.

### Sync main

Merges `upstream/main` into `main` with a merge commit, never a rebase. It refuses if the merge would change a path the mirror owns: `.github/`, `scripts/mirror-release.sh` or `docs/mirror.md`.

### Branches

- `patches`: only the fix commits, on top of the upstream release they were last built on. No CI files.
- `main`: upstream `main` + the fix + this workflow, script and doc.

## One-time setup

1. **First publish.** npm needs the package to exist before a Trusted Publisher can be attached. From a clean checkout with the `patches` branch, logged in with `npm login`, run:

   ```sh
   git remote add upstream https://github.com/elidickinson/pi-claude-bridge.git   # if missing
   NPM_PUBLISH_ARGS='--access public' scripts/mirror-release.sh
   ```

   The default `release` command runs `build` and then `publish` locally. `--provenance` is left out because provenance needs CI. The command also pushes `patches` and the `mirror-v<version>` tag to `origin`.
2. **Trusted Publisher.** On npmjs.com, open the package settings, then Trusted Publisher, then GitHub Actions:
   - Organization or user: `viniciosrab`
   - Repository: `pi-claude-bridge`
   - Workflow filename: `mirror-release.yml`
   - Environment: leave blank
3. **Actions.** Enable Actions on the fork (forks start with Actions disabled), and make sure scheduled workflows are enabled.

## Running it by hand

- **Dry run locally:** `scripts/mirror-release.sh --dry-run [--version X]`. It builds and tests in a temporary worktree, then runs `npm publish --dry-run` and prints the pushes it would make. Your checkout is not touched.
- **Single step:**
  - `scripts/mirror-release.sh build --out DIR`
  - `scripts/mirror-release.sh publish --from DIR [--dry-run]`
  - `scripts/mirror-release.sh sync-main [--dry-run]`
- **In GitHub:** Actions, then Mirror release, then Run workflow. `version` and `dry_run` are optional.
- **Failure summaries:** each job sets `FAILURE_SUMMARY_FILE`, and the script appends a markdown section there on failure. The file is uploaded as an artifact, and `report-failure` posts it.

## When it fails

A failure never publishes the failing version. It opens the issue **Mirror release failed**, or comments on it if it is already open, with the summary and a link to the run.

- **Cherry-pick conflicted.** Upstream changed the code our fix touches. Rebase the fix onto the blocked release:

  ```sh
  git fetch upstream
  git switch patches
  git rebase --onto <gitHead> "$(git merge-base patches <gitHead>)" patches   # resolve conflicts
  npm ci && npm run test:unit && npm run typecheck
  git push --force-with-lease origin patches
  ```

  Then re-run the workflow. `<gitHead>` is in the issue; you can also get it with `npm view pi-claude-bridge@<version> gitHead`.
- **Tests or typecheck failed.** Reproduce with `scripts/mirror-release.sh --dry-run --version <version>`, fix on `patches`, push, and re-run.
- **Merge of upstream/main conflicted or touches mirror-owned files.** Merge `upstream/main` into `main` locally, resolve, and push.
- **Published, but pushing `patches` or a tag failed.** For example, the lease was rejected because `patches` changed during the run. The package is out, and later runs will not rebuild that version. Push by hand: the fix commit is `mirror-build/<version>` in the run's artifact bundle, and the manifest has the SHA. Push it to `patches` and to the tag `mirror-v<version>`.

Close the issue once a run succeeds.
