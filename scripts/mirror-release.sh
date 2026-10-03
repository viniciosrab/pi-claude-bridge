#!/usr/bin/env bash
# Mirror upstream pi-claude-bridge npm releases as @viniciosrab/pi-claude-bridge, and publish
# fork revisions (X.Y.(Z+1)-fork.<N> for upstream X.Y.Z) when only our fix commits changed.
#
# Commands:
#   build --out DIR     For every upstream version still to mirror (oldest first), or else a
#                       fork revision when `patches` changed since the fork's latest publish:
#                       in a temporary worktree at the upstream version's npm gitHead,
#                       cherry-pick our fix commits, apply the fork identity (build time only),
#                       npm ci, unit tests, typecheck, npm pack. Writes tarballs, manifest.tsv,
#                       patches-base.txt and fixes.bundle to DIR. Stops at the first failure
#                       (versions built before it stay in DIR).
#   publish --from DIR  Publish the tarballs built by `build` (never runs package scripts),
#                       then push the rebuilt fix commits to `patches` and tag each version
#                       `mirror-v<version>`. Runs no upstream code.
#   sync-main           Merge upstream/main into the fork's main (merge commit) and push.
#   release             build + publish in one go (default; for local runs).
#
# Options:
#   --dry-run           no publish (npm publish --dry-run), no push, no tag, no merge push
#   --version X         mirror only upstream version X
#   --git-head SHA      build this commit as --version X instead of npm's gitHead (testing)
#   --out DIR / --from DIR
#
# What `build` mirrors: --version X if given; else, when the fork has no versions yet, the
# upstream latest only; else every stable upstream version newer than the fork's latest.
# When that leaves nothing (and no --version), a fork revision X.Y.(Z+1)-fork.N is built if the
# fix commits on `patches` differ from those tagged mirror-v<fork latest>, where X.Y.Z is the
# fork's highest stable version and N is one more than the highest such revision on npm. The
# bumped patch number sorts the revision above X.Y.Z and below upstream X.Y.(Z+1), so
# semver-based updaters (pi update) move through it.
#
# Environment:
#   UPSTREAM_PKG          upstream npm package        (default: pi-claude-bridge)
#   FORK_PKG              fork npm package            (default: @viniciosrab/pi-claude-bridge)
#   FORK_REPO             fork GitHub owner/name      (default: viniciosrab/pi-claude-bridge)
#   UPSTREAM_REPO         upstream GitHub owner/name  (default: elidickinson/pi-claude-bridge)
#   UPSTREAM_PR           upstream PR number of the fix, linked from the README note
#                         (default: 142; empty: no link)
#   UPSTREAM_REMOTE       git remote for upstream     (default: upstream)
#   FORK_REMOTE           git remote for the fork     (default: origin)
#   PATCHES_REF           ref holding the fix commits (default: local `patches`, else <fork remote>/patches)
#   NPM_PUBLISH_ARGS      extra npm publish arguments (default: --provenance --access public)
#   FAILURE_SUMMARY_FILE  markdown failure summaries are appended here
#                         (default: $RUNNER_TEMP or $TMPDIR, file mirror-failure.md)
set -euo pipefail

UPSTREAM_PKG="${UPSTREAM_PKG:-pi-claude-bridge}"
FORK_PKG="${FORK_PKG:-@viniciosrab/pi-claude-bridge}"
FORK_REPO="${FORK_REPO:-viniciosrab/pi-claude-bridge}"
UPSTREAM_REPO="${UPSTREAM_REPO:-elidickinson/pi-claude-bridge}"
UPSTREAM_PR="${UPSTREAM_PR-142}"
UPSTREAM_REMOTE="${UPSTREAM_REMOTE:-upstream}"
FORK_REMOTE="${FORK_REMOTE:-origin}"
NPM_PUBLISH_ARGS="${NPM_PUBLISH_ARGS:---provenance --access public}"
FAILURE_SUMMARY_FILE="${FAILURE_SUMMARY_FILE:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mirror-failure.md}"
# Paths the mirror owns on main; an upstream merge must never change them.
MIRROR_OWNED_PATHS=(.github scripts/mirror-release.sh docs/mirror.md)
# Paths upstream owns: a conflict confined to them resolves to upstream's side. Fix commits
# add `## UNRELEASED` changelog entries that every upstream release rewrites.
UPSTREAM_OWNED_PATHS=(CHANGELOG.md)
BUILD_REF_PREFIX=refs/mirror-build
# Private ref for the fix commits the fork's latest version was built from.
PUBLISHED_REF=refs/mirror-published/latest
# A fork revision of upstream X.Y.Z: X.Y.(Z+1)-fork.<N>. BASH_REMATCH: 1=X 2=Y 3=Z+1 4=N.
FORK_VERSION_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.([1-9][0-9]*)-fork\.([1-9][0-9]*)$'

