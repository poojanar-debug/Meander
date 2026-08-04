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

FROM eclipse-temurin:21-jre-noble AS runtime

ARG GH_VERSION=11.0
ARG GRAPH_SOURCE=none

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

# Optional bake-in. The build context must contain graphhopper/graph-dist/ with
# a completed graph-cache/ in it; see scripts/publish_graph.sh. With
# GRAPH_SOURCE=none this copies the placeholder and the entrypoint fetches
# instead. (A COPY of a missing path fails the build, hence the placeholder.)
COPY graphhopper/graph-dist/ /graph-dist/
RUN if [ "$GRAPH_SOURCE" = "local" ]; then \
      test -f "/graph-dist/graph-cache/${GRAPH_MARKER}" || { \
        echo "GRAPH_SOURCE=local but /graph-dist/graph-cache/${GRAPH_MARKER} is missing." >&2; \
        echo "That marker is written only by a completed import — an interrupted" >&2; \
        echo "one leaves a directory that exists and then dies on load." >&2; \
        exit 1; } ; \
      mkdir -p "$GH_DATA" && cp -a /graph-dist/graph-cache "$GH_DATA/graph-cache" ; \
      echo "graph baked in: $(du -sh "$GH_DATA/graph-cache" | cut -f1)" ; \
    fi \
 && rm -rf /graph-dist

# Unprivileged, and it owns /data because the entrypoint may unpack into it.
RUN useradd --system --uid 10001 --create-home gh \
 && mkdir -p "$GH_DATA" && chown -R gh:gh "$GH_DATA" /app
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
