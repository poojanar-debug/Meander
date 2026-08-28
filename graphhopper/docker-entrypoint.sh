#!/usr/bin/env bash
#
# Serve a **pre-built** graph. This never imports.
#
# An import is 96 s for the demo region set and 31 minutes for countries. Either
# way it is a build step, not a boot step: ECS would kill the task long before
# the second finished, and every task replacement would be an outage for the
# length of the first.
#
# The graph arrives one of two ways:
#   baked into the image   (GRAPH_SOURCE=local at build time — preferred)
#   fetched once at start  (GRAPH_S3_URI, verified against GRAPH_SHA256)

set -euo pipefail

GH_DATA="${GH_DATA:-/data}"
GH_HEAP="${GH_HEAP:-3g}"
# Unset means config.yml's RAM_STORE, which loads the whole graph into heap and
# is right for a demo-sized graph. MMAP_STORE pages the graph from disk on
# demand, which is what lets the 60-region custom graph run in the same
# container that used to hold 623 MB — the heap arithmetic is in
# scripts/graphhopper.sh next to GH_DATAACCESS, and compose.prod.yml sets this
# explicitly for the deployment.
GH_DATAACCESS="${GH_DATAACCESS:-}"
GRAPH_MARKER="${GRAPH_MARKER:-.meander-graph-complete}"
GRAPH_DIR="$GH_DATA/graph-cache"
CONFIG_SRC="/app/config.yml"
CONFIG="$GH_DATA/config.runtime.yml"

# ---------------------------------------------------------------------------
# the graph
# ---------------------------------------------------------------------------

if [ -f "$GRAPH_DIR/$GRAPH_MARKER" ]; then
  echo "graph: already present ($(du -sh "$GRAPH_DIR" | cut -f1))"
  sed 's/^/  /' "$GRAPH_DIR/$GRAPH_MARKER"

elif [ -n "${GRAPH_S3_URI:-}" ]; then
  echo "graph: fetching $GRAPH_S3_URI"
  archive="$GH_DATA/graph.tar.zst"

  if command -v aws >/dev/null; then
    aws s3 cp "$GRAPH_S3_URI" "$archive"
  else
    # No AWS CLI in the image; a presigned https URL works with plain curl.
    curl -fL --retry 3 -o "$archive" "$GRAPH_S3_URI"
  fi

  # Verified before it is unpacked, not after. An interrupted download that is
  # merely *unpacked* produces a graph-cache directory that exists, passes any
  # -d test, and then dies on load with an error about a missing file — the
  # exact failure the completion marker exists to prevent.
  if [ -n "${GRAPH_SHA256:-}" ]; then
    echo "$GRAPH_SHA256  $archive" | sha256sum -c - || {
      echo "GRAPH DIGEST MISMATCH — refusing to unpack a corrupt graph." >&2
      exit 1
    }
  else
    echo "  warn: GRAPH_SHA256 is unset, so the download is unverified." >&2
  fi

  mkdir -p "$GH_DATA"
  tar --use-compress-program=unzstd -xf "$archive" -C "$GH_DATA"
  rm -f "$archive"

  [ -f "$GRAPH_DIR/$GRAPH_MARKER" ] || {
    echo "The archive unpacked but has no $GRAPH_MARKER." >&2
    echo "That marker is written only by a completed import, so this archive" >&2
    echo "was built from an interrupted one. Refusing to serve it." >&2
    exit 1
  }
  echo "graph: unpacked ($(du -sh "$GRAPH_DIR" | cut -f1))"

else
  cat >&2 <<'EOF'
No graph, and no GRAPH_S3_URI to fetch one from.

This image never imports — that is a build step. Either:

  build with the graph baked in (right at demo scale, wrong past a few GB —
  a baked graph exists five times over on the build machine's disk)
    scripts/graphhopper.sh setup --region-set demo
    scripts/publish_graph.sh --local
    docker build --build-arg GRAPH_SOURCE=local -f graphhopper/Dockerfile .

  or mount one — what the single-VM production deployment does
    scripts/publish_graph.sh --dir /home/ubuntu/meander-graph
    docker run -v /home/ubuntu/meander-graph:/data ...   # see compose.prod.yml

  or publish it and point the container at it
    scripts/publish_graph.sh --s3 s3://your-bucket/graph-demo.tar.zst
    docker run -e GRAPH_S3_URI=... -e GRAPH_SHA256=... ...
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# bind addresses
# ---------------------------------------------------------------------------
#
# config.yml binds 127.0.0.1 on both connectors, which is right on a laptop and
# makes both ports unreachable inside a container — including 8990, which is
# where the health check lives, so it could never pass.
#
# The network boundary here is the security group, not the bind address: Phase 4
# puts this in a private subnet whose only ingress rule admits the API's
# security group on 8989. Rewritten at runtime rather than in the file so a
# local `scripts/graphhopper.sh serve` keeps its loopback-only default.
sed 's/bind_host: 127\.0\.0\.1/bind_host: 0.0.0.0/' "$CONFIG_SRC" > "$CONFIG"
echo "bind: 0.0.0.0 (was 127.0.0.1 — see the comment in this entrypoint)"

# Same mechanism, same reason, for the storage mode. A
# -Ddw.graphhopper.graph.dataaccess.default_type flag is accepted by the JVM
# and silently ignored (measured — see the key's comment in config.yml), so
# the override has to be the config itself. The grep is the difference between
# an override and a hope: if the key ever leaves config.yml, this container
# refuses to start rather than serve a 6+ GB graph RAM_STORE into a 4 GB heap
# and die minutes later with an OutOfMemoryError that looks like a leak.
if [ -n "$GH_DATAACCESS" ]; then
  sed -i "s/^  graph\.dataaccess\.default_type:.*/  graph.dataaccess.default_type: $GH_DATAACCESS/" "$CONFIG"
  grep -q "^  graph\.dataaccess\.default_type: $GH_DATAACCESS\$" "$CONFIG" || {
    echo "config.yml no longer carries graph.dataaccess.default_type, so" >&2
    echo "GH_DATAACCESS=$GH_DATAACCESS would silently do nothing. Refusing." >&2
    exit 1
  }
  echo "dataaccess: $GH_DATAACCESS (rewritten into the runtime config)"
fi

exec java \
  -Xmx"$GH_HEAP" \
  -Xms512m \
  -XX:+ExitOnOutOfMemoryError \
  -Ddw.graphhopper.graph.location="$GRAPH_DIR" \
  -Ddw.graphhopper.graph.elevation.cache_dir="$GH_DATA/srtm" \
  -jar /app/graphhopper-web.jar server "$CONFIG"
