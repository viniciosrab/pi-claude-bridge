#!/usr/bin/env bash
# Mirror an upstream pi-claude-bridge npm release as @viniciosrab/pi-claude-bridge.
#
# Release mode (default):
#   1. Resolve the upstream version and its gitHead from npm.
#   2. Skip if the fork package already has that version.
#   3. In a temporary worktree at gitHead, cherry-pick our fix commits from the
#      `patches` branch (commits already merged upstream become empty and are dropped).
#   4. Apply the fork identity (package name, repo URLs, README note) at build time only.
#   5. npm ci, unit tests, typecheck, publish.
#   6. Push the rebuilt fix commits to `patches` and tag them `mirror-v<version>`.
#
# Sync mode (--sync-main): merge upstream/main into origin/main (merge commit) and push.
#
# Usage:
#   scripts/mirror-release.sh [--dry-run] [--version X [--git-head SHA]]
#   scripts/mirror-release.sh --sync-main [--dry-run]
#
#   --version X     build upstream version X instead of the latest (gitHead from npm)
#   --git-head SHA  build this commit instead of npm's gitHead (testing/recovery only)
#
# Environment:
#   UPSTREAM_PKG           upstream npm package          (default: pi-claude-bridge)
#   FORK_PKG               fork npm package              (default: @viniciosrab/pi-claude-bridge)
#   FORK_REPO              fork GitHub repo owner/name   (default: viniciosrab/pi-claude-bridge)
#   UPSTREAM_REPO          upstream GitHub owner/name    (default: elidickinson/pi-claude-bridge)
#   UPSTREAM_REMOTE        git remote for upstream       (default: upstream)
#   FORK_REMOTE            git remote for the fork       (default: origin)
#   PATCHES_REF            ref holding the fix commits   (default: local `patches`, else origin/patches)
#   NPM_PUBLISH_ARGS       npm publish arguments         (default: --provenance --access public)
#   FAILURE_SUMMARY_FILE   markdown failure summary is appended here (default: mirror-failure.md in $RUNNER_TEMP or $TMPDIR)
set -euo pipefail

UPSTREAM_PKG="${UPSTREAM_PKG:-pi-claude-bridge}"
FORK_PKG="${FORK_PKG:-@viniciosrab/pi-claude-bridge}"
FORK_REPO="${FORK_REPO:-viniciosrab/pi-claude-bridge}"
UPSTREAM_REPO="${UPSTREAM_REPO:-elidickinson/pi-claude-bridge}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
FORK_REMOTE="${FORK_REMOTE:-origin}"
NPM_PUBLISH_ARGS="${NPM_PUBLISH_ARGS:---provenance --access public}"
FAILURE_SUMMARY_FILE="${FAILURE_SUMMARY_FILE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mirror-failure.md}"
UPSTREAM_PR_URL="https://github.com/${UPSTREAM_REPO}/pull/142"

DRY_RUN=false
MODE=release
VERSION=""
GIT_HEAD_OVERRIDE=""

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --sync-main) MODE=sync-main ;;
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --git-head) GIT_HEAD_OVERRIDE="${2:?--git-head needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

log() { printf '[mirror] %s\n' "$*" >&2; }

# Append a markdown failure summary (the workflow turns it into an issue) and exit.
# shellcheck disable=SC2016  # backticks are literal markdown
fail() {
  local title="$1" details="${2:-}"
  log "FAILED: $title"
  {
    printf '## %s\n\n' "$title"
    printf -- '- mode: `%s`\n' "$MODE"
    [[ -n "$VERSION" ]] && printf -- '- upstream version: `%s@%s`\n' "$UPSTREAM_PKG" "$VERSION"
    [[ -n "${GIT_HEAD:-}" ]] && printf -- '- upstream gitHead: `%s`\n' "$GIT_HEAD"
    [[ -n "${GITHUB_RUN_ID:-}" ]] && printf -- '- run: %s/%s/actions/runs/%s\n' \
      "${GITHUB_SERVER_URL:-https://github.com}" "${GITHUB_REPOSITORY:-$FORK_REPO}" "$GITHUB_RUN_ID"
    if [[ -n "$details" ]]; then
      printf '\n```\n%s\n```\n' "$details"
    fi
    printf '\n'
  } >>"$FAILURE_SUMMARY_FILE"
  log "failure summary appended to $FAILURE_SUMMARY_FILE"
  exit 1
}

