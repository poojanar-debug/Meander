#!/usr/bin/env bash
#
# Redeploying the single Oracle Always Free VM, and proving it worked.
#
# ---------------------------------------------------------------------------
# ⚠ WHAT THIS FILE IS NOT, YET
#
# DEPLOY-PROMPT.md §C1 asks for a full from-scratch provisioning script: the
# Oracle console steps, both firewall layers (the VCN security list *and* the
# instance's iptables — missing the second is the classic Oracle time sink),
# the Docker install, the deadsnakes Python 3.13, the Chromium snap and the
# `cups` it drags in. None of that is here. That script has to be written from
# this machine's real shell history rather than from imagination, and writing
# it from imagination is how a provisioning script comes to describe a machine
# nobody has ever built.
#
# What IS here is the part that was learned the hard way and is worth more than
# a guess: the redeploy path, and the two ways it silently does nothing.
# ---------------------------------------------------------------------------
#
# THE TWO TRAPS. Both exit 0. Both look exactly like a successful deploy.
#
# 1. `Caddyfile` is a SINGLE-FILE bind mount (compose.prod.yml:194). A bind
#    mount of a file resolves to an *inode*, not to a path. `git pull` does not
#    rewrite a tracked file in place — it unlinks it and creates a new one — so
#    after a pull the host path is a new inode and the container is still
#    mounted on the old, unlinked one.
#
#    `caddy reload` re-reads /etc/caddy/Caddyfile FROM INSIDE THE CONTAINER,
#    which is the stale inode. Measured: it logs "adapted config to JSON",
#    exits 0, and serves the previous config. Reloading cannot fix this. The
#    container has to be RECREATED so the mount is resolved again.
#
#    And the reason this one reads as haunted rather than as a rule: an edit
#    that writes IN PLACE (`>`, `>>`, an editor that truncates and writes) keeps
#    the inode and DOES reach the container, so hand-editing the Caddyfile on
#    the box appears to work fine. Anything that REPLACES the file — git pull,
#    git checkout, `sed -i`, any editor that writes a temp file and renames it
#    over the target — does not. Both measured. Nothing in the shell shows you
#    which kind of write just happened.
#
# 2. The API's source is BAKED INTO THE IMAGE (Dockerfile:46,
#    `COPY backend/ /app/backend/`). `--force-recreate` recreates a container
#    from the image it already has; it never rebuilds one. After a pull the new
#    code is on the host and the image still holds the old, and compose happily
#    recreates the old code and prints "Started".
#
# The trap inside the trap: THE TWO NEED DIFFERENT VERBS AND NEITHER COVERS THE
# OTHER. `--force-recreate` alone fixes Caddy and misses the API. `--build`
# alone rebuilds the API and misses Caddy — it prints "Image Built" then
# "Container Running", because the Caddy image did not change, so nothing is
# recreated and the stale mount survives. Measured on this VM, Docker 29.7.2 /
# Compose v5.4.0.
#
# Hence: build the API, force-recreate Caddy, and then do not take compose's
# word for any of it — `verify` compares digests across the container boundary.
#
# ---------------------------------------------------------------------------
#   scripts/provision-vm.sh deploy          # pull already done; rebuild + recreate + verify
#   scripts/provision-vm.sh deploy --with-router
#   scripts/provision-vm.sh verify          # read-only; changes nothing
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Both files, in this order. compose.prod.yml is an overlay, not a replacement:
# on its own it has no build contexts, no healthchecks and no router.
COMPOSE=(docker compose -f docker-compose.yml -f compose.prod.yml)

# Docker 29 defaults to BuildKit, but the graphhopper image's GRAPH_SOURCE=none
# path quietly ships a staged graph under the classic builder — a 2.65 GB image
# instead of 520 MB. Stated rather than assumed, because the failure is silent.
export DOCKER_BUILDKIT=1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
[[ -t 1 ]] || { RED=; GREEN=; YELLOW=; DIM=; OFF=; }

say()  { printf '%s\n' "$*"; }
fail() { printf '%sFAIL%s %s\n' "$RED" "$OFF" "$*" >&2; }
ok()   { printf '%s ok %s %s\n' "$GREEN" "$OFF" "$*"; }
warn() { printf '%swarn%s %s\n' "$YELLOW" "$OFF" "$*"; }

