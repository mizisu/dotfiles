"""Search the code index and output LLM-ready formatted results."""

import importlib.resources
import json
import os
import struct
import sqlite3
import sys

from sentence_transformers import SentenceTransformer

from config import EMBEDDING_DIM, MAX_SEQ_LEN, MIN_SCORE, MODEL_NAME, QUERY_PREFIX

_model = None


def _get_model():
    global _model
    if _model is None:
        _model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
        _model.max_seq_length = MAX_SEQ_LEN
    return _model


def search(db_path: str, query: str, top_k: int = 10,
           path_filter: str | None = None, language: str | None = None) -> dict:
    if not os.path.exists(db_path):
        return {"error": "Index not built. Run /reindex first."}

    model = _get_model()
    full_query = f"{QUERY_PREFIX}{query}"
    embedding = model.encode([full_query], show_progress_bar=False)[0]
    blob = struct.pack(f"{len(embedding)}f", *embedding.tolist())

    conn = sqlite3.connect(db_path)
    ext_path = importlib.resources.files("sqlite_vector.binaries") / "vector"
    conn.enable_load_extension(True)
    conn.load_extension(str(ext_path))
    conn.enable_load_extension(False)

    conn.execute(
        "SELECT vector_init('code_chunks', 'embedding', "
        f"'dimension={EMBEDDING_DIM},type=FLOAT32,distance=COSINE')"
    )

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
        sql = f"""
            SELECT c.id, c.file_path, c.start_line, c.end_line,
                   c.name, c.chunk_type, c.language, c.content, v.distance
            FROM {scan_fn}('code_chunks', 'embedding', ?) AS v
            JOIN code_chunks c ON c.id = v.rowid
            WHERE {" AND ".join(where_parts)}
            LIMIT ?
        """
        rows = conn.execute(sql, params).fetchall()
    else:
        sql = f"""
            SELECT c.id, c.file_path, c.start_line, c.end_line,
                   c.name, c.chunk_type, c.language, c.content, v.distance
            FROM {scan_fn}('code_chunks', 'embedding', ?, ?) AS v
            JOIN code_chunks c ON c.id = v.rowid
        """
        rows = conn.execute(sql, (blob, top_k)).fetchall()

    conn.close()

    results = []
    for row in rows:
        (_, file_path, start_line, end_line,
         name, chunk_type, lang, content, distance) = row
        score = round(1 - distance, 4)
        if score < MIN_SCORE:
            continue
        content_lines = content.split("\n")
        if len(content_lines) > 40:
            content = "\n".join(content_lines[:40]) + f"\n... ({len(content_lines) - 40} more lines)"
        results.append({
            "file_path": file_path, "start_line": start_line, "end_line": end_line,
            "name": name, "type": chunk_type, "language": lang,
            "score": score, "content": content,
        })

    return {"query": query, "count": len(results), "results": results}


def format_for_llm(data: dict) -> str:
    if "error" in data:
        return data["error"]
    results = data.get("results", [])
    if not results:
        return f'No results found for: "{data["query"]}"'

    parts: list[str] = [f'Found {len(results)} results for "{data["query"]}":\n']
    for i, r in enumerate(results, 1):
        lang = r["language"]
        header = (
            f'[{i}] {r["file_path"]}:{r["start_line"]}-{r["end_line"]}'
            f' ({r["type"]}: {r["name"]}) [score: {r["score"]}]'
        )
        parts.append(header)
        parts.append(f"```{lang}")
        parts.append(r["content"])
        parts.append("```")
        parts.append("")
    return "\n".join(parts)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("db_path", help="Path to code_search.db")
    parser.add_argument("query", help="Search query")
    parser.add_argument("--top-k", type=int, default=10)
    parser.add_argument("--path", default=None)
    parser.add_argument("--lang", default=None)
    args = parser.parse_args()

    data = search(args.db_path, args.query, args.top_k, args.path, args.lang)
    print(format_for_llm(data))
