#!/usr/bin/env bash
# Every colour is declared once, in the two :root blocks.
#
# DESIGN-HANDOFF §2 requires it, which makes it a checkable property, so it is
# checked rather than trusted. A stray hex in a component rule is exactly the
# kind of thing that survives review and then breaks dark mode — it looks
# correct in whichever theme the author had open.
#
# This lived as inline awk in .github/workflows/ci.yml, which meant `make check`
# could not run it and the two could drift.
#
# ---------------------------------------------------------------------------
# It also could not fail.
#
# The pattern was `#[0-9a-fA-F]{3,8}\b`. `\b` is a GNU regex extension and means
# nothing in a POSIX awk ERE — it is not a word boundary there — so the whole
# alternation never matched an ordinary `color: #ff0000;`. Verified directly:
# a file containing exactly that passed the old gate with exit 0.
#
# So the check has been green in CI since it was written, on a codebase it was
# never actually reading. That is worse than having no gate: `make check`
# printed a pass, the workflow showed a tick, and the one rule the design system
# states most often had nothing behind it.
#
# Two changes follow from that. The pattern is fixed, and the gate now proves it
# can fail before it is allowed to pass — see `_self_test`. A colour gate that
# cannot fail is indistinguishable from a codebase with no hard-coded colours,
# and this repository has now been on the wrong side of that once.
# ---------------------------------------------------------------------------
#
# Exit 0 if clean, 1 with the offending lines on stderr otherwise.
set -euo pipefail

# A CSS hex colour is 3, 4, 6 or 8 digits and nothing else. Anchoring the length
# alternation longest-first and requiring a non-identifier terminator keeps two
# classes of false positive out:
#
#   #fade { }        an id selector made only of hex letters. Excluded by
#                    requiring a `:` earlier on the line, i.e. a declaration.
#   url(#gradient)   `g` is not a hex digit, so it never starts a match.
HEX='#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})([^0-9a-zA-Z_-]|$)'

_scan() {
    awk -v hex="$HEX" '
      /^:root \{|^\[data-theme=.dark.\] \{/ { inblock = 1 }
      inblock && /^\}/                      { inblock = 0; next }
      inblock                               { next }
      # Only declarations. A selector line has no colon before the brace, so an
      # id like `#fade {` is skipped while `color: #fade;` is not.
      !/:/                                  { next }
      $0 ~ hex                              { print FILENAME ":" NR ": " $0 }
    ' "$1"
}

# The gate has to demonstrate it still works before it is trusted to say a file
# is clean. Costs one temporary file and catches the exact failure this script
# was rewritten for.
_self_test() {
    local probe rc
    probe="$(mktemp -t palette_selftest.XXXXXX)"
    printf '.probe {\n  color: #ff0000;\n}\n' > "$probe"
    rc=0
    [ -n "$(_scan "$probe")" ] || rc=1
    rm -f "$probe"
    if [ "$rc" -ne 0 ]; then
        echo "check_palette: SELF-TEST FAILED — the gate did not flag a bare hex." >&2
        echo "  It is therefore not checking anything. Fix the pattern before trusting a pass." >&2
        return 1
    fi
}

main() {
    local target="${1:-frontend/src/styles.css}"

    if [ ! -f "$target" ]; then
        echo "check_palette: no such file: $target" >&2
        exit 1
    fi

    _self_test

    local offenders
    offenders="$(_scan "$target")"

    if [ -n "$offenders" ]; then
        echo "$offenders" >&2
        echo "Hard-coded colour outside the :root blocks. Add a token instead." >&2
        exit 1
    fi

    echo "every colour in $target is declared in the token blocks (gate self-tested)"
}

main "$@"
