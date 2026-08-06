# Meander's routing server.
#
# **This image never imports a graph.** A 31-minute import inside a container
# start is not a deployment — it is a 31-minute outage on every task
# replacement, and ECS would kill the task long before it finished. The graph is
# a build artifact: built by scripts/graphhopper.sh, published, and either baked
# in at build time (GRAPH_SOURCE=local, which is what the demo region set makes
# possible) or fetched once at startup from S3.
#
#   # bake the demo graph in — preferred, and the strongest argument for demo
#   docker build --platform=linux/arm64 \
#     --build-arg GRAPH_SOURCE=local \
#     -f graphhopper/Dockerfile -t meander-graphhopper .
#
#   # or fetch at startup
#   docker run -e GRAPH_S3_URI=s3://bucket/graph-demo.tar.zst \
#              -e GRAPH_SHA256=<digest> meander-graphhopper

# Declared before the first FROM so it can select a stage further down. Needs
# BuildKit — `docker buildx build`, or DOCKER_BUILDKIT=1 — because only BuildKit
# builds the selected stage alone. The classic builder produces the same final
# image but walks every stage on the way, which means copying the graph even
# when the build asked for none.
ARG GRAPH_SOURCE=none

FROM eclipse-temurin:21-jre-noble AS runtime

ARG GH_VERSION=11.0

ENV GH_VERSION=${GH_VERSION} \
    GH_DATA=/data \
    GH_HEAP=3g \
    GRAPH_MARKER=.meander-graph-complete

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl zstd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The JAR, verified. scripts/graphhopper.sh used to treat any non-empty file as
# a complete download; a truncated fetch here would fail at a much less obvious
# moment.
RUN curl -fL --retry 3 -o graphhopper-web.jar \
      "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar" \
 && curl -fsSL -o graphhopper-web.jar.sha1 \
      "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar.sha1" \
 && echo "$(cat graphhopper-web.jar.sha1)  graphhopper-web.jar" | sha1sum -c - \
 && rm graphhopper-web.jar.sha1

COPY graphhopper/config.yml /app/config.yml
COPY graphhopper/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Unprivileged, and it owns /data because the entrypoint may unpack into it.
#
# **Before the graph arrives, not after.** This block used to sit below the
# COPY and ended with `chown -R gh:gh "$GH_DATA"`, which rewrites the metadata
# of every file in the graph — and because layers are copy-on-write per file,
# that duplicated all 485 MB again in a new layer. /app is left root-owned:
# `gh` only ever reads the JAR and the config, and chowning 47 MB of JAR would
# have cost another copy for nothing.
RUN useradd --system --uid 10001 --create-home gh \
 && mkdir -p "$GH_DATA" && chown gh:gh "$GH_DATA"

# --- the graph, or not --------------------------------------------------
#
# Two stages, selected by GRAPH_SOURCE. A `COPY` cannot be made conditional
# any other way, and the previous attempt — copy always, then `cp -a` into
# place if asked — put the graph in the image **three** times: once in the
# COPY layer, once in the RUN that copied it, and once more when a later
# `chown -R` rewrote every file's metadata (layers are copy-on-write per
# file). Deleting the staging directory afterwards only writes a whiteout;
# the bytes stay in the layer below. A 485 MB graph made a 2.65 GB image.
#
# Now it lands once, in its final home, already owned by `gh`: 1.1 GB. That is
# 1.5 GB less to hold in ECR and 1.5 GB less to pull on every task start,
# which is time a task spends not serving.

FROM runtime AS graph-none
# Nothing. The entrypoint fetches from GRAPH_S3_URI, or refuses to start and
# says how to give it a graph.

FROM runtime AS graph-local
# The build context must contain graphhopper/graph-dist/graph-cache — see
# scripts/publish_graph.sh --local.
COPY --chown=gh:gh graphhopper/graph-dist/ /data/
# Read-only, so it adds no meaningful layer. Asserts on the marker rather than
# on the directory: an interrupted import leaves a graph-cache/ that exists,
# passes any -d test, and then dies on load with an opaque error.
RUN test -f "${GH_DATA}/graph-cache/${GRAPH_MARKER}" || { \
      echo "GRAPH_SOURCE=local but ${GH_DATA}/graph-cache/${GRAPH_MARKER} is missing." >&2; \
      echo "That marker is written only by a completed import." >&2; \
      echo "Run scripts/publish_graph.sh --local first." >&2; \
      exit 1; } \
 && echo "graph baked in: $(du -sh "${GH_DATA}/graph-cache" | cut -f1)"

FROM graph-${GRAPH_SOURCE} AS final

USER gh

# 8989 routing, 8990 admin. config.yml binds 127.0.0.1 for a laptop; inside a
# container that would make the port unreachable from anywhere, including the
# health check, so the entrypoint rewrites both to 0.0.0.0. The network boundary
# here is the security group, not the bind address — and Phase 4 puts this in a
# private subnet that admits only the API's security group.
EXPOSE 8989 8990

# Against the admin connector, which answers without touching the router.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=4 \
  CMD curl -fsS http://127.0.0.1:8990/healthcheck || exit 1

ENTRYPOINT ["/app/entrypoint.sh"]
