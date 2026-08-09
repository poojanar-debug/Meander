#!/usr/bin/env bash
#
# Set up and run a self-hosted GraphHopper for Meander.
#
# The hosted free tier cannot run custom models, so the nature and accessible
# presets only work against a server you run yourself. This script downloads the
# OSM extracts, merges them into one graph, and starts the server.
#
#   scripts/graphhopper.sh setup [--region-set NAME]   download, merge, build
#   scripts/graphhopper.sh serve                       run the server on :8989
#   scripts/graphhopper.sh status                      is it up, and what does it know
#   scripts/graphhopper.sh regions                     what is currently built in
#   scripts/graphhopper.sh sets                        the available region sets
#
# **The region set decides what this costs to run.** It is the single largest
# cost in the project and it is entirely a function of how much of the planet
# you import:
#
#   demo       bounding boxes around the five TEST_LOCATIONS only, cut from
#              small Geofabrik sub-extracts. The default, and what a deployment
#              should use.
#   countries  Sri Lanka + the Netherlands + Great Britain entire. Full
#              coverage, and a graph that needs a large-memory machine.
#   custom     bboxes read from graphhopper/regions.custom
#
# Then point Meander at it, in .env:
#
#   MEANDER_GRAPHHOPPER_URL=http://localhost:8989/route
#   MEANDER_GRAPHHOPPER_SELF_HOSTED=1
#
# Requirements: a JDK 21+, osmium-tool, curl. `setup` checks for them and says
# exactly what to install if any are missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GH_DIR="$REPO_ROOT/graphhopper"
# Overridable so a second region set can be built and measured without
# destroying the graph a running server is using — build_graph starts with
# `rm -rf graph-cache`, and the container build wants its own directory too.
DATA_DIR="${GH_DATA_DIR:-$GH_DIR/data}"
GH_VERSION="11.0"
GH_JAR="$GH_DIR/graphhopper-web-${GH_VERSION}.jar"
MERGED="$DATA_DIR/meander-regions.osm.pbf"
CONFIG="$GH_DIR/config.yml"
PORT=8989

# Written only after an import returns 0. `serve` checks for this rather than
# for the directory: an interrupted import leaves a graph-cache/ that exists,
# passes a -d test, and then dies on load with an opaque error.
GRAPH_MARKER_NAME=".meander-graph-complete"

# Heap sizes. The graph is loaded into RAM (see graph.dataaccess in config.yml),
# so the server needs comfortably more heap than the graph is big — an 8 GB heap
# against a 6.6 GB graph dies with OutOfMemoryError during startup, *after* the
# import has already succeeded, which is a confusing place to fail.
#
# These defaults are sized for `demo`, which is what REGION_SET below defaults
# to. They used to be sized for `countries` instead — 24g/20g against a default
# region set that needs 8g/3g — so running the script with no arguments at all
# asked for a 24 GB heap, and on anything smaller the JVM refused to start with
# a message about the heap rather than about the region set. The 12 GB VM this
# is deployed on is exactly that case.
#
# Measured on the demo set, on the deployment VM: import 234 s at 8g, producing
# a 486 MB graph-cache. 3g serves it with room to spare — PROGRESS.md:1404 puts
# the floor at 2 GB and records that 1 GB OOMs.
#
# For `countries`, override both — that set is ~6.6 GB of graph and wants the
# old figures:
#   GH_IMPORT_HEAP=24g GH_HEAP=20g GH_REGION_SET=countries scripts/graphhopper.sh setup
IMPORT_HEAP="${GH_IMPORT_HEAP:-8g}"
SERVE_HEAP="${GH_HEAP:-3g}"

REGION_SET="${GH_REGION_SET:-demo}"