# Run a command; on failure, record its (tail of) output in the failure summary.
run_or_fail() {
  local title="$1"; shift
  local out
  log "\$ $*"
  if ! out="$("$@" 2>&1)"; then
    printf '%s\n' "$out" >&2
    fail "$title" "$(printf '%s\n' "$out" | tail -n 60)"
  fi
  [[ -z "$out" ]] || printf '%s\n' "$out" >&2
}

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Every mutation happens in a throwaway worktree; the caller's checkout is never touched.
WORKTREE=""
cleanup() {
  if [[ -n "$WORKTREE" && -d "$WORKTREE" ]]; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || rm -rf "$WORKTREE"
  fi
  git -C "$REPO_ROOT" worktree prune >/dev/null 2>&1 || true
}
trap cleanup EXIT

make_worktree() {
  WORKTREE="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mirror-worktree.XXXXXX")"
  rmdir "$WORKTREE"
  git worktree add --detach --quiet "$WORKTREE" "$1"
}

# Prints the version if it exists in the registry, nothing if it does not (404).
# Any other npm error (network, auth) is fatal: never guess that a version is missing.
npm_version_exists() {
  local spec="$1" out
  if out="$(npm view "$spec" version 2>&1)"; then
    printf '%s' "$out"
  elif grep -q 'E404' <<<"$out"; then
    return 0
  else
    fail "npm view $spec failed" "$out"
  fi
}

# npm view that records npm's error output in the failure summary.
npm_view() {
  local out
  out="$(npm view "$@" 2>&1)" || fail "npm view $* failed" "$out"
  printf '%s' "$out"
}

# ---------------------------------------------------------------------------
# --sync-main: merge upstream/main into origin/main without rewriting history.
# ---------------------------------------------------------------------------
sync_main() {
  run_or_fail "git fetch failed" git fetch --quiet "$FORK_REMOTE" main
  run_or_fail "git fetch failed" git fetch --quiet --no-tags "$UPSTREAM_REMOTE" main
  local upstream_main="refs/remotes/$UPSTREAM_REMOTE/main" fork_main="refs/remotes/$FORK_REMOTE/main"

  if git merge-base --is-ancestor "$upstream_main" "$fork_main"; then
    log "$FORK_REMOTE/main already contains $UPSTREAM_REMOTE/main; nothing to sync"
    return 0
  fi

  make_worktree "$fork_main"
  local out
  if ! out="$(git -C "$WORKTREE" merge --no-edit --no-ff "$upstream_main" \
      -m "Merge upstream/main into main" 2>&1)"; then
    local conflicts
    conflicts="$(git -C "$WORKTREE" diff --name-only --diff-filter=U || true)"
    git -C "$WORKTREE" merge --abort || true
    fail "Merging upstream/main into main conflicted" "$out"$'\n\nConflicting files:\n'"$conflicts"
  fi

  # GITHUB_TOKEN may not push workflow changes, and upstream must never alter our CI.
  local wf_changes
  wf_changes="$(git -C "$WORKTREE" diff --name-only "$fork_main" HEAD -- .github/workflows)"
  if [[ -n "$wf_changes" ]]; then
    fail "Upstream merge would modify workflow files; merge it manually" "$wf_changes"
  fi

  if $DRY_RUN; then
    log "dry run: would push merge $(git -C "$WORKTREE" rev-parse --short HEAD) to $FORK_REMOTE/main"
    git -C "$WORKTREE" log --oneline -1 >&2
    return 0
  fi
  # Push the worktree's merge commit (not the caller's HEAD); a plain push is fast-forward only.
  run_or_fail "Pushing merged main failed" \
    git push "$FORK_REMOTE" "$(git -C "$WORKTREE" rev-parse HEAD):refs/heads/main"
  log "main synced with upstream"
}

# ---------------------------------------------------------------------------
# Release helpers
# ---------------------------------------------------------------------------

# Make sure the upstream release commit exists locally.
ensure_git_head() {
  run_or_fail "git fetch $UPSTREAM_REMOTE failed" git fetch --quiet --no-tags "$UPSTREAM_REMOTE"
  if ! git cat-file -e "${GIT_HEAD}^{commit}" 2>/dev/null; then
    # A release may be cut from a branch we do not track; GitHub serves reachable SHAs.
    git fetch --quiet --no-tags "$UPSTREAM_REMOTE" "$GIT_HEAD" 2>/dev/null || true
  fi
  git cat-file -e "${GIT_HEAD}^{commit}" 2>/dev/null ||
    fail "gitHead $GIT_HEAD not found in $UPSTREAM_REMOTE history"
}

