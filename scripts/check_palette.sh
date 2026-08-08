#!/usr/bin/env bash
# Every colour is declared once, in the two :root blocks.
#
# DESIGN-HANDOFF §2 requires it, which makes it a checkable property, so it is
# checked rather than trusted. A stray hex in a component rule is exactly the
# kind of thing that survives review and then breaks dark mode — it looks
# correct in whichever theme the author had open.
#
# This lived as inline awk in .github/workflows/ci.yml, which meant `make check`
# could not run it and the two could drift. They did: the Makefile went on
# claiming to be "the whole of CI" while three jobs sat outside it. Extracted
# here so CI and the Makefile run the same code by construction.
#
# Exit 0 if clean, 1 with the offending lines on stderr otherwise.
set -euo pipefail

target="${1:-frontend/src/styles.css}"

if [ ! -f "$target" ]; then
    echo "check_palette: no such file: $target" >&2
    exit 1
fi

offenders=$(awk '
  /^:root \{|^\[data-theme=.dark.\] \{/ { inblock = 1 }
  inblock && /^\}/                      { inblock = 0; next }
  !inblock && /#[0-9a-fA-F]{3,8}\b/     { print FILENAME ":" NR ": " $0 }
' "$target")

if [ -n "$offenders" ]; then
    echo "$offenders" >&2
    echo "Hard-coded colour outside the :root blocks. Add a token instead." >&2
    exit 1
fi

echo "every colour in $target is declared in the token blocks"
