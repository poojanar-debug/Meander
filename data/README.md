Pre-warmed segment scores live here as cache.db, written offline by
backend/batch_score.py and committed so the 512 MB deployment can serve real
CLIP scores without importing torch.