# ---------------------------------------------------------------------------
# region sets
# ---------------------------------------------------------------------------
#
# Each entry is "geofabrik/path|minlon,minlat,maxlon,maxlat" — an empty bbox
# means take the whole extract.
#
# The demo set cuts from the smallest Geofabrik sub-extract that contains each
# location rather than from the country, so the download is ~250 MB instead of
# ~3.5 GB before any bbox is applied. The boxes are +/-0.5 degrees, roughly
# 55 km, around each cluster:
#
#   Colombo Fort + Viharamahadevi Park   6.93,79.85 and 6.91,79.86
#   Hyde Park + Euston Road             51.51,-0.16 and 51.52,-0.14
#   Vondelpark                          52.36,4.86
#
# ⚠ 55 km is comfortable for every foot and bike budget and for a short drive.
# It is **not** enough for a 360-minute car route, which at the conservative
# 550 m/min in routing.py is a ~198 km radius. Outside the box GraphHopper says
# "Cannot find point", and backend/coverage.py turns that into "Meander does
# not cover that area yet" rather than a generic routing error.
# ⚠ Geofabrik's *sub*-region path for Britain is under `united-kingdom`, while
# the whole-country extract used by `countries` below is `great-britain`. Both
# are live; only one of them has an england/ beneath it. Getting this wrong does
# not 404 — Geofabrik serves a styled error page with **HTTP 200**, so `curl -f`
# succeeds and you get a 12 KB HTML file named .osm.pbf. See verify_extract().
demo_regions() {
  cat <<'EOF'
asia/sri-lanka|79.35,6.43,80.35,7.43
europe/united-kingdom/england/greater-london|-0.65,51.02,0.36,52.03
europe/netherlands/noord-holland|4.36,51.86,5.37,52.86
EOF
}

countries_regions() {
  cat <<'EOF'
asia/sri-lanka|
europe/netherlands|
europe/great-britain|
EOF
}

custom_regions() {
  local file="$GH_DIR/regions.custom"
  [ -f "$file" ] || {
    echo "No $file. Create it with one 'geofabrik/path|bbox' per line." >&2
    exit 1
  }
  grep -v '^\s*#' "$file" | grep -v '^\s*$'
}

regions_for_set() {
  case "$1" in
    demo)      demo_regions ;;
    countries) countries_regions ;;
    custom)    custom_regions ;;
    *) echo "Unknown region set '$1'. Try: demo, countries, custom" >&2; exit 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# tooling
# ---------------------------------------------------------------------------

# Returns the major version, or nothing at all if it cannot be determined.
#
# The previous sed assigned the *whole line* to `major` when the output did not
# match, so `[ "openjdk version ..." -lt 21 ]` failed with "integer expression
# expected" — which under `set -e` is a silent hard exit rather than an error
# anybody could act on.
java_major() {
  local raw ver major
  raw="$("$1" -version 2>&1 | head -1 || true)"

  # The version is the first double-quoted token:
  #   openjdk version "21.0.5" 2024-10-15   ->  21.0.5
  # Anchoring on the end of the line instead picks up the release date and
  # cheerfully reports Java 2024, which passes any >= 21 check ever written.
  ver="$(printf '%s' "$raw" | sed -nE 's/^[^"]*"([^"]+)".*$/\1/p')"
  [ -n "$ver" ] || ver="$raw"

  major="$(printf '%s' "$ver" | cut -d. -f1)"
  # Java 8 and earlier report 1.8.0_401; the meaningful number is the second.
  if [ "$major" = "1" ]; then
    major="$(printf '%s' "$ver" | cut -d. -f2)"
  fi

  case "$major" in
    ''|*[!0-9]*) return 1 ;;
    *) echo "$major" ;;
  esac
}

# Every place a JDK might be, most specific first. Not all of these exist.
java_candidates() {
  [ -n "${JAVA_HOME:-}" ] && echo "$JAVA_HOME/bin/java"
  cat <<'EOF'
/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java
/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home/bin/java
/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home/bin/java
/usr/lib/jvm/java-21-openjdk-amd64/bin/java
/usr/lib/jvm/java-21-openjdk-arm64/bin/java
/usr/lib/jvm/java-21-openjdk/bin/java
/usr/lib/jvm/java-21-amazon-corretto/bin/java
/usr/lib/jvm/java-21-amazon-corretto.x86_64/bin/java
/usr/lib/jvm/java-21-amazon-corretto.aarch64/bin/java
/usr/lib/jvm/temurin-21-jdk/bin/java
EOF
  # macOS's locator, and anything under the usual Linux roots, newest first.
  if [ -x /usr/libexec/java_home ]; then
    /usr/libexec/java_home -v 21 2>/dev/null | sed 's|$|/bin/java|' || true
  fi
  ls -d /usr/lib/jvm/*/bin/java /opt/java/*/bin/java 2>/dev/null | sort -r || true
  command -v java 2>/dev/null || true
}