resolve_patches_ref() {
  if [[ -n "${PATCHES_REF:-}" ]]; then :
  elif git show-ref --verify --quiet refs/heads/patches; then PATCHES_REF=patches
  else
    git fetch --quiet "$FORK_REMOTE" patches 2>/dev/null || true
    PATCHES_REF="refs/remotes/$FORK_REMOTE/patches"
  fi
  git rev-parse --verify --quiet "${PATCHES_REF}^{commit}" >/dev/null ||
    fail "patches ref '$PATCHES_REF' not found"
}

# Cherry-pick our fix commits onto the worktree HEAD (= gitHead). The fix commits are
# the ones on patches that upstream history does not contain; this equals
# merge-base(patches, gitHead)..patches in the normal case, but stays correct when
# gitHead is older than the release patches was last rebuilt on.
apply_patches() {
  local commits c out
  mapfile -t commits < <(git rev-list --reverse --no-merges "$PATCHES_REF" \
    --not --remotes="$UPSTREAM_REMOTE" "$GIT_HEAD")
  if [[ ${#commits[@]} -eq 0 ]]; then
    log "WARNING: no fix commits on $PATCHES_REF outside upstream history; publishing upstream as-is"
    return 0
  fi
  local base; base="$(git rev-parse "${commits[0]}^")"
  log "applying ${#commits[@]} fix commit(s) from $PATCHES_REF (base ${base:0:7})"

  # Same upstream release as last time: reuse the existing commits (stable SHAs).
  if [[ "$base" == "$GIT_HEAD" ]] && git merge-base --is-ancestor "$GIT_HEAD" "$PATCHES_REF"; then
    git -C "$WORKTREE" checkout --quiet --detach "$PATCHES_REF"
    log "patches already sit on ${GIT_HEAD:0:7}; using them as-is"
    return 0
  fi

  # --empty=drop (git >= 2.45) silently drops commits upstream already contains.
  local empty_drop=false
  if git -C "$WORKTREE" cherry-pick -h 2>&1 | grep -q -- '--empty'; then empty_drop=true; fi

  for c in "${commits[@]}"; do
    local subject; subject="$(git log -1 --format='%h %s' "$c")"
    local before; before="$(git -C "$WORKTREE" rev-parse HEAD)"
    if $empty_drop; then
      out="$(git -C "$WORKTREE" cherry-pick --empty=drop "$c" 2>&1)" || {
        git -C "$WORKTREE" cherry-pick --abort 2>/dev/null || true
        fail "Cherry-pick of fix commit conflicted: $subject" "$out"
      }
    else
      # Older git: a commit upstream already contains makes cherry-pick stop as "empty".
      if ! out="$(git -C "$WORKTREE" cherry-pick "$c" 2>&1)"; then
        if [[ -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]]; then
          git -C "$WORKTREE" cherry-pick --skip
          log "dropped $subject (already upstream)"; continue
        fi
        git -C "$WORKTREE" cherry-pick --abort 2>/dev/null || true
        fail "Cherry-pick of fix commit conflicted: $subject" "$out"
      fi
    fi
    if [[ "$(git -C "$WORKTREE" rev-parse HEAD)" == "$before" ]]; then
      log "dropped $subject (already upstream)"
    else
      log "picked $subject"
    fi
  done

  local picked; picked="$(git -C "$WORKTREE" rev-list --count "$GIT_HEAD..HEAD")"
  log "$picked fix commit(s) on top of ${GIT_HEAD:0:7}"
  [[ "$picked" -gt 0 ]] || log "WARNING: no fix commits left (fix merged upstream?); publishing upstream as-is"
}

# Build-time fork identity. Never committed: the worktree is discarded afterwards.
apply_identity() {
  local url="https://github.com/$FORK_REPO"
  (
    cd "$WORKTREE"
    npm pkg set "name=$FORK_PKG" \
      "repository.type=git" "repository.url=git+$url.git" \
      "homepage=$url#readme" "bugs.url=$url/issues"
    [[ "$(npm pkg get version | tr -d '"')" == "$VERSION" ]] ||
      fail "package.json version differs from upstream npm version $VERSION"

    local note
    note="$(cat <<EOF

> **Fork note.** \`$FORK_PKG\` is an automated mirror of [\`$UPSTREAM_PKG\`](https://www.npmjs.com/package/$UPSTREAM_PKG) by Eli Dickinson ([$UPSTREAM_REPO](https://github.com/$UPSTREAM_REPO)), rebuilt for each upstream release with one addition: the \`provider.loadClaudeSettings\` option ([upstream PR #142]($UPSTREAM_PR_URL)). Versions match upstream. Licensed MIT; original copyright and credit belong to Eli Dickinson. Fork: [$FORK_REPO]($url).
EOF
)"
    # Point the npm badge at the fork package, then insert the note after the title line.
    sed -i.bak \
      -e "s#img.shields.io/npm/v/$UPSTREAM_PKG)#img.shields.io/npm/v/$FORK_PKG)#" \
      -e "s#www.npmjs.com/package/$UPSTREAM_PKG)#www.npmjs.com/package/$FORK_PKG)#" README.md
    rm -f README.md.bak
    awk -v note="$note" 'NR==1 { print; print note; next } { print }' README.md >README.md.tmp
    mv README.md.tmp README.md
  )
}

# ---------------------------------------------------------------------------
# Release
# ---------------------------------------------------------------------------
release() {
  if [[ -z "$VERSION" ]]; then
    VERSION="$(npm_view "$UPSTREAM_PKG" version)"
  fi
  if [[ -n "$GIT_HEAD_OVERRIDE" ]]; then
    [[ -n "$VERSION" ]] || fail "--git-head requires --version"
    GIT_HEAD="$(git rev-parse --verify "$GIT_HEAD_OVERRIDE^{commit}")" || fail "--git-head $GIT_HEAD_OVERRIDE is not a commit"
  else
    GIT_HEAD="$(npm_view "$UPSTREAM_PKG@$VERSION" gitHead)"
  fi
  [[ -n "$GIT_HEAD" ]] || fail "$UPSTREAM_PKG@$VERSION has no gitHead in the registry"
  log "upstream $UPSTREAM_PKG@$VERSION -> gitHead $GIT_HEAD"

  local existing
  existing="$(npm_version_exists "$FORK_PKG@$VERSION")"
  if [[ -n "$existing" ]]; then
    log "$FORK_PKG@$VERSION is already published; nothing to do"
    return 0
  fi

  ensure_git_head
  resolve_patches_ref
  make_worktree "$GIT_HEAD"
  apply_patches
  local fix_head; fix_head="$(git -C "$WORKTREE" rev-parse HEAD)"

  (
    cd "$WORKTREE"
    run_or_fail "npm ci failed" npm ci --no-audit --no-fund
  )
  apply_identity
  (
    cd "$WORKTREE"
    run_or_fail "Unit tests failed" npm run test:unit
    run_or_fail "Typecheck failed" npm run typecheck
  )

  local -a publish_args
  read -r -a publish_args <<<"$NPM_PUBLISH_ARGS"
  if $DRY_RUN; then
    # Provenance needs a CI OIDC identity; a local dry run cannot produce it.
    local -a dry=()
    for a in "${publish_args[@]}"; do [[ "$a" == --provenance ]] || dry+=("$a"); done
    log "dry run: build-time identity"
    ( cd "$WORKTREE" && npm pkg get name version repository homepage bugs >&2 && head -n 5 README.md >&2 )
    ( cd "$WORKTREE" && npm publish --dry-run "${dry[@]}" )
    log "dry run: would push ${fix_head:0:7} to $FORK_REMOTE/patches and tag mirror-v$VERSION"
    return 0
  fi

  ( cd "$WORKTREE" && run_or_fail "npm publish failed" npm publish "${publish_args[@]}" )
  log "published $FORK_PKG@$VERSION"

  # Record exactly what was built (fix commits only, no identity changes).
  local lease="refs/heads/patches:"
  if git fetch --quiet "$FORK_REMOTE" patches 2>/dev/null; then
    lease="refs/heads/patches:$(git rev-parse "refs/remotes/$FORK_REMOTE/patches")"
  fi
  run_or_fail "Published, but pushing the patches branch failed" \
    git push --force-with-lease="$lease" "$FORK_REMOTE" "$fix_head:refs/heads/patches"
  run_or_fail "Published, but tagging mirror-v$VERSION failed" \
    git tag "mirror-v$VERSION" "$fix_head"
  run_or_fail "Published, but pushing tag mirror-v$VERSION failed" \
    git push "$FORK_REMOTE" "refs/tags/mirror-v$VERSION"
  log "patches -> ${fix_head:0:7}, tagged mirror-v$VERSION"
}

case "$MODE" in
  release) release ;;
  sync-main) sync_main ;;
esac
