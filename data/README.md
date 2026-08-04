Pre-warmed segment scores live here as cache.db, written offline by
backend/batch_score.py and committed so the 512 MB deployment can serve real
CLIP scores without importing torch.

The file is not in the repository until somebody runs the pre-warm — the backend creates an empty
one on first boot if it is missing. Commit it once it holds real scores, so the deployed instance
reads them instead of falling back to geometry-only scoring.
