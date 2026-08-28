#!/usr/bin/env bash
#
# Turn a built graph into a deployable artifact.
#
#   scripts/publish_graph.sh --local
#       stage it at graphhopper/graph-dist/ so the router image can bake it in
#       with --build-arg GRAPH_SOURCE=local. Right at demo scale; at 13 GB the
#       bake wants five concurrent copies of the graph on the build machine
#       (staging, context store, layer, snapshot, and the build dir itself),
#       which is how the production deploy filled its disk twice. Use --dir.
#
#   scripts/publish_graph.sh --dir /home/ubuntu/meander-graph
#       stage it where compose.prod.yml bind-mounts the router's /data from —
#       one copy, outside every build context. Staged beside the live one and
#       swapped with two renames, so the serving graph is never half-copied.
#
#   scripts/publish_graph.sh --s3 s3://bucket/graph-demo.tar.zst
#       compress, checksum and upload, then print the two environment variables
#       the container needs
#
# The graph is a **build artifact**, not a runtime step. An import is 96 s for
# the demo region set and about 31 minutes for countries; doing either inside a
# container start means every container replacement is an outage of that
# length, and any supervisor with a startup health deadline would kill the
# container long before the second one finished.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_DIR="$REPO_ROOT/graphhopper"
DATA_DIR="${GH_DATA_DIR:-$GH_DIR/data}"
GRAPH_DIR="$DATA_DIR/graph-cache"
MARKER=".meander-graph-complete"
DIST="$GH_DIR/graph-dist"

# The marker, not the directory. An interrupted import leaves a graph-cache/
# that exists and then dies on load with an opaque error, and publishing one of
# those turns a local annoyance into a deployment that crash-loops.
[ -f "$GRAPH_DIR/$MARKER" ] || {
  echo "No completed graph at $GRAPH_DIR." >&2
  echo "Build one:  scripts/graphhopper.sh setup --region-set demo" >&2
  exit 1
}

echo "graph: $(du -sh "$GRAPH_DIR" | cut -f1)"
sed 's/^/  /' "$GRAPH_DIR/$MARKER"

case "${1:-}" in
  --local)
    rm -rf "$DIST"
    mkdir -p "$DIST"
    cp -a "$GRAPH_DIR" "$DIST/graph-cache"
    echo
    echo "Staged at graphhopper/graph-dist/. Now:"
    echo "  docker build --build-arg GRAPH_SOURCE=local -f graphhopper/Dockerfile -t meander-graphhopper ."
    ;;

  --dir)
    dest="${2:?--dir needs the host directory compose mounts at /data}"
    mkdir -p "$dest"
    # Beside, then rename. A cp straight onto the live path would leave the
    # router's next restart a half-copied graph with a valid-looking
    # directory; the marker guard would catch it, but "the router refuses to
    # start" is still an outage this two-rename swap simply does not have.
    rm -rf "$dest/graph-cache.next"
    cp -a "$GRAPH_DIR" "$dest/graph-cache.next"
    rm -rf "$dest/graph-cache.prev"
    [ -d "$dest/graph-cache" ] && mv "$dest/graph-cache" "$dest/graph-cache.prev"
    mv "$dest/graph-cache.next" "$dest/graph-cache"
    echo
    echo "Staged at $dest/graph-cache (previous kept at graph-cache.prev)."
    echo "The container runs as uid 10001 and writes its runtime config into"
    echo "the mount, so once, and after any stage that created the directory:"
    echo "  sudo chown -R 10001:10001 $dest"
    echo "Then recreate the router:"
    echo "  docker compose -f docker-compose.yml -f compose.prod.yml up -d --force-recreate --no-deps graphhopper"
    ;;

  --s3)
    dest="${2:?--s3 needs a s3:// URI}"
    command -v zstd >/dev/null || { echo "zstd is needed:  brew install zstd" >&2; exit 1; }
    command -v aws  >/dev/null || { echo "the AWS CLI is needed for --s3" >&2; exit 1; }

    tmp="$(mktemp -d)"
    archive="$tmp/graph.tar.zst"
    echo "  compressing…"
    tar -C "$DATA_DIR" -cf - graph-cache | zstd -T0 -19 -o "$archive"
    echo "  archive: $(du -h "$archive" | cut -f1)"

    if command -v sha256sum >/dev/null; then
      digest="$(sha256sum "$archive" | awk '{print $1}')"
    else
      digest="$(shasum -a 256 "$archive" | awk '{print $1}')"
    fi

    aws s3 cp "$archive" "$dest"
    rm -rf "$tmp"

    echo
    echo "Published. The router container needs both of these — the digest is"
    echo "not optional, because an unverified partial download unpacks into a"
    echo "graph-cache that exists and then fails on load:"
    echo
    echo "  GRAPH_S3_URI=$dest"
    echo "  GRAPH_SHA256=$digest"
    ;;

  *)
    # Found rather than hardcoded: the last `sed -n '2,18p'` here truncated
    # the moment --dir grew the header, which is the same silent wrong-output
    # failure provision-vm.sh and graphhopper.sh both already document.
    awk 'NR < 2 { next } /^$/ { exit } { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
    exit 1
    ;;
esac
