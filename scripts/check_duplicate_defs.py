#!/usr/bin/env python3
"""Catch the merge damage that git reports as a clean merge.

When two branches each add a function to the same module in different places,
git has no conflict to raise: both sides are additions, the hunks do not touch,
and the merge succeeds. What lands is a file with the symbol defined twice. The
last definition silently wins and the first becomes unreachable — no
``SyntaxError``, no ``ImportError``, and usually no test failure either, because
the surviving copy is a working implementation of the same thing.

This is not hypothetical. Commit ``66eaef3`` reconciled two independently
rebuilt frontends and found three instances that a clean merge had produced:
two ``class Step`` in ``models.py``, two ``_parse_instructions`` in
``routing.py``, and two ``steps=`` kwargs in a single ``Route(...)`` call. None
of them appeared as a conflict. None were caught by the test suite. They were
found by ``compileall`` and a scan like this one.

The fast-forward of ``main`` to ``feat/ios`` produced a fourth: two
``_instructions`` in ``scripts/make_synthetic_fixtures.py``, one from each
branch, with identical signatures — which is exactly why nothing broke. The
shadowed copy invented plausible real street names ("Market Street", "Station
Road"); the surviving copy deliberately does not, because a person reading a
*direction* is being told where to walk. A silent shadow had been standing
between that safety property and the fixtures for 84 commits.

So: a duplicate top-level definition is always a defect here, even when the two
copies agree. Either the merge dropped a decision someone made, or there is dead
code claiming to be live.

Scope is deliberately narrow — top-level ``def``, ``async def`` and ``class``
in one module. Methods inside a class body are checked per class. Conditional
definitions (a ``def`` inside ``if``/``try``) are not top-level and are skipped,
because re-defining a name under a platform or import guard is a real idiom.

Exit 0 if clean, 1 if any duplicate is found.
"""

from __future__ import annotations

import argparse
import ast
import sys
from collections import Counter
from pathlib import Path

# Tests legitimately reuse names across fixtures and parametrised helpers, and a
# duplicate there fails loudly the moment the file runs. The risk this guards
# against is production code that silently keeps working.
DEFAULT_ROOTS = ("backend", "scripts")
SKIP_PARTS = frozenset({"tests", "__pycache__", ".venv", "node_modules"})

Definition = ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef


def _duplicates(body: list[ast.stmt]) -> list[tuple[str, list[int]]]:
    """Names defined more than once directly in one statement list."""
    lines: dict[str, list[int]] = {}
    for node in body:
        if isinstance(node, Definition):
            lines.setdefault(node.name, []).append(node.lineno)
    counts = Counter({name: len(ls) for name, ls in lines.items()})
    return [(name, lines[name]) for name, n in sorted(counts.items()) if n > 1]


def _scan(path: Path) -> list[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        return [f"{path}:{exc.lineno}: does not parse: {exc.msg}"]

    problems = [
        f"{path}:{ls[1]}: {name!r} is already defined at line {ls[0]}"
        f" — the later definition silently wins"
        for name, ls in _duplicates(tree.body)
    ]
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            problems += [
                f"{path}:{ls[1]}: {node.name}.{name!r} is already defined at line {ls[0]}"
                for name, ls in _duplicates(node.body)
            ]
    return problems


def _python_files(roots: tuple[str, ...]) -> list[Path]:
    out: list[Path] = []
    for root in roots:
        base = Path(root)
        if not base.exists():
            continue
        out += [
            p for p in sorted(base.rglob("*.py"))
            if not SKIP_PARTS & set(p.parts)
        ]
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "roots", nargs="*", default=list(DEFAULT_ROOTS),
        help=f"directories to scan (default: {' '.join(DEFAULT_ROOTS)})",
    )
    args = parser.parse_args()

    files = _python_files(tuple(args.roots))
    problems = [p for f in files for p in _scan(f)]

    if problems:
        print("Duplicate top-level definitions — see scripts/check_duplicate_defs.py:")
        for p in problems:
            print(f"  {p}")
        print(f"\n{len(problems)} problem(s) in {len(files)} file(s).")
        return 1

    print(f"No duplicate definitions in {len(files)} file(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