DRY_RUN=false
MODE=release
VERSION=""
GIT_HEAD=""
GIT_HEAD_OVERRIDE=""
OUT_DIR=""
FROM_DIR=""

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d; s/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    build|publish|sync-main|release) MODE="$1" ;;
    --sync-main) MODE=sync-main ;;
    --dry-run) DRY_RUN=true ;;
    --version) VERSION="${2:?--version needs a value}"; shift ;;
    --git-head) GIT_HEAD_OVERRIDE="${2:?--git-head needs a value}"; shift ;;
    --out) OUT_DIR="${2:?--out needs a value}"; shift ;;
    --from) FROM_DIR="${2:?--from needs a value}"; shift ;;
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
    printf -- '- step: `%s`\n' "$MODE"
    [[ -n "$VERSION" ]] && printf -- '- upstream version: `%s@%s`\n' "$UPSTREAM_PKG" "$VERSION"
    [[ -n "$GIT_HEAD" ]] && printf -- '- upstream gitHead: `%s`\n' "$GIT_HEAD"
    if [[ -n "$details" ]]; then
      printf '\n```\n%s\n```\n' "$details"
    fi
    printf '\n'
  } >>"$FAILURE_SUMMARY_FILE"
  log "failure summary appended to $FAILURE_SUMMARY_FILE"
  exit 1
}

# Run a command, echoing its output; on failure, record the tail of it and exit.
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

drop_build_refs() {
  git -C "$REPO_ROOT" for-each-ref --format='delete %(refname)' "$BUILD_REF_PREFIX/" |
    git -C "$REPO_ROOT" update-ref --stdin
}

make_worktree() {
  WORKTREE="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/mirror-worktree.XXXXXX")"
  rmdir "$WORKTREE"
  git worktree add --detach --quiet "$WORKTREE" "$1"
}

# ---------------------------------------------------------------------------
# npm registry and semver helpers
# ---------------------------------------------------------------------------

# npm_json <spec> <field>: print `npm view --json` stdout (stderr is never mixed in).
# Returns 3 when the package or version does not exist (E404); any other failure
# records a summary and exits. Call as: x="$(npm_json ...)" || rc=$?
npm_json() {
  local err out rc=0
  err="$(mktemp)"
  out="$(npm view --json "$@" 2>"$err" </dev/null)" || rc=$?
  if [[ $rc -eq 0 ]]; then rm -f "$err"; printf '%s' "$out"; return 0; fi
  if grep -q 'E404' "$err" || grep -q '"code": *"E404"' <<<"$out"; then
    rm -f "$err"; return 3
  fi
  local msg; msg="$(cat "$err")"; rm -f "$err"
  fail "npm view $* failed" "$msg"
}

# upstream_json <field>: npm_json for the upstream package; a missing package is an error
# with a summary, never a silent exit.
upstream_json() {
  local out rc=0
  out="$(npm_json "$UPSTREAM_PKG" "$1")" || rc=$?
  [[ $rc -eq 0 ]] || { [[ $rc -eq 3 ]] && fail "npm view $UPSTREAM_PKG $1: package not found (E404)"; exit 1; }
  printf '%s' "$out"
}

# Semver and planning logic, kept in one small node program (node is present wherever npm is).
# Commands:
#   plan   <upstream-versions-json> <fork-versions-json> <upstream-latest> [explicit]
#          -> versions to mirror, oldest first, one per line
#   tag    <version> <current-fork-latest> -> latest | backfill | next
#   latest-stable <versions-json> -> highest stable version, empty when there is none
#   json-string <json> -> the (last) string value of a JSON string or array, empty for no input
#   fork-next <versions-json> <X.Y.Z> -> X.Y.(Z+1)-fork.<N>, N = 1 + the highest existing N (else 1)
# shellcheck disable=SC2016  # JavaScript template literals, not shell
SEMVER_JS='
const parse = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v);
  if (!m) throw new Error(`not a semver version: ${v}`);
  return { n: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split(".") : [] };
};
const cmpId = (a, b) => {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na && nb) return Math.sign(+a - +b);
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
};
const cmp = (x, y) => {
  const a = parse(x), b = parse(y);
  for (let i = 0; i < 3; i++) if (a.n[i] !== b.n[i]) return Math.sign(a.n[i] - b.n[i]);
  if (!a.pre.length || !b.pre.length) return Math.sign(b.pre.length - a.pre.length); // release > prerelease
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpId(a.pre[i], b.pre[i]);
    if (c) return c;
  }
  return 0;
};
const list = (s) => { if (!s || !s.trim()) return []; const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; };
const stable = (v) => parse(v).pre.length === 0;
const maxStable = (vs) => vs.filter(stable).sort(cmp).pop() || "";
const [cmd, ...args] = process.argv.slice(1);
if (cmd === "plan") {
  const [upJson, forkJson, upLatest, explicit] = args;
  const up = list(upJson), fork = list(forkJson), forkLatest = maxStable(fork);
  let out;
  if (explicit) out = [explicit];
  // No stable fork version yet (none at all, or prereleases only): upstream latest only,
  // never a backfill of all history.
  else if (!forkLatest) out = upLatest ? [upLatest] : [];
  else out = up.filter((v) => stable(v) && cmp(v, forkLatest) > 0).sort(cmp);
  for (const v of out) if (!fork.includes(v)) console.log(v);
} else if (cmd === "tag") {
  const [v, current] = args;
  console.log(!stable(v) ? "next" : !current || cmp(v, current) > 0 ? "latest" : "backfill");
} else if (cmd === "latest-stable") {
  console.log(maxStable(list(args[0])));
} else if (cmd === "fork-next") {
  const [vs, base] = args;
  const b = parse(base);
  if (b.pre.length) throw new Error(`fork revision base must be stable: ${base}`);
  const next = `${b.n[0]}.${b.n[1]}.${b.n[2] + 1}`;
  const ns = list(vs).map((v) => /^(\d+\.\d+\.\d+)-fork\.([1-9]\d*)$/.exec(v))
    .filter((m) => m && m[1] === next).map((m) => +m[2]);
  console.log(`${next}-fork.${Math.max(0, ...ns) + 1}`);
} else if (cmd === "json-string") {
  const v = list(args[0]); console.log(v.length ? String(v[v.length - 1]) : "");
} else {
  throw new Error(`unknown command ${cmd}`);
}
'
semver() { node -e "$SEMVER_JS" "$@"; }

