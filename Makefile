# Meander — the commands, in one place.
#
# Everything here is something that was previously a paragraph in a README or a
# line somebody had to remember. `make check` is the one that matters: it is
# exactly what CI runs, so "it passed locally" and "it passed in CI" mean the
# same thing.
#
#   make check    everything, in the order that fails fastest
#   make help     this list

# The project venv, not whatever `python` happens to be. The system Python on
# the development machine is 3.14 and cannot build pydantic-core, so a stray
# `pip install` there fails in a way that looks like a project problem.
VENV    ?= .venv
PY      ?= $(VENV)/bin/python
FRONT   ?= frontend

MOCK_PORT   ?= 5199

.DEFAULT_GOAL := help
.PHONY: help venv install install-ci test test-frontend lint coverage build \
        check run run-mock router infra-lint images compose-up compose-down \
        scrub clean

help:  ## Show this list
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- setup ------------------------------------------------------------------

venv:  ## Create the virtualenv (Python 3.13; 3.14 cannot build pydantic-core)
	python3.13 -m venv $(VENV)
	$(PY) -m pip install -U pip

install: venv  ## Install the full local environment, torch included
	$(PY) -m pip install -r backend/requirements.txt
	cd $(FRONT) && npm ci

install-ci:  ## Install what CI installs — no torch
	$(PY) -m pip install -r backend/requirements-dev.txt

# --- the gates --------------------------------------------------------------

lint:  ## ruff over backend/ and scripts/
	$(PY) -m ruff check backend/ scripts/

test:  ## The offline test suite
	$(PY) -m pytest backend/tests

coverage:  ## The suite with the coverage floor from pyproject.toml
	$(PY) -m pytest backend/tests --cov --cov-report=term:skip-covered

test-frontend:  ## The frontend suite. TZ is pinned in vite.config.js, not here
	cd $(FRONT) && npm test

build:  ## Frontend build
	cd $(FRONT) && npm run build

infra-lint:  ## CloudFormation templates. Nothing is deployed; see infra/README.md
	$(VENV)/bin/cfn-lint infra/*.yaml && echo "infra ok"

# The two browser gates — `gate` and `pwa-gate`, driving headless Chrome over
# CDP — used to live here. They went in the reconciliation merge along with the
# frontend they graded: gate.mjs measures a layout this branch does not have,
# and pwa-gate.mjs asserts that a service worker serves the shell, which is
# meaningless on the platform this is now being built for. BLOCKED.md §5 lists
# what comes back and when.
#
# Deleted rather than left pointing at absent files. A make target that fails
# with "No such file or directory" teaches people to skip the gates.

check: lint coverage test-frontend build infra-lint  ## Everything CI runs, fastest failure first
	@echo
	@echo "  Green — and this is the whole of CI now, not most of it."

# --- running it -------------------------------------------------------------

run:  ## API on :8000 against whatever .env points at
	$(PY) -m uvicorn backend.main:app --reload --port 8000

run-mock:  ## Frontend on the mock API, no backend needed
	cd $(FRONT) && VITE_MOCK_API=1 npx vite --port $(MOCK_PORT) --strictPort

router:  ## Self-hosted GraphHopper on :8989 from an already-built graph
	scripts/graphhopper.sh serve

images:  ## Build both container images. Needs a staged graph for the router
	docker buildx build --load --platform=linux/arm64 -t meander-api:local .
	docker buildx build --load --platform=linux/arm64 --build-arg GRAPH_SOURCE=local \
	  -f graphhopper/Dockerfile -t meander-graphhopper:local .

compose-up:  ## The whole stack in containers
	docker compose up -d --build graphhopper api

compose-down:  ## Stop it
	docker compose down

# --- housekeeping -----------------------------------------------------------

scrub:  ## Remove cached routes from data/cache.db before committing it
	@# The pre-commit hook inspects the *staged* blob and will refuse a
	@# cache.db carrying whole /api/routes payloads with real coordinates.
	@# `git checkout --` does NOT undo this: it restores from the index, which
	@# still holds the dirty blob. --source=HEAD is the one that works.
	$(PY) scripts/scrub_cache_db.py --scrub
	git restore --source=HEAD --staged --worktree data/cache.db
	rm -f data/cache.db-wal data/cache.db-shm
	@echo "cache.db scrubbed and restored"

clean:  ## Remove build output and test scratch
	rm -rf $(FRONT)/dist .coverage .coverage.* .pytest_cache .ruff_cache .hypothesis
	find . -name '__pycache__' -type d -prune -exec rm -rf {} +