# GraphHopper 11 needs a JDK 21+, and it is rarely on PATH.
#
# Two traps here, both found the hard way on real machines:
#
# * The previous version probed two Homebrew paths and exactly one Linux path
#   (/usr/lib/jvm/java-21-openjdk), which exists on almost no distribution this
#   will actually run on — Debian and Ubuntu use -openjdk-amd64/-openjdk-arm64,
#   Amazon Linux 2023 uses java-21-amazon-corretto.
#
# * **/usr/libexec/java_home -v 21 does not honour the version filter when
#   nothing matches.** On this machine, with only the Java 8 applet plugin
#   registered, `java_home -v 21` exits 0 and prints the Java 8 home. Trusting
#   it turned a working setup into "Java 8 is too old".
#
# So discovery *validates*: it returns the first candidate that is actually 21+.
# Only if none qualifies does it fall back to the first that exists at all, so
# require_tools can produce a useful "too old" message rather than "not found".
find_java() {
  local candidate first_existing="" major
  while read -r candidate; do
    [ -n "$candidate" ] || continue
    [ -x "$candidate" ] || continue
    [ -n "$first_existing" ] || first_existing="$candidate"
    if major="$(java_major "$candidate")" && [ "$major" -ge 21 ] 2>/dev/null; then
      echo "$candidate"; return
    fi
  done < <(java_candidates)
  [ -n "$first_existing" ] && echo "$first_existing"
}

require_tools() {
  local java missing=0 major
  java="$(find_java)"
  if [ -z "$java" ]; then
    echo "No Java found. Install a JDK 21+:" >&2
    echo "  macOS:         brew install openjdk@21" >&2
    echo "  Debian/Ubuntu: apt-get install -y openjdk-21-jdk-headless" >&2
    echo "  Amazon Linux:  dnf install -y java-21-amazon-corretto-headless" >&2
    missing=1
  elif major="$(java_major "$java")"; then
    if [ "$major" -lt 21 ]; then
      echo "Java $major at $java is too old; GraphHopper $GH_VERSION needs 21+." >&2
      missing=1
    fi
  else
    # Defensive rather than fatal: an unrecognised version banner is not proof
    # the JVM is wrong, and refusing to run on one would be worse than trying.
    echo "  note: could not parse the version of $java; continuing anyway." >&2
  fi

  command -v osmium >/dev/null || {
    echo "osmium-tool is needed to merge and cut the extracts:" >&2
    echo "  macOS:         brew install osmium-tool" >&2
    echo "  Debian/Ubuntu: apt-get install -y osmium-tool" >&2
    missing=1
  }
  [ "$missing" -eq 0 ] || exit 1
}

# ---------------------------------------------------------------------------
# download, verify, cut, merge
# ---------------------------------------------------------------------------