# upstream_version <version>: the upstream version a fork version is built from (itself, or
# X.Y.Z for a fork revision X.Y.(Z+1)-fork.N).
upstream_version() {
  if [[ "$1" =~ $FORK_VERSION_RE ]]; then
    printf '%s.%s.%s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$((BASH_REMATCH[3] - 1))"
  else
    printf '%s' "$1"
  fi
}

# upstream_git_head <upstream version>: npm's gitHead for it; a missing version or gitHead
# records a summary and exits. Call as: x="$(upstream_git_head V)" || exit 1
upstream_git_head() {
  local json rc=0 head
  json="$(npm_json "$UPSTREAM_PKG@$1" gitHead)" || rc=$?
  [[ $rc -eq 0 ]] || { [[ $rc -eq 3 ]] && fail "$UPSTREAM_PKG@$1 does not exist"; exit 1; }
  head="$(semver json-string "$json")"
  [[ -n "$head" ]] || fail "$UPSTREAM_PKG@$1 has no gitHead in the registry"
  printf '%s' "$head"
}

# Resolve a stopped merge or cherry-pick in $WORKTREE when every conflicting path is
# upstream-owned, taking SIDE (--ours or --theirs). Returns 1, touching nothing, otherwise.
resolve_upstream_owned_conflicts() {
  local side="$1" conflicts path owned
  mapfile -t conflicts < <(git -C "$WORKTREE" diff --name-only --diff-filter=U)
  [[ ${#conflicts[@]} -gt 0 ]] || return 1
  for path in "${conflicts[@]}"; do
    for owned in "${UPSTREAM_OWNED_PATHS[@]}"; do
      [[ "$path" == "$owned" ]] && continue 2
    done
    return 1
  done
  git -C "$WORKTREE" checkout --quiet "$side" -- "${conflicts[@]}"
  git -C "$WORKTREE" add -- "${conflicts[@]}"
  log "resolved conflict in upstream-owned ${conflicts[*]} with $side"
}

# Commit a cherry-pick resolved by resolve_upstream_owned_conflicts, or skip it when the
# resolution left nothing to commit (the fix only touched upstream-owned paths).
finish_resolved_cherry_pick() {
  if git -C "$WORKTREE" diff --cached --quiet; then
    git -C "$WORKTREE" cherry-pick --skip
  else
    GIT_EDITOR=true git -C "$WORKTREE" cherry-pick --continue >/dev/null
  fi
}

# ---------------------------------------------------------------------------
# sync-main: merge upstream/main into the fork's main without rewriting history.
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
  if ! out="$(git -C "$WORKTREE" -c rerere.enabled=false merge --no-edit --no-ff "$upstream_main" \
      -m "Merge upstream/main into main" 2>&1)"; then
    # In a merge, --theirs is upstream/main.
    if resolve_upstream_owned_conflicts --theirs; then
      git -C "$WORKTREE" commit --quiet --no-edit
    else
      local conflicts
      conflicts="$(git -C "$WORKTREE" diff --name-only --diff-filter=U || true)"
      git -C "$WORKTREE" merge --abort || true
      fail "Merging upstream/main into main conflicted" "$out"$'\n\nConflicting files:\n'"$conflicts"
    fi
  fi

  # Upstream must never change the mirror's own files (GITHUB_TOKEN cannot push workflow
  # changes either); a human merges those.
  local owned
  owned="$(git -C "$WORKTREE" diff --name-only "$fork_main" HEAD -- "${MIRROR_OWNED_PATHS[@]}")"
  if [[ -n "$owned" ]]; then
    fail "Upstream merge would modify mirror-owned files; merge it manually" "$owned"
  fi

  local merge; merge="$(git -C "$WORKTREE" rev-parse HEAD)"
  if $DRY_RUN; then
    log "dry run: would push merge ${merge:0:7} to $FORK_REMOTE/main"
    return 0
  fi
  # Push the worktree's merge commit (not the caller's HEAD); a plain push is fast-forward only.
  run_or_fail "Pushing merged main failed" git push "$FORK_REMOTE" "$merge:refs/heads/main"
  log "main synced with upstream"
}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

resolve_patches_ref() {
  if [[ -n "${PATCHES_REF:-}" ]]; then :
  elif git show-ref --verify --quiet refs/heads/patches; then PATCHES_REF=patches
  else PATCHES_REF="refs/remotes/$FORK_REMOTE/patches"
  fi
  git rev-parse --verify --quiet "${PATCHES_REF}^{commit}" >/dev/null ||
    fail "patches ref '$PATCHES_REF' not found"
}

# Make sure the upstream release commit exists locally.
ensure_git_head() {
  if ! git cat-file -e "${GIT_HEAD}^{commit}" 2>/dev/null; then
    # A release may be cut from a branch we do not track; GitHub serves reachable SHAs.
    git fetch --quiet --no-tags "$UPSTREAM_REMOTE" "$GIT_HEAD" 2>/dev/null || true
  fi
  git cat-file -e "${GIT_HEAD}^{commit}" 2>/dev/null ||
    fail "gitHead $GIT_HEAD not found in $UPSTREAM_REMOTE history"
}

# Cherry-pick the fix commits of <source> onto the worktree HEAD (= gitHead). The fix commits
# are those on <source> that upstream history does not contain; this equals
# merge-base(source, gitHead)..source in the normal case, but stays correct when gitHead is
# older than the release the fix was last rebuilt on.
apply_patches() {
  local source="$1" commits c out
  mapfile -t commits < <(git rev-list --reverse --no-merges "$source" \
    --not --remotes="$UPSTREAM_REMOTE" "$GIT_HEAD")
  if [[ ${#commits[@]} -eq 0 ]]; then
    log "WARNING: no fix commits on $source outside upstream history; building upstream as-is"
    return 0
  fi
  local base; base="$(git rev-parse "${commits[0]}^")"
  log "applying ${#commits[@]} fix commit(s) from $source (base ${base:0:7})"

  # Same upstream release as last time: reuse the existing commits (stable SHAs).
  if [[ "$base" == "$GIT_HEAD" ]]; then
    git -C "$WORKTREE" checkout --quiet --detach "$source"
    log "fix commits already sit on ${GIT_HEAD:0:7}; using them as-is"
    return 0
  fi

  # --empty=drop (git >= 2.45) drops commits upstream already contains. `cherry-pick -h`
  # exits 129, so capture the help text before grepping (pipefail would hide the match).
  local help empty_drop=false
  help="$(git -C "$WORKTREE" cherry-pick -h 2>&1 || true)"
  if grep -q -- '--empty' <<<"$help"; then empty_drop=true; fi
  log "cherry-pick mode: $($empty_drop && echo '--empty=drop' || echo 'skip-on-empty fallback')"

  for c in "${commits[@]}"; do
    local subject before
    subject="$(git log -1 --format='%h %s' "$c")"
    before="$(git -C "$WORKTREE" rev-parse HEAD)"
    if $empty_drop; then
      out="$(git -C "$WORKTREE" -c rerere.enabled=false cherry-pick --empty=drop "$c" 2>&1)" || {
        # In a cherry-pick, --ours is the upstream release being built on.
        if resolve_upstream_owned_conflicts --ours; then
          finish_resolved_cherry_pick
        else
          git -C "$WORKTREE" cherry-pick --abort 2>/dev/null || true
          fail "Cherry-pick of fix commit conflicted: $subject" "$out"
        fi
      }
    elif ! out="$(git -C "$WORKTREE" -c rerere.enabled=false cherry-pick "$c" 2>&1)"; then
      # Older git stops on a now-empty commit with a clean tree; anything else is a conflict.
      if [[ -z "$(git -C "$WORKTREE" status --porcelain --untracked-files=no)" ]]; then
        git -C "$WORKTREE" cherry-pick --skip
      elif resolve_upstream_owned_conflicts --ours; then
        finish_resolved_cherry_pick
      else
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
  [[ "$picked" -gt 0 ]] || log "WARNING: no fix commits left (fix merged upstream?); building upstream as-is"
}

# Build-time fork identity. Never committed: the worktree is discarded afterwards.
apply_identity() {
  # shellcheck disable=SC2016  # literal markdown backticks
  local url="https://github.com/$FORK_REPO" addition='the `provider.loadClaudeSettings` option'
  [[ -z "$UPSTREAM_PR" ]] ||
    addition+=" ([upstream PR #$UPSTREAM_PR](https://github.com/$UPSTREAM_REPO/pull/$UPSTREAM_PR))"
  # shellcheck disable=SC2016  # literal markdown backticks
  addition+=' and the `provider.rateLimitWarnings` option'
  local up_version; up_version="$(upstream_version "$VERSION")"
  (
    cd "$WORKTREE"
    npm pkg set "name=$FORK_PKG" \
      "repository.type=git" "repository.url=git+$url.git" \
      "homepage=$url#readme" "bugs.url=$url/issues"
    [[ "$(npm pkg get version | tr -d '"')" == "$up_version" ]] ||
      fail "package.json version differs from upstream npm version $up_version"
    # A fork revision ships upstream's code at a fork-only version number.
    [[ "$VERSION" == "$up_version" ]] || npm pkg set "version=$VERSION"

    # Point the npm badge at the fork package, then insert the note after the title line.
    sed -i.bak \
      -e "s#img.shields.io/npm/v/$UPSTREAM_PKG)#img.shields.io/npm/v/$FORK_PKG)#" \
      -e "s#www.npmjs.com/package/$UPSTREAM_PKG)#www.npmjs.com/package/$FORK_PKG)#" README.md
    rm -f README.md.bak
    local note
    note="$(cat <<EOF

> **Fork note.** \`$FORK_PKG\` is an automated mirror of [\`$UPSTREAM_PKG\`](https://www.npmjs.com/package/$UPSTREAM_PKG) by Eli Dickinson ([$UPSTREAM_REPO](https://github.com/$UPSTREAM_REPO)), rebuilt for each upstream release with fork-only additions: $addition. Versions match upstream; a \`X.Y.(Z+1)-fork.N\` version is upstream \`X.Y.Z\` with newer fork-only changes. Licensed MIT; original copyright and credit belong to Eli Dickinson. Fork: [$FORK_REPO]($url).
EOF
)"
    awk -v note="$note" 'NR==1 { print; print note; next } { print }' README.md >README.md.tmp
    mv README.md.tmp README.md
  )
}

# Build one version in its own worktree. Appends a manifest line and records the rebuilt
# fix commits under $BUILD_REF_PREFIX/<version>. Runs in a subshell (see build()).
build_one() {
  local source="$1" current_latest="$2" up_version
  up_version="$(upstream_version "$VERSION")"
  if [[ -n "$GIT_HEAD_OVERRIDE" ]]; then
    GIT_HEAD="$(git rev-parse --verify "$GIT_HEAD_OVERRIDE^{commit}")" ||
      fail "--git-head $GIT_HEAD_OVERRIDE is not a commit"
  else
    GIT_HEAD="$(upstream_git_head "$up_version")" || exit 1
  fi
  log "== $FORK_PKG@$VERSION: $UPSTREAM_PKG@$up_version -> gitHead $GIT_HEAD"

  ensure_git_head
  make_worktree "$GIT_HEAD"
  apply_patches "$source"
  local fix_head; fix_head="$(git -C "$WORKTREE" rev-parse HEAD)"

  ( cd "$WORKTREE" && run_or_fail "npm ci failed" npm ci --no-audit --no-fund )
  apply_identity
  (
    cd "$WORKTREE"
    run_or_fail "Unit tests failed" npm run test:unit
    run_or_fail "Typecheck failed" npm run typecheck
    log "build-time identity:"
    npm pkg get name version repository homepage bugs >&2
    head -n 5 README.md >&2
  )

  local pack tarball tag
  pack="$(cd "$WORKTREE" && npm pack --json --pack-destination "$OUT_DIR" 2>/dev/null)" ||
    fail "npm pack failed"
  tarball="$(node -e 'console.log(JSON.parse(process.argv[1])[0].filename)' "$pack")"
  # A fork revision replaces the fork's latest (its base is the fork's highest stable version).
  if [[ "$VERSION" == "$up_version" ]]; then tag="$(semver tag "$VERSION" "$current_latest")"; else tag=latest; fi
  git update-ref "$BUILD_REF_PREFIX/$VERSION" "$fix_head"
  printf '%s\t%s\t%s\t%s\t%s\n' "$VERSION" "$tag" "$GIT_HEAD" "$fix_head" "$tarball" \
    >>"$OUT_DIR/manifest.tsv"
  log "built $tarball (dist-tag $tag, fix commits ${fix_head:0:7})"
}

# fix_patch_ids <ref> <upstream-commit>: the patch-ids of the fix commits on <ref> (commits
# outside upstream history and <upstream-commit>), oldest first. Patch-ids ignore the base, so
# a rebased but otherwise identical fix compares equal.
fix_patch_ids() {
  git log --reverse --no-merges -p "$1" --not --remotes="$UPSTREAM_REMOTE" "$2" |
    git patch-id --stable | cut -d' ' -f1
}

# plan_fork_revision <fork-versions-json> <fork highest stable B>: print B's next fork revision
# (see fork-next) when the fix
# commits on $PATCHES_REF differ from those of the fork's latest publish (tag
# mirror-v<dist-tags.latest>); print nothing when they match. Run in a command substitution:
# x="$(plan_fork_revision ...)" || exit 1
plan_fork_revision() {
  local fork_json="$1" base="$2" json rc=0 latest tag published
  [[ -n "$base" ]] || return 0
  json="$(npm_json "$FORK_PKG" dist-tags.latest)" || rc=$?
  [[ $rc -eq 0 ]] || { [[ $rc -eq 3 ]] && fail "$FORK_PKG has versions but no dist-tags.latest"; exit 1; }
  latest="$(semver json-string "$json")"
  # latest is B or a fork revision of B; anything else means dist-tags were changed by hand.
  [[ "$(upstream_version "$latest")" == "$base" ]] ||
    fail "Fork dist-tag latest '$latest' is neither $base nor a fork revision of it"

  # The fix commits $latest was built from: the tag the publish step recorded for it.
  # Only a tag missing on the remote falls back to a local tag; any other fetch failure
  # (network, auth) fails the run with git's own error.
  tag="mirror-v$latest"
  local out
  if ! out="$(LC_ALL=C git fetch --quiet --no-tags "$FORK_REMOTE" "+refs/tags/$tag:$PUBLISHED_REF" 2>&1)"; then
    grep -qi "couldn't find remote ref" <<<"$out" ||
      fail "Fetching tag $tag from $FORK_REMOTE failed" "$out"
    log "tag $tag not on $FORK_REMOTE; trying the local tag"
  fi
  published="$(git rev-parse --verify --quiet "$PUBLISHED_REF^{commit}" ||
    git rev-parse --verify --quiet "refs/tags/$tag^{commit}")" ||
    fail "Tag $tag not found; cannot tell which fix commits $FORK_PKG@$latest contains" \
      "Push the tag (see docs/mirror.md, 'Published, but pushing patches or a tag failed')."
  git update-ref -d "$PUBLISHED_REF" 2>/dev/null || true

  GIT_HEAD="$(upstream_git_head "$base")" || exit 1
  ensure_git_head
  local have want
  have="$(fix_patch_ids "$published" "$GIT_HEAD")"
  want="$(fix_patch_ids "$PATCHES_REF" "$GIT_HEAD")"
  if [[ "$have" == "$want" ]]; then
    log "fix commits on $PATCHES_REF match $FORK_PKG@$latest (${published:0:7}); no fork revision"
    return 0
  fi
  local next; next="$(semver fork-next "$fork_json" "$base")" || fail "Planning the fork revision failed"
  log "fix commits on $PATCHES_REF differ from $FORK_PKG@$latest (${published:0:7}); fork revision $next"
  printf '%s\n' "$next"
}

build() {
  [[ -n "$OUT_DIR" ]] || fail "build needs --out DIR"
  mkdir -p "$OUT_DIR"
  OUT_DIR="$(cd "$OUT_DIR" && pwd)"
  : >"$OUT_DIR/manifest.tsv"
  rm -f "$OUT_DIR/fixes.bundle" "$OUT_DIR"/*.tgz
  drop_build_refs

  run_or_fail "git fetch $UPSTREAM_REMOTE failed" git fetch --quiet --no-tags "$UPSTREAM_REMOTE"
  git fetch --quiet "$FORK_REMOTE" patches 2>/dev/null || true
  # The lease for the later patches push: the fork's patches as seen before building.
  git rev-parse --verify --quiet "refs/remotes/$FORK_REMOTE/patches" >"$OUT_DIR/patches-base.txt" || true
  resolve_patches_ref

  # Decide what to mirror.
  local up_json fork_json latest_json up_latest current_latest rc=0
  up_json="$(upstream_json versions)"
  latest_json="$(upstream_json dist-tags.latest)"
  up_latest="$(semver json-string "$latest_json")"
  fork_json="$(npm_json "$FORK_PKG" versions)" || rc=$?
  [[ $rc -eq 0 || $rc -eq 3 ]] || exit 1
  [[ $rc -eq 0 ]] || fork_json=""
  # The fork's current latest is its highest stable version (none if it has only prereleases).
  current_latest="$(semver latest-stable "$fork_json")"
  [[ -z "$GIT_HEAD_OVERRIDE" || -n "$VERSION" ]] || fail "--git-head requires --version"

  # Checked substitution: a planner crash must fail the run, not look like "nothing to do".
  local plan_out plan_err; plan_err="$(mktemp)"
  plan_out="$(semver plan "$up_json" "$fork_json" "$up_latest" "$VERSION" 2>"$plan_err")" ||
    fail "Planning the versions to mirror failed" "$(cat "$plan_err")"
  rm -f "$plan_err"
  local -a versions=()
  [[ -z "$plan_out" ]] || mapfile -t versions <<<"$plan_out"
  # No upstream release to mirror: publish fix-only changes as a fork revision of the fork's
  # current version. A newer upstream release already carries every fix commit.
  if [[ ${#versions[@]} -eq 0 && -z "$VERSION" ]]; then
    plan_out="$(plan_fork_revision "$fork_json" "$current_latest")" || exit 1
    [[ -z "$plan_out" ]] || versions=("$plan_out")
  fi
  if [[ ${#versions[@]} -eq 0 ]]; then
    log "nothing to mirror (fork latest stable: ${current_latest:-none}, upstream latest: $up_latest)"
    return 0
  fi
  log "to mirror, oldest first: ${versions[*]} (fork latest: ${current_latest:-none})"

  # Each version builds on the previous one's rebuilt fix commits; stop at the first failure.
  local source="$PATCHES_REF" status=0 v tag fix
  for v in "${versions[@]}"; do
    # A plain subshell (not an `if` condition) so that set -e stays active inside it.
    set +e
    ( set -e; trap cleanup EXIT; VERSION="$v"; build_one "$source" "$current_latest" )
    status=$?
    set -e
    [[ $status -eq 0 ]] || break
    IFS=$'\t' read -r _ tag _ fix _ < <(tail -n 1 "$OUT_DIR/manifest.tsv")
    source="$fix"
    [[ "$tag" != latest ]] || current_latest="$v"
  done

  # Self-contained bundle of the rebuilt fix commits, for the publish job.
  local -a refs
  mapfile -t refs < <(git for-each-ref --format='%(refname)' "$BUILD_REF_PREFIX/")
  if [[ ${#refs[@]} -gt 0 ]]; then
    git bundle create --quiet "$OUT_DIR/fixes.bundle" "${refs[@]}"
    drop_build_refs
  fi
  log "built $(wc -l <"$OUT_DIR/manifest.tsv") version(s) into $OUT_DIR"
  return "$status"
}

# ---------------------------------------------------------------------------
# publish: tarballs + git bundle only; never runs upstream code.
# ---------------------------------------------------------------------------
# The build artifact comes from an unprivileged job: check everything in it against npm and
# git before the privileged publish uses any of it. Any mismatch rejects the whole publish.
validate_artifact() {
  local dir="$1" base="$2" pack_prefix up_json heads line
  pack_prefix="$(printf '%s' "${FORK_PKG#@}" | tr '/' '-')"
  [[ -z "$base" || "$base" =~ ^[0-9a-f]{40}$ ]] || fail "Artifact rejected: bad patches-base '$base'"

  # The bundle may only carry refs/mirror-build/<version> heads.
  git bundle verify --quiet "$dir/fixes.bundle" >/dev/null 2>&1 ||
    fail "Artifact rejected: fixes.bundle does not verify"
  heads="$(git bundle list-heads "$dir/fixes.bundle")"
  while read -r _ ref; do
    [[ "$ref" =~ ^$BUILD_REF_PREFIX/[0-9A-Za-z.+-]+$ ]] ||
      fail "Artifact rejected: unexpected ref '$ref' in fixes.bundle"
  done <<<"$heads"

  up_json="$(upstream_json versions)"
  # A fork revision must build on the fork's current highest stable version (re-read here).
  local fork_json fork_stable rc=0
  fork_json="$(npm_json "$FORK_PKG" versions)" || rc=$?
  [[ $rc -eq 0 || $rc -eq 3 ]] || exit 1
  [[ $rc -eq 0 ]] || fork_json=""
  fork_stable="$(semver latest-stable "$fork_json")"
  local version up_version tag git_head fix tarball extra seen=" "
  while IFS=$'\t' read -r -u 4 version tag git_head fix tarball extra; do
    line="$version $tag ${git_head:0:12} ${fix:0:12} $tarball"
    [[ -z "$extra" ]] || fail "Artifact rejected: malformed manifest line" "$line"
    [[ "$version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] ||
      fail "Artifact rejected: '$version' is not a strict semver version"
    [[ "$seen" != *" $version "* ]] || fail "Artifact rejected: duplicate version $version"
    seen+="$version "
    up_version="$(upstream_version "$version")"
    node -e 'process.exit(JSON.parse(process.argv[1]).includes(process.argv[2]) ? 0 : 1)' \
      "$up_json" "$up_version" || fail "Artifact rejected: $UPSTREAM_PKG@$up_version does not exist upstream"
    if [[ "$version" != "$up_version" ]]; then
      # Fork revision of B: B already mirrored and the fork's highest stable version,
      # and it replaces the fork's latest.
      [[ -n "$fork_stable" && "$up_version" == "$fork_stable" ]] ||
        fail "Artifact rejected: fork revision $version is not based on the fork's latest stable version (${fork_stable:-none})"
      [[ "$tag" == latest ]] || fail "Artifact rejected: fork revision $version tagged $tag, not latest"
    else
      case "$tag" in
        next) [[ "$version" == *-* ]] || fail "Artifact rejected: stable $version tagged next" ;;
        latest|backfill) [[ "$version" != *-* ]] || fail "Artifact rejected: prerelease $version tagged $tag" ;;
        *) fail "Artifact rejected: dist-tag '$tag' for $version" ;;
      esac
    fi

    # Tarball: expected name, a regular file inside DIR, and a package.json that matches.
    [[ "$tarball" == "$pack_prefix-$version.tgz" ]] ||
      fail "Artifact rejected: tarball '$tarball' is not $pack_prefix-$version.tgz"
    [[ -f "$dir/$tarball" && ! -L "$dir/$tarball" ]] ||
      fail "Artifact rejected: $tarball is not a regular file"
    local pkg
    pkg="$(tar -xOzf "$dir/$tarball" package/package.json 2>/dev/null)" ||
      fail "Artifact rejected: $tarball has no package/package.json"
    node -e '
      const p = JSON.parse(process.argv[1]);
      process.exit(p.name === process.argv[2] && p.version === process.argv[3] ? 0 : 1);
    ' "$pkg" "$FORK_PKG" "$version" ||
      fail "Artifact rejected: $tarball is not $FORK_PKG@$version"

    # Git: the fix commit is this version's bundle head and descends from the upstream
    # gitHead, which must be npm's gitHead for the version (unless built with --git-head).
    [[ "$git_head" =~ ^[0-9a-f]{40}$ && "$fix" =~ ^[0-9a-f]{40}$ ]] ||
      fail "Artifact rejected: bad commit ids for $version" "$line"
    grep -Fqx "$fix $BUILD_REF_PREFIX/$version" <<<"$heads" ||
      fail "Artifact rejected: $fix is not $BUILD_REF_PREFIX/$version in fixes.bundle"
    if [[ -z "$GIT_HEAD_OVERRIDE" ]]; then
      local npm_head; rc=0
      npm_head="$(npm_json "$UPSTREAM_PKG@$up_version" gitHead)" || rc=$?
      [[ $rc -eq 0 ]] || exit 1
      [[ "$(semver json-string "$npm_head")" == "$git_head" ]] ||
        fail "Artifact rejected: gitHead for $version differs from npm" "$line"
    fi
  done 4<"$dir/manifest.tsv"

  # Only now import the commits (only refs/mirror-build/*) and check their ancestry.
  run_or_fail "Reading fixes.bundle failed" \
    git fetch --quiet --no-tags "$dir/fixes.bundle" "+$BUILD_REF_PREFIX/*:$BUILD_REF_PREFIX/*"
  while IFS=$'\t' read -r -u 4 version tag git_head fix tarball; do
    if ! git cat-file -e "${git_head}^{commit}" 2>/dev/null ||
       ! git merge-base --is-ancestor "$git_head" "$fix"; then
      fail "Artifact rejected: fix commit for $version does not descend from gitHead $git_head"
    fi
  done 4<"$dir/manifest.tsv"
  log "artifact validated: $(wc -l <"$dir/manifest.tsv") version(s)"
}

# ---------------------------------------------------------------------------
# publish: validated tarballs + git bundle only; never runs upstream code.
# ---------------------------------------------------------------------------
publish() {
  [[ -n "$FROM_DIR" && -f "$FROM_DIR/manifest.tsv" ]] || fail "publish needs --from DIR with manifest.tsv"
  if [[ ! -s "$FROM_DIR/manifest.tsv" ]]; then log "nothing to publish"; return 0; fi
  local base; base="$(cat "$FROM_DIR/patches-base.txt" 2>/dev/null || true)"
  trap 'cleanup; drop_build_refs' EXIT
  validate_artifact "$FROM_DIR" "$base"

  local -a args
  read -r -a args <<<"$NPM_PUBLISH_ARGS"
  if $DRY_RUN; then
    # Provenance needs a CI OIDC identity; a local dry run cannot produce it.
    local -a keep=()
    for a in "${args[@]}"; do [[ "$a" == --provenance ]] || keep+=("$a"); done
    args=(--dry-run "${keep[@]}")
  fi

  # Publish oldest first. On any error, stop, but still record the versions published so far.
  local version tag git_head fix tarball last_fix="" rc out
  local -a done_versions=() done_fixes=() errors=()
  while IFS=$'\t' read -r -u 3 version tag git_head fix tarball; do
    VERSION="$version"; GIT_HEAD="$git_head"
    # Published only when npm answers with this exact version: some npm versions exit 0
    # with empty output when the package exists but the version does not.
    rc=0; out="$(npm_json "$FORK_PKG@$version" version)" || rc=$?
    if [[ $rc -eq 0 && "$(semver json-string "$out")" == "$version" ]]; then
      log "$FORK_PKG@$version already published; skipping npm publish"
    elif [[ $rc -eq 0 || $rc -eq 3 ]]; then
      # Publishing a tarball runs no package lifecycle scripts (npm only runs them for
      # directory publishes); --ignore-scripts makes that explicit.
      log "\$ npm publish $tarball --tag $tag --ignore-scripts ${args[*]}"
      if ! out="$(npm publish "$FROM_DIR/$tarball" --tag "$tag" --ignore-scripts "${args[@]}" 2>&1 </dev/null)"; then
        printf '%s\n' "$out" >&2
        errors+=("npm publish $FORK_PKG@$version failed:"$'\n'"$(printf '%s\n' "$out" | tail -n 60)")
        break
      fi
      printf '%s\n' "$out" >&2
    else
      # npm_json already appended the npm error to the summary.
      errors+=("Could not check whether $FORK_PKG@$version is published (npm view failed); stopped before it.")
      break
    fi
    last_fix="$fix"; done_versions+=("$version"); done_fixes+=("$fix")
  done 3<"$FROM_DIR/manifest.tsv"

  # Record what was published: patches -> last published fix commits, one tag per version.
  # Tags do not depend on patches, so they are pushed even if the patches lease is rejected.
  if [[ -n "$last_fix" ]]; then
    if $DRY_RUN; then
      log "dry run: would push ${last_fix:0:7} to $FORK_REMOTE/patches (lease: ${base:-absent})"
      for i in "${!done_versions[@]}"; do
        log "dry run: would push tag mirror-v${done_versions[$i]} -> ${done_fixes[$i]:0:7}"
      done
    else
      log "\$ git push --force-with-lease=refs/heads/patches:${base} $FORK_REMOTE ${last_fix}:refs/heads/patches"
      out="$(git push --force-with-lease="refs/heads/patches:$base" "$FORK_REMOTE" \
        "$last_fix:refs/heads/patches" 2>&1)" || errors+=("Pushing patches failed:"$'\n'"$out")
      printf '%s\n' "$out" >&2
      for i in "${!done_versions[@]}"; do
        log "\$ git push $FORK_REMOTE ${done_fixes[$i]}:refs/tags/mirror-v${done_versions[$i]}"
        out="$(git push "$FORK_REMOTE" "${done_fixes[$i]}:refs/tags/mirror-v${done_versions[$i]}" 2>&1)" ||
          errors+=("Pushing tag mirror-v${done_versions[$i]} failed:"$'\n'"$out")
        printf '%s\n' "$out" >&2
      done
    fi
  fi
  if [[ ${#errors[@]} -gt 0 ]]; then
    VERSION=""; GIT_HEAD=""
    fail "Publish incomplete (published: ${done_versions[*]:-none})" "$(printf '%s\n\n' "${errors[@]}")"
  fi
}

case "$MODE" in
  build) build ;;
  publish) publish ;;
  sync-main) sync_main ;;
  release)
    OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mirror-out.XXXXXX")"
    FROM_DIR="$OUT_DIR"
    # Subshell outside any `||`/`if` so that set -e stays active in build.
    set +e
    ( set -e; build )
    build_status=$?
    set -e
    publish
    rm -rf "$OUT_DIR"
    exit "$build_status"
    ;;
esac
