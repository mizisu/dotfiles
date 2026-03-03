"""Persistent code search server.

Loads embedding model once, handles search requests via stdin/stdout JSON lines.

Protocol:
  Server → {"status": "loading"}
  Server → {"status": "ready"}
  Client → {"action": "search", "db_path": "...", "query": "...", ...}
  Server → {"text": "..."} or {"error": "..."}
  Client → {"action": "quit"}
"""

import importlib.resources
import json
import logging
import os
import struct
import sqlite3
import sys

# Suppress noisy logs to keep stdout clean (JSON only)
logging.basicConfig(level=logging.WARNING, stream=sys.stderr)
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from sentence_transformers import SentenceTransformer
from config import EMBEDDING_DIM, MAX_SEQ_LEN, MIN_SCORE, MODEL_NAME, QUERY_PREFIX


def _out(data: dict):
    sys.stdout.write(json.dumps(data, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _load_vector_ext(conn: sqlite3.Connection):
    ext_path = importlib.resources.files("sqlite_vector.binaries") / "vector"
    conn.enable_load_extension(True)
    conn.load_extension(str(ext_path))
    conn.enable_load_extension(False)


def _do_search(model, req: dict) -> dict:
    db_path = req["db_path"]
    query = req["query"]
    top_k = min(req.get("top_k", 10), 30)
    path_filter = req.get("path_filter")
    language = req.get("language")

    if not os.path.exists(db_path):
        return {"error": "Index not built. Run /reindex first."}

    # Encode query
    full_query = f"{QUERY_PREFIX}{query}"
    emb = model.encode([full_query], show_progress_bar=False)[0]
    blob = struct.pack(f"{len(emb)}f", *emb.tolist())

    # Search DB
    conn = sqlite3.connect(db_path)
    _load_vector_ext(conn)
    conn.execute(
        "SELECT vector_init('code_chunks', 'embedding', "
        f"'dimension={EMBEDDING_DIM},type=FLOAT32,distance=COSINE')"
    )

    # Try quantized scan, fallback to brute-force scan
    use_quantized = True
    try:
        conn.execute("SELECT vector_quantize_preload('code_chunks', 'embedding')")
    except Exception:
        use_quantized = False

    scan_fn = "vector_quantize_scan" if use_quantized else "vector_full_scan"

    if path_filter or language:
        where_parts: list[str] = []
        params: list = [blob]
        if path_filter:
            where_parts.append("c.file_path LIKE ?")
            params.append(f"{path_filter}%")
        if language:
            where_parts.append("c.language = ?")
            params.append(language)
        params.append(top_k)
        sql = (
            "SELECT c.file_path, c.start_line, c.end_line,"
            "  c.name, c.chunk_type, c.language, c.content, v.distance"
            f" FROM {scan_fn}('code_chunks', 'embedding', ?) AS v"
            " JOIN code_chunks c ON c.id = v.rowid"
            f" WHERE {' AND '.join(where_parts)}"
            " LIMIT ?"
        )
    else:
        params = (blob, top_k)
        sql = (
            "SELECT c.file_path, c.start_line, c.end_line,"
            "  c.name, c.chunk_type, c.language, c.content, v.distance"
            f" FROM {scan_fn}('code_chunks', 'embedding', ?, ?) AS v"
            " JOIN code_chunks c ON c.id = v.rowid"
        )

    rows = conn.execute(sql, params).fetchall()
    conn.close()

    # Filter by minimum score and format for LLM
    filtered = []
    for fp, sl, el, name, ctype, lang, content, dist in rows:
        score = round(1 - dist, 4)
        if score < MIN_SCORE:
            continue
        lines = content.split("\n")
        if len(lines) > 40:
            content = "\n".join(lines[:40]) + f"\n... ({len(lines) - 40} more lines)"
        filtered.append((fp, sl, el, name, ctype, lang, content, score))

    if not filtered:
        return {"text": f'No results found for: "{query}"'}

    parts: list[str] = [f'Found {len(filtered)} results for "{query}":\n']
    for i, (fp, sl, el, name, ctype, lang, content, score) in enumerate(filtered, 1):
        parts.append(f"[{i}] {fp}:{sl}-{el} ({ctype}: {name}) [score: {score}]")
        parts.append(f"```{lang}")
        parts.append(content)
        parts.append("```")
        parts.append("")

    return {"text": "\n".join(parts)}


def main():
    _out({"status": "loading"})
    model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    model.max_seq_length = MAX_SEQ_LEN
    _out({"status": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            _out({"error": f"invalid JSON: {line[:100]}"})
            continue

        action = req.get("action")
        try:
            if action == "search":
                _out(_do_search(model, req))
            elif action == "ping":
                _out({"status": "pong"})
            elif action == "quit":
                break
            else:
                _out({"error": f"unknown action: {action}"})
        except Exception as e:
            _out({"error": str(e)})


if __name__ == "__main__":
    main()
