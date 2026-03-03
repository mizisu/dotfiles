"""Build and update the code search index."""

import importlib.resources
import json
import os
import struct
import sqlite3
import sys
import time

from sentence_transformers import SentenceTransformer

from chunker import chunk_file
from config import (
    BATCH_SIZE, EMBEDDING_DIM, EXCLUDE_DIRS,
    INCLUDE_EXTENSIONS, MAX_SEQ_LEN, MODEL_NAME, db_path_for,
)


def _log(data: dict):
    print(json.dumps(data, ensure_ascii=False), flush=True)


def _load_vector_ext(conn: sqlite3.Connection):
    ext_path = importlib.resources.files("sqlite_vector.binaries") / "vector"
    conn.enable_load_extension(True)
    conn.load_extension(str(ext_path))
    conn.enable_load_extension(False)


def _init_db(conn: sqlite3.Connection):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS code_chunks (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path  TEXT    NOT NULL,
            start_line INTEGER NOT NULL,
            end_line   INTEGER NOT NULL,
            name       TEXT    NOT NULL,
            chunk_type TEXT    NOT NULL,
            language   TEXT    NOT NULL,
            content    TEXT    NOT NULL,
            embedding  BLOB
        );
        CREATE TABLE IF NOT EXISTS file_index (
            file_path   TEXT PRIMARY KEY,
            mtime       REAL NOT NULL,
            chunk_count INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_file ON code_chunks(file_path);
        CREATE INDEX IF NOT EXISTS idx_chunks_lang  ON code_chunks(language);
    """)
    conn.commit()


def _init_vector(conn: sqlite3.Connection):
    conn.execute(
        "SELECT vector_init('code_chunks', 'embedding', "
        f"'dimension={EMBEDDING_DIM},type=FLOAT32,distance=COSINE')"
    )


def _collect_files(root_dir: str) -> list[tuple[str, str]]:
    files = []
    for dirpath, dirnames, filenames in os.walk(root_dir):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fname in filenames:
            ext = os.path.splitext(fname)[1]
            if ext in INCLUDE_EXTENSIONS:
                abs_path = os.path.join(dirpath, fname)
                rel_path = os.path.relpath(abs_path, root_dir)
                files.append((abs_path, rel_path))
    return files


def build_index(root_dir: str, full_rebuild: bool = False):
    db_file = db_path_for(root_dir)
    os.makedirs(os.path.dirname(db_file), exist_ok=True)

    # ── load model ──
    _log({"status": "loading_model"})
    model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    model.max_seq_length = MAX_SEQ_LEN

    # ── open DB ──
    if full_rebuild and os.path.exists(db_file):
        os.remove(db_file)

    conn = sqlite3.connect(db_file)
    _load_vector_ext(conn)
    _init_db(conn)
    try:
        _init_vector(conn)
    except Exception:
        pass

    # ── collect files ──
    all_files = _collect_files(root_dir)
    _log({"status": "collecting", "total_files": len(all_files)})

    # ── determine changed ──
    to_process: list[tuple[str, str, float]] = []
    for abs_path, rel_path in all_files:
        mtime = os.path.getmtime(abs_path)
        row = conn.execute(
            "SELECT mtime FROM file_index WHERE file_path = ?", (rel_path,)
        ).fetchone()
        if row is None or row[0] < mtime or full_rebuild:
            to_process.append((abs_path, rel_path, mtime))

    _log({"status": "processing", "total_files": len(all_files), "files_to_process": len(to_process)})

    if not to_process:
        total_chunks = conn.execute("SELECT COUNT(*) FROM code_chunks").fetchone()[0]
        total_files = conn.execute("SELECT COUNT(*) FROM file_index").fetchone()[0]
        _log({"status": "complete", "files_processed": 0, "total_files": total_files,
              "new_chunks": 0, "total_chunks": total_chunks})
        conn.close()
        return

    # ── process files in batches ──
    new_chunks = 0
    t0 = time.time()

    # Collect all chunks first, then embed in large batches for efficiency
    pending_chunks: list[tuple[str, float, any]] = []  # (rel_path, mtime, CodeChunk)
    file_chunk_map: dict[str, list] = {}

    for i, (abs_path, rel_path, mtime) in enumerate(to_process):
        try:
            with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            conn.execute("DELETE FROM code_chunks WHERE file_path = ?", (rel_path,))
            chunks = chunk_file(content, rel_path)
            if not chunks:
                conn.execute("INSERT OR REPLACE INTO file_index VALUES (?, ?, ?)", (rel_path, mtime, 0))
                continue
            file_chunk_map[rel_path] = (mtime, chunks)
            for chunk in chunks:
                pending_chunks.append((rel_path, mtime, chunk))
        except Exception as e:
            _log({"status": "file_error", "file": rel_path, "error": str(e)})

    # Sort by content length to minimize padding waste (O(seq²) attention cost)
    pending_chunks.sort(key=lambda x: len(x[2].content))

    # Embed and store in groups to report progress
    total = len(pending_chunks)
    _log({"status": "embedding", "total_chunks": total})
    GROUP_SIZE = 2000

    for g_start in range(0, total, GROUP_SIZE):
        g_end = min(g_start + GROUP_SIZE, total)
        group = pending_chunks[g_start:g_end]
        texts = [c.content for _, _, c in group]
        embeddings = model.encode(texts, batch_size=BATCH_SIZE, show_progress_bar=False)

        for (rel_path, mtime, chunk), emb in zip(group, embeddings):
            blob = struct.pack(f"{len(emb)}f", *emb.tolist())
            conn.execute(
                """INSERT INTO code_chunks
                   (file_path, start_line, end_line, name, chunk_type, language, content, embedding)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (chunk.file_path, chunk.start_line, chunk.end_line,
                 chunk.name, chunk.chunk_type, chunk.language, chunk.content, blob),
            )
            new_chunks += 1

        conn.commit()
        elapsed = time.time() - t0
        _log({"status": "progress", "embedded": g_end, "total": total, "elapsed_sec": round(elapsed, 1)})

    # Update file_index
    for rel_path, (mtime, chunks) in file_chunk_map.items():
        conn.execute("INSERT OR REPLACE INTO file_index VALUES (?, ?, ?)", (rel_path, mtime, len(chunks)))

    conn.commit()

    # ── remove deleted files ──
    existing_rels = {r for _, r in all_files}
    for (fp,) in conn.execute("SELECT file_path FROM file_index").fetchall():
        if fp not in existing_rels:
            conn.execute("DELETE FROM code_chunks WHERE file_path = ?", (fp,))
            conn.execute("DELETE FROM file_index WHERE file_path = ?", (fp,))
    conn.commit()

    # ── quantize ──
    _log({"status": "quantizing"})
    try:
        conn.execute("SELECT vector_quantize('code_chunks', 'embedding')")
    except Exception as e:
        _log({"status": "quantize_error", "error": str(e)})

    total_chunks = conn.execute("SELECT COUNT(*) FROM code_chunks").fetchone()[0]
    total_files = conn.execute("SELECT COUNT(*) FROM file_index").fetchone()[0]
    elapsed = time.time() - t0
    conn.close()

    _log({"status": "complete", "files_processed": len(to_process), "total_files": total_files,
          "new_chunks": new_chunks, "total_chunks": total_chunks, "elapsed_sec": round(elapsed, 1)})


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Build code search index")
    parser.add_argument("root_dir", help="Project root directory to index")
    parser.add_argument("--full", action="store_true", help="Full rebuild")
    args = parser.parse_args()
    build_index(args.root_dir, full_rebuild=args.full)
