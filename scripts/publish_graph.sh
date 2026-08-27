#!/usr/bin/env bash
#
# Turn a built graph into a deployable artifact.
#
#   scripts/publish_graph.sh --local
#       stage it at graphhopper/graph-dist/ so the router image can bake it in
#       with --build-arg GRAPH_SOURCE=local
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
    sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