# Container id for a compose service, or empty if it is not running. Resolved
# through compose rather than hardcoding `meander-caddy-1`, so this keeps
# working if the project name ever changes.
cid() { "${COMPOSE[@]}" ps -q "$1" 2>/dev/null | head -1; }

require_running() {
  local svc="$1"
  if [[ -z "$(cid "$svc")" ]]; then
    fail "service '$svc' is not running — start the stack first:"
    say  "     ${COMPOSE[*]} up -d"
    exit 1
  fi
}

# --------------------------------------------------------------------------
# verify — the only part of this script that can fail for the right reason.
#
# Compares what is on disk against what the running containers actually hold.
# A green `up -d` proves nothing: neither trap above turns anything red.
# --------------------------------------------------------------------------

# Digest of every shipped backend .py, normalised so the two sides are
# comparable. Only the hashes are folded together, never the paths, because the
# host sees `backend/x.py` and the container sees `/app/backend/x.py` — hashing
# the sha256sum output verbatim would differ on every file for no real reason.
# The exclusions mirror .dockerignore:17-20, which keeps tests, __pycache__ and
# the non-deploy requirements out of the image.
backend_tree_digest_host() {
  find backend -type f -name '*.py' \
    -not -path 'backend/tests/*' \
    -not -path '*/__pycache__/*' \
    | sort | xargs sha256sum | awk '{print $1}' | sha256sum | awk '{print $1}'
}

backend_tree_digest_container() {
  docker exec "$(cid api)" sh -c \
    "find /app/backend -type f -name '*.py' -not -path '*/__pycache__/*' \
     | sort | xargs sha256sum | awk '{print \$1}' | sha256sum" \
    | awk '{print $1}'
}

# Count as well as digest. Two empty file lists hash identically, so a digest
# comparison on its own passes loudest exactly when it is finding nothing —
# the same vacuous-guard shape this repo has already been bitten by once.
backend_file_count_host() {
  find backend -type f -name '*.py' \
    -not -path 'backend/tests/*' -not -path '*/__pycache__/*' | wc -l
}

backend_file_count_container() {
  docker exec "$(cid api)" sh -c \
    "find /app/backend -type f -name '*.py' -not -path '*/__pycache__/*' | wc -l"
}

verify() {
  require_running api
  require_running caddy

  local rc=0

  # -- Caddy: the bind-mounted Caddyfile ------------------------------------
  local host_caddy cntr_caddy
  host_caddy="$(sha256sum Caddyfile | awk '{print $1}')"
  cntr_caddy="$(docker exec "$(cid caddy)" sha256sum /etc/caddy/Caddyfile | awk '{print $1}')"

  if [[ "$host_caddy" == "$cntr_caddy" ]]; then
    ok "Caddyfile matches the running container  ${DIM}${host_caddy:0:16}${OFF}"
  else
    rc=1
    fail "Caddyfile on disk is NOT what Caddy is serving."
    say  "       host      ${host_caddy:0:16}"
    say  "       container ${cntr_caddy:0:16}"
    say  "     The container is mounted on the pre-pull inode. A reload will not"
    say  "     fix it and will exit 0. Recreate it:"
    say  "       ${COMPOSE[*]} up -d --force-recreate --no-deps caddy"
  fi

  # -- API: the source baked into the image ---------------------------------
  local n_host n_cntr host_tree cntr_tree
  n_host="$(backend_file_count_host)"
  n_cntr="$(backend_file_count_container)"

  if (( n_host == 0 || n_cntr == 0 )); then
    rc=1
    fail "found no backend .py files to compare (host=$n_host container=$n_cntr)."
    say  "     Refusing to report a match: two empty sets have the same digest."
  elif [[ "$n_host" != "$n_cntr" ]]; then
    rc=1
    fail "the image holds a different NUMBER of backend files than the tree does"
    say  "       host $n_host, container $n_cntr — rebuild, and if it persists,"
    say  "       check .dockerignore against this script's exclusions."
  else
    host_tree="$(backend_tree_digest_host)"
    cntr_tree="$(backend_tree_digest_container)"
    if [[ "$host_tree" == "$cntr_tree" ]]; then
      ok "backend/ matches the running image      ${DIM}${host_tree:0:16}${OFF} ($n_host files)"
    else
      rc=1
      fail "backend/ on disk is NOT the code the API is running."
      say  "       host      ${host_tree:0:16}"
      say  "       container ${cntr_tree:0:16}"
      say  "     --force-recreate will not fix this and will exit 0. Rebuild:"
      say  "       ${COMPOSE[*]} build api && ${COMPOSE[*]} up -d --no-deps api"
    fi
  fi

  if (( rc == 0 )); then
    say ""
    ok "the running deployment is the working tree."
  else
    say ""
    fail "the running deployment is NOT the working tree. See above."
  fi
  return $rc
}

