#!/usr/bin/env python3
"""Prove the deployment image can import the API without torch installed.

The whole shape of this project rests on one claim: the API only ever *reads*
CLIP scores out of ``data/cache.db``, so the served image never needs the model
that produced them. That is what lets the backend run in 512 MB, and it is why
``backend/requirements-deploy.txt`` exists separately from
``backend/requirements.txt``.

The claim is easy to break by accident. Any new import of a module that happens
to pull in ``torch`` — directly, or three layers down a dependency — would add
roughly 2 GB to the image and OOM the instance at import time, and nothing in
the ordinary test suite would notice, because the development environment has
torch installed and everything keeps working there.

So this is checked against a real environment built from the deploy
requirements, not by reading the file. Two assertions:

1. ``torch``, ``open_clip`` and ``torchvision`` must all be unimportable.
2. ``backend.main`` must import cleanly anyway.

The second matters as much as the first. An import guard that silently degrades
would satisfy (1) while leaving the API broken in exactly the environment it is
deployed into.

Run it with the interpreter of a virtualenv built from
``backend/requirements-deploy.txt`` — ``make torch-free`` builds and caches one.
Exit 0 if clean, 1 otherwise.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

# Running a *script* puts the script's own directory on sys.path, not the
# working directory — so `import backend.main` would fail here for a reason that
# has nothing to do with torch. CI used to inline this as a heredoc on stdin,
# where sys.path[0] is '' and the import happened to resolve. Make the repository
# root explicit instead of depending on how the interpreter was invoked.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

FORBIDDEN = ("torch", "open_clip", "torchvision")


def main() -> int:
    present = {m: importlib.util.find_spec(m) is not None for m in FORBIDDEN}

    for module, found in present.items():
        print(f"  {module:<12} {'PRESENT — must not be' if found else 'absent'}")

    if any(present.values()):
        pulled = ", ".join(m for m, found in present.items() if found)
        print(
            f"\nA deploy dependency pulled in {pulled}.\n"
            "The served image reads CLIP scores from data/cache.db and never runs the\n"
            "model. Adding torch to requirements-deploy.txt costs ~2 GB and OOMs the\n"
            "instance at import time.",
            file=sys.stderr,
        )
        return 1

    try:
        import backend.main  # noqa: F401
    except Exception as exc:  # pragma: no cover - the failure is the point
        print(
            f"\nbackend.main does not import without torch: {exc!r}\n"
            "Absence of torch is not enough — the API has to actually start in the\n"
            "environment it is deployed into.",
            file=sys.stderr,
        )
        return 1

    print("\nbackend.main imports with none of torch, open_clip or torchvision present.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
