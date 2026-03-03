"""Configuration for code search engine."""

import os

# Embedding model
MODEL_NAME = "nomic-ai/CodeRankEmbed"
EMBEDDING_DIM = 768
QUERY_PREFIX = "Represent this query for searching relevant code: "

# Chunking
MAX_CHUNK_LINES = 200
MIN_CHUNK_LINES = 2

# Encoding
BATCH_SIZE = 64    # large batch for MPS throughput
MAX_SEQ_LEN = 128  # function signature + key logic (~10 lines, ~400 chars)
                    # code SEARCH only needs to LOCATE, not UNDERSTAND full implementation

# Search
MIN_SCORE = 0.3    # filter noise — unrelated results score <0.25

# File patterns
INCLUDE_EXTENSIONS = {".py", ".ts", ".tsx", ".js", ".jsx"}

EXCLUDE_DIRS = {
    "node_modules", ".git", ".venv", "__pycache__", "dist", "build",
    ".next", "vendor", ".mypy_cache", ".ruff_cache", ".tox", ".eggs",
    ".pytest_cache", "htmlcov", "coverage", "static",
    ".idea", ".vscode", ".cursor", ".claude", ".opencode",
    ".pi", ".github", "locales",
}

# DB location (project-local, alongside ctags index)
def db_path_for(root_dir: str) -> str:
    return os.path.join(root_dir, ".pi", "index", "code_search.db")
