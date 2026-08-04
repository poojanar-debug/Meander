#!/usr/bin/env bash
#
# Set up and run a self-hosted GraphHopper for Meander.
#
# The hosted free tier cannot run custom models, so the nature and accessible
# presets only work against a server you run yourself. This script downloads
# the OSM extracts, merges them into one graph, and starts the server.
#
#   scripts/graphhopper.sh setup     download extracts, merge, build the graph
#   scripts/graphhopper.sh serve     run the server on :8989
#   scripts/graphhopper.sh status    is it up, and what does it know about
#   scripts/graphhopper.sh regions   list the regions currently built in
#
# Then point Meander at it, in .env:
#
#   MEANDER_GRAPHHOPPER_URL=http://localhost:8989/route
#
# Requirements: a JDK 21+, osmium-tool, curl. `setup` checks for them and says
# exactly what to install if any are missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_DIR="$REPO_ROOT/graphhopper"
DATA_DIR="$GH_DIR/data"
GH_VERSION="11.0"
GH_JAR="$GH_DIR/graphhopper-web-${GH_VERSION}.jar"
MERGED="$DATA_DIR/meander-regions.osm.pbf"
CONFIG="$GH_DIR/config.yml"
PORT=8989

# Regions to import, as Geofabrik paths. Add a line and re-run `setup` to widen
# coverage; only places inside these extracts can be routed.
REGIONS=(
  "asia/sri-lanka"
  "europe/netherlands"
  "europe/great-britain"
)

# GraphHopper 11 needs a JDK 21+. Homebrew's is not on PATH by default.
find_java() {
  if [ -n "${JAVA_HOME:-}" ] && [ -x "$JAVA_HOME/bin/java" ]; then
    echo "$JAVA_HOME/bin/java"; return
  fi
  for candidate in \
    /opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java \
    /opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java \
    /usr/lib/jvm/java-21-openjdk/bin/java; do
    [ -x "$candidate" ] && { echo "$candidate"; return; }
  done
  command -v java || true
}

require_tools() {
  local java missing=0
  java="$(find_java)"
  if [ -z "$java" ]; then
    echo "No Java found. Install one:  brew install openjdk@21" >&2
    missing=1
  else
    local major
    major="$("$java" -version 2>&1 | head -1 | sed -E 's/.*"([0-9]+).*/\1/')"
    if [ "${major:-0}" -lt 21 ]; then
      echo "Java $major is too old; GraphHopper $GH_VERSION needs 21+." >&2
      echo "  brew install openjdk@21" >&2
      missing=1
    fi
  fi
  command -v osmium >/dev/null || {
    echo "osmium-tool is needed to merge the extracts:  brew install osmium-tool" >&2
    missing=1
  }
  [ "$missing" -eq 0 ] || exit 1
}

download_extracts() {
  mkdir -p "$DATA_DIR"
  for region in "${REGIONS[@]}"; do
    local file="$DATA_DIR/$(basename "$region")-latest.osm.pbf"
    if [ -s "$file" ]; then
      echo "  have  $(basename "$file")  ($(du -h "$file" | cut -f1))"
      continue
    fi
    echo "  fetch $(basename "$file") from Geofabrik…"
    curl -fL --progress-bar -o "$file" \
      "https://download.geofabrik.de/${region}-latest.osm.pbf"
  done
}

merge_extracts() {
  local inputs=()
  for region in "${REGIONS[@]}"; do
    inputs+=("$DATA_DIR/$(basename "$region")-latest.osm.pbf")
  done

  if [ "${#inputs[@]}" -eq 1 ]; then
    cp -f "${inputs[0]}" "$MERGED"
  else
    # One GraphHopper graph is built from one file, so the extracts are merged
    # rather than run as several servers — that keeps a single endpoint and
    # means the app needs no routing-by-region logic.
    echo "  merging ${#inputs[@]} extracts into $(basename "$MERGED")…"
    osmium merge --overwrite -o "$MERGED" "${inputs[@]}"
  fi
  echo "  merged: $(du -h "$MERGED" | cut -f1)"
}

build_graph() {
  local java; java="$(find_java)"
  rm -rf "$DATA_DIR/graph-cache"
  echo "  building the routing graph — this is the slow part…"
  ( cd "$GH_DIR" && "$java" -Xmx12g -Xms4g \
      -Ddw.graphhopper.datareader.file="data/$(basename "$MERGED")" \
      -jar "$GH_JAR" import "$CONFIG" )
}

case "${1:-}" in
  setup)
    require_tools
    [ -f "$GH_JAR" ] || {
      echo "  fetching GraphHopper $GH_VERSION…"
      curl -fL --progress-bar -o "$GH_JAR" \
        "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar"
    }
    download_extracts
    merge_extracts
    build_graph
    echo
    echo "Done. Start it with:  scripts/graphhopper.sh serve"
    echo "Then add to .env:     MEANDER_GRAPHHOPPER_URL=http://localhost:$PORT/route"
    ;;

  serve)
    require_tools
    [ -d "$DATA_DIR/graph-cache" ] || {
      echo "No graph built yet. Run:  scripts/graphhopper.sh setup" >&2; exit 1; }
    local_java="$(find_java)"
    cd "$GH_DIR"
    exec "$local_java" -Xmx8g -Xms2g -jar "$GH_JAR" server "$CONFIG"
    ;;

  status)
    if curl -sf "http://localhost:$PORT/health" >/dev/null 2>&1; then
      echo "  up on :$PORT"
      curl -s "http://localhost:$PORT/info" | python3 -m json.tool | head -20
    else
      echo "  not running on :$PORT"
      exit 1
    fi
    ;;

  regions)
    printf '  %s\n' "${REGIONS[@]}"
    ;;

  *)
    sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
