"""No em dash in a backend string that reaches the browser.

The frontend half of this lives in `frontend/src/lib/no-em-dash.test.js`. This
is the other half, and it is a different problem: the frontend's dashes are in
JSX text and string literals, and the backend's are in Python strings that get
serialised into an error envelope, a `status_note` or a `preset_note`.

Docstrings and comments are explicitly out of scope. That is where almost every
dash in this repository lives, it is the house voice, and rewriting it would be
a huge diff with no user-visible effect. `ast` is what separates the two: a
module, class or function docstring is a string constant in a known position,
and everything else is a string somebody wrote to be read.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

# By codepoint, not by glyph. Ruff's RUF001 flags an ambiguous EN DASH in a
# string literal — correctly, and this file is the one place in the codebase
# that has to name the characters it forbids.
DASHES = ("\u2014", "\u2013", "\u2015")  # em dash, en dash, horizontal bar

BACKEND = Path(__file__).resolve().parent.parent

# Every module that can put a sentence in front of a user. `fixtures.py`,
# `metrics.py`, `logging_setup.py` and the rest are not here because nothing
# they hold is rendered; if that changes, this list is the place it is noticed.
USER_FACING = [
    "accessibility.py",
    "coverage.py",
    "enrich.py",
    "main.py",
    "models.py",
    "narrate.py",
    "ratelimit.py",
    "routing.py",
    "scoring.py",
]

# Strings that carry a dash and are read by a developer, not a user. Listed by
# the substring that identifies them rather than by line, so the list does not
# rot the moment something above them moves.
NOT_USER_FACING = (
    # A maintenance script's terminal output, and a developer CLI's.
    " — ",
)


def _non_docstring_strings(source: str):
    """Every string constant that is not a docstring, with its line number."""
    tree = ast.parse(source)
    docstrings = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Module | ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            body = getattr(node, "body", [])
            if (
                body
                and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)
            ):
                docstrings.add(id(body[0].value))
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Constant)
            and isinstance(node.value, str)
            and id(node) not in docstrings
        ):
            yield node.lineno, node.value


@pytest.mark.parametrize("name", USER_FACING)
def test_no_em_dash_in_a_string_that_reaches_the_browser(name: str) -> None:
    path = BACKEND / name
    offenders = [
        f"{name}:{lineno}  {value.strip()[:90]}"
        for lineno, value in _non_docstring_strings(path.read_text(encoding="utf-8"))
        if any(d in value for d in DASHES)
        and not any(allowed == value for allowed in NOT_USER_FACING)
    ]
    assert offenders == [], "\n".join(offenders)


def test_the_bracketing_pairs_became_brackets() -> None:
    """Two sentences opened a clause with a dash and closed it with another.

    A single-character swap breaks those: the surrounding text already contains
    commas, so replacing both dashes with commas produces a sentence with four
    of them and no structure. Parentheses keep the aside an aside.

    `coverage.describe()` is exactly why — it returns "roughly 6°N to 55°N, 1°W
    to 80°E", which has a comma in it, inside the clause.
    """
    coverage = (BACKEND / "coverage.py").read_text(encoding="utf-8")
    routing = (BACKEND / "routing.py").read_text(encoding="utf-8")
    assert "map loaded ({extent.describe()})" in coverage
    assert "(accessibility checks, rest stops, air quality)" in routing
    assert "in front of it (a " in routing
    assert "proxy or an access rule) rather than an API key" in routing