# --------------------------------------------------------------------------
# deploy
# --------------------------------------------------------------------------

deploy() {
  local with_router=0
  for arg in "$@"; do
    case "$arg" in
      --with-router) with_router=1 ;;
      *) fail "unknown option: $arg"; exit 2 ;;
    esac
  done

  # This script deliberately does not run `git pull` for you. Pulling is a
  # decision (it can bring a Caddyfile change you have not read onto a public
  # TLS terminator); rebuilding is mechanical. Only the mechanical half is
  # automated here.
  say "${DIM}HEAD is $(git rev-parse --short HEAD) on $(git rev-parse --abbrev-ref HEAD)${OFF}"
  if [[ -n "$(git status --porcelain -- backend Caddyfile 2>/dev/null)" ]]; then
    warn "backend/ or Caddyfile has uncommitted changes — deploying them anyway."
  fi
  say ""

  require_running graphhopper

  # The router is NOT rebuilt or recreated by default, and this is the one
  # judgement call in the file. It loads a 485 MB graph into RAM at boot with a
  # 120 s healthcheck start_period, so recreating it is a multi-minute routing
  # outage. A backend or Caddyfile change cannot possibly require that.
  # --with-router is for when graphhopper/ or the staged graph actually changed.
  if (( with_router )); then
    warn "rebuilding the router. Expect a routing outage of a minute or more."
    "${COMPOSE[@]}" build graphhopper
    "${COMPOSE[@]}" up -d --force-recreate --no-deps graphhopper
    say ""
  fi

  # -- API: BUILD. The verb that --force-recreate is not. -------------------
  say "${DIM}› building the API image (the step --force-recreate skips)${OFF}"
  "${COMPOSE[@]}" build api

  # `up -d` after a build does recreate the container, because the image id it
  # resolves to has changed. --no-deps so this cannot decide to touch the
  # router on its way past.
  "${COMPOSE[@]}" up -d --no-deps api
  say ""

  # -- Caddy: RECREATE. The verb that `caddy reload` is not. ----------------
  # Unconditional, and cheap — Caddy starts in well under a second and holds no
  # state outside the caddy_data volume, which survives recreation. Doing it
  # every time costs nothing and removes the judgement call about whether the
  # Caddyfile "really" changed, which is precisely the judgement that goes
  # wrong when a pull touched it and nobody noticed.
  say "${DIM}› recreating Caddy (a reload would re-read the stale inode and exit 0)${OFF}"
  "${COMPOSE[@]}" up -d --force-recreate --no-deps caddy
  say ""

  # Compose has now exited 0 twice. That is not evidence.
  say "${DIM}› verifying, because both failure modes above exit 0${OFF}"
  verify
}

# Spelled out rather than sliced out of the header with `sed -n '2,52p'`, which
# is what this was and which silently reprinted the wrong thing the first time
# the header grew by a paragraph.
usage() {
  cat <<'EOF'
scripts/provision-vm.sh — redeploy this VM, and prove the redeploy landed.

  deploy [--with-router]   Rebuild the API image, recreate Caddy, then verify.
                           Does not run `git pull` for you, and leaves the
                           router alone unless --with-router is given, because
                           recreating it is a multi-minute routing outage.

  verify                   Compare the working tree against what the running
                           containers actually hold. Read-only. This is the
                           only honest answer to "did the deploy work?" —
                           both of the failure modes in this file's header
                           exit 0 and print success.

Two things that look like deploys and are not, both measured on this VM:
  · `caddy reload` after a `git pull` re-reads the pre-pull inode of the
    bind-mounted Caddyfile. Recreate the container instead.
  · `--force-recreate` never rebuilds an image, and the API's source is baked
    in at build time. `build api` is the verb.
Neither verb covers the other. See the header of this file for why.
EOF
}

case "${1:-}" in
  deploy) shift; deploy "$@" ;;
  verify) shift; verify ;;
  ""|-h|--help|help) usage ;;
  *) fail "unknown command: $1"; say ""; usage; exit 2 ;;
esac