# Geofabrik publishes an .md5 next to every extract. Without checking it, any
# non-empty file counted as a complete download — so a truncated fetch produced
# a truncated extract, which merged fine, imported fine, and gave a graph with
# a hole in it that nothing would ever report.
verify_extract() {
  local file="$1" region="$2" want got

  # 1. Is it actually a PBF? This is the check that matters most, because the
  #    way this fails is not a 404. Geofabrik serves a styled error page with
  #    **HTTP 200** for a path that does not exist, so `curl -f` succeeds and
  #    leaves a 12 KB HTML document named .osm.pbf. It then survives the
  #    download step, survives the merge if you are unlucky, and finally dies
  #    inside osmium with "PBF error: invalid BlobHeader size" — three steps
  #    away from the wrong region name that caused it.
  #
  #    A PBF starts with a 4-byte big-endian header length followed by the
  #    literal "OSMHeader".
  if ! head -c 64 "$file" | grep -q "OSMHeader"; then
    echo "  NOT A PBF: $region" >&2
    if head -c 16 "$file" | grep -qi "<!DOCTYPE\|<html"; then
      echo "  The server returned an HTML page (Geofabrik answers 200 for an" >&2
      echo "  unknown region). The region path is almost certainly wrong:" >&2
      echo "    https://download.geofabrik.de/${region}-latest.osm.pbf" >&2
    fi
    rm -f "$file"
    return 1
  fi

  # 2. Is it complete? Geofabrik publishes an .md5 for every real extract, so a
  #    missing one is itself evidence the path is wrong — it is a failure, not
  #    a warning to step past.
  want="$(curl -fsSL "https://download.geofabrik.de/${region}-latest.osm.pbf.md5" 2>/dev/null \
          | awk '{print $1}' || true)"
  if [ -z "$want" ]; then
    echo "  NO PUBLISHED CHECKSUM for $region." >&2
    echo "  Geofabrik publishes one for every real extract, so this usually" >&2
    echo "  means the region path does not exist. Refusing to import it." >&2
    rm -f "$file"
    return 1
  fi

  if command -v md5sum >/dev/null; then
    got="$(md5sum "$file" | awk '{print $1}')"
  elif command -v md5 >/dev/null; then
    got="$(md5 -q "$file")"
  else
    echo "  No md5 tool available; the PBF header check above is all we have." >&2
    echo "  Install coreutils to verify completeness." >&2
    return 0
  fi

  if [ "$want" != "$got" ]; then
    echo "  CHECKSUM MISMATCH for $region — the download is incomplete or corrupt." >&2
    echo "  want $want" >&2
    echo "  got  $got" >&2
    rm -f "$file"
    return 1
  fi
  echo "  ok    $region (pbf, checksum matches)"
}

download_extracts() {
  mkdir -p "$DATA_DIR"
  local region bbox file
  while IFS='|' read -r region bbox; do
    [ -n "$region" ] || continue
    file="$DATA_DIR/$(echo "$region" | tr '/' '-')-latest.osm.pbf"
    if [ -s "$file" ] && [ -f "$file.verified" ]; then
      echo "  have  $(basename "$file")  ($(du -h "$file" | cut -f1))"
      continue
    fi
    echo "  fetch $(basename "$file") from Geofabrik…"
    curl -fL --progress-bar -o "$file" \
      "https://download.geofabrik.de/${region}-latest.osm.pbf"
    verify_extract "$file" "$region" || exit 1
    touch "$file.verified"
  done < <(regions_for_set "$REGION_SET")
}

cut_and_merge() {
  local inputs=() region bbox file cut
  while IFS='|' read -r region bbox; do
    [ -n "$region" ] || continue
    file="$DATA_DIR/$(echo "$region" | tr '/' '-')-latest.osm.pbf"
    if [ -n "$bbox" ]; then
      cut="$DATA_DIR/$(echo "$region" | tr '/' '-')-cut.osm.pbf"
      echo "  cut   $(basename "$file") to $bbox…"
      osmium extract --overwrite --bbox "$bbox" -o "$cut" "$file"
      echo "        -> $(du -h "$cut" | cut -f1)"
      inputs+=("$cut")
    else
      inputs+=("$file")
    fi
  done < <(regions_for_set "$REGION_SET")

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
  local java started elapsed
  java="$(find_java)"
  rm -rf "$DATA_DIR/graph-cache"
  echo "  building the routing graph — this is the slow part…"
  started="$(date +%s)"
  # graph.location and the SRTM cache are passed explicitly rather than left to
  # the relative paths in config.yml, so GH_DATA_DIR actually redirects them.
  ( cd "$GH_DIR" && "$java" -Xmx"$IMPORT_HEAP" -Xms4g \
      -Ddw.graphhopper.datareader.file="$MERGED" \
      -Ddw.graphhopper.graph.location="$DATA_DIR/graph-cache" \
      -Ddw.graphhopper.graph.elevation.cache_dir="$DATA_DIR/srtm" \
      -jar "$GH_JAR" import "$CONFIG" )
  elapsed=$(( $(date +%s) - started ))

  # Only now, and only because the import returned 0.
  cat > "$DATA_DIR/graph-cache/$GRAPH_MARKER_NAME" <<EOF
region_set=$REGION_SET
graphhopper=$GH_VERSION
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
import_seconds=$elapsed
import_heap=$IMPORT_HEAP
EOF
  echo
  echo "  graph:  $(du -sh "$DATA_DIR/graph-cache" | cut -f1)"
  echo "  import: ${elapsed}s with a $IMPORT_HEAP heap"
}

