from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .book_output import book_dir, load_book_meta, sanitize_book_id


def load_chunk_durations(book_id: str) -> list[int]:
    """Return list where index i is duration_ms for chunk i, if the chunk json exists.

    Missing chunks are omitted from the end; i.e. returns contiguous prefix only.
    """
    book_id = sanitize_book_id(book_id)
    chunks_dir = book_dir(book_id) / "chunks"
    if not chunks_dir.exists():
        return []

    durations: list[int] = []
    i = 0
    while True:
        jp = chunks_dir / f"{i:06d}.json"
        if not jp.exists():
            break
        try:
            meta = json.loads(jp.read_text(encoding="utf-8"))
            durations.append(int(meta.get("duration_ms", 0) or 0))
        except Exception:
            durations.append(0)
        i += 1
    return durations


def book_meta_payload(book_id: str) -> dict[str, Any]:
    book_id = sanitize_book_id(book_id)
    meta = load_book_meta(book_id)
    durations = load_chunk_durations(book_id)

    return {
        "book_id": book_id,
        "next_chunk_index": int(meta.get("next_chunk_index", 0) or 0),
        "total_duration_ms": int(meta.get("total_duration_ms", 0) or 0),
        "sample_rate": meta.get("sample_rate"),
        "chunk_durations_ms": durations,
    }