# ---------------------------------------------------------------------------

case "${1:-}" in
  setup)
    shift || true
    while [ $# -gt 0 ]; do
      case "$1" in
        --region-set) REGION_SET="${2:?--region-set needs a name}"; shift 2 ;;
        --region-set=*) REGION_SET="${1#*=}"; shift ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
      esac
    done
    regions_for_set "$REGION_SET" >/dev/null   # fail fast on a bad name
    echo "  region set: $REGION_SET"
    require_tools
    [ -f "$GH_JAR" ] || {
      echo "  fetching GraphHopper $GH_VERSION…"
      curl -fL --progress-bar -o "$GH_JAR" \
        "https://repo1.maven.org/maven2/com/graphhopper/graphhopper-web/${GH_VERSION}/graphhopper-web-${GH_VERSION}.jar"
    }
    download_extracts
    cut_and_merge
    build_graph
    echo
    echo "Done. Start it with:  scripts/graphhopper.sh serve"
    echo "Then add to .env:     MEANDER_GRAPHHOPPER_URL=http://localhost:$PORT/route"
    echo "                      MEANDER_GRAPHHOPPER_SELF_HOSTED=1"
    ;;

  serve)
    require_tools
    [ -f "$DATA_DIR/graph-cache/$GRAPH_MARKER_NAME" ] || {
      if [ -d "$DATA_DIR/graph-cache" ]; then
        echo "The graph in $DATA_DIR/graph-cache is incomplete — an import was" >&2
        echo "interrupted. It would load with an opaque error. Re-run:" >&2
      else
        echo "No graph built yet. Run:" >&2
      fi
      echo "  scripts/graphhopper.sh setup --region-set $REGION_SET" >&2
      exit 1
    }
    local_java="$(find_java)"
    cd "$GH_DIR"
    echo "  serving with a ${SERVE_HEAP} heap (graph is $(du -sh "$DATA_DIR/graph-cache" | cut -f1))"
    sed 's/^/  /' "$DATA_DIR/graph-cache/$GRAPH_MARKER_NAME"
    exec "$local_java" -Xmx"$SERVE_HEAP" -Xms2g \
      -Ddw.graphhopper.graph.location="$DATA_DIR/graph-cache" \
      -Ddw.graphhopper.graph.elevation.cache_dir="$DATA_DIR/srtm" \
      -jar "$GH_JAR" server "$CONFIG"
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
    if [ -f "$DATA_DIR/graph-cache/$GRAPH_MARKER_NAME" ]; then
      echo "  built graph:"
      sed 's/^/    /' "$DATA_DIR/graph-cache/$GRAPH_MARKER_NAME"
      echo
    fi
    echo "  region set '$REGION_SET' covers:"
    regions_for_set "$REGION_SET" | sed 's/^/    /'
    ;;

  sets)
    echo "  demo       bboxes around the five TEST_LOCATIONS (default; use this to deploy)"
    demo_regions | sed 's/^/               /'
    echo "  countries  Sri Lanka + Netherlands + Great Britain entire"
    countries_regions | sed 's/^/               /'
    echo "  custom     read from graphhopper/regions.custom"
    ;;

  *)
    sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
