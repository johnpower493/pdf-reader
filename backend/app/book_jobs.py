from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Optional

from .book_output import ensure_book_dirs, load_book_meta, sanitize_book_id


def _now_ms() -> int:
    return int(time.time() * 1000)


def _source_text_path(book_id: str) -> Path:
    from .book_output import book_dir

    return book_dir(book_id) / "source.txt"


def _job_json_path(book_id: str) -> Path:
    from .book_output import book_dir

    return book_dir(book_id) / "job.json"


def chunk_text(text: str, max_chars: int = 1200) -> list[str]:
    """Match frontend chunking to keep cache keys consistent."""
    out: list[str] = []
    i = 0
    while i < len(text):
        j = min(len(text), i + max_chars)
        slice_ = text[i:j]
        if j < len(text):
            last_break = max(
                slice_.rfind(". "),
                slice_.rfind("! "),
                slice_.rfind("? "),
                slice_.rfind("\n\n"),
                slice_.rfind(" "),
            )
            if last_break > max_chars * 0.5:
                j = i + last_break + 1
        part = text[i:j].strip()
        if part:
            out.append(part)
        i = j
    return out


@dataclass
class BookJobState:
    book_id: str
    voice: str
    speed: float
    total_chunks: int
    started_at_ms: int
    updated_at_ms: int
    state: str  # running|completed|failed|cancelled
    next_chunk_index: int
    last_error: str | None = None


class BookJobManager:
    """In-process background conversion manager.

    This is intentionally simple (thread-based) to avoid needing external infra.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}
        self._cancel: dict[str, threading.Event] = {}

    def write_source_text(self, book_id: str, text: str) -> None:
        book_id = sanitize_book_id(book_id)
        ensure_book_dirs(book_id)
        _source_text_path(book_id).write_text(text, encoding="utf-8")

    def read_source_text(self, book_id: str) -> str:
        book_id = sanitize_book_id(book_id)
        p = _source_text_path(book_id)
        if not p.exists():
            raise FileNotFoundError(f"No uploaded source text for book_id={book_id}")
        return p.read_text(encoding="utf-8")

    def load_status(self, book_id: str) -> dict[str, Any]:
        book_id = sanitize_book_id(book_id)
        p = _job_json_path(book_id)
        if not p.exists():
            meta = load_book_meta(book_id)
            return {
                "book_id": book_id,
                "state": "idle",
                "voice": None,
                "speed": None,
                "total_chunks": None,
                "next_chunk_index": int(meta.get("next_chunk_index", 0) or 0),
                "updated_at_ms": None,
                "started_at_ms": None,
                "last_error": None,
            }
        return json.loads(p.read_text(encoding="utf-8"))

    def cancel(self, book_id: str) -> None:
        book_id = sanitize_book_id(book_id)
        with self._lock:
            ev = self._cancel.get(book_id)
        if ev:
            ev.set()

    def start(
        self,
        book_id: str,
        *,
        voice: str,
        speed: float,
        synthesize_chunk: Callable[[str, int, str, str, float], None],
        max_chars: int = 1200,
    ) -> dict[str, Any]:
        book_id = sanitize_book_id(book_id)
        ensure_book_dirs(book_id)

        with self._lock:
            t = self._threads.get(book_id)
            if t and t.is_alive():
                return self.load_status(book_id)

            cancel_ev = threading.Event()
            self._cancel[book_id] = cancel_ev

            text = self.read_source_text(book_id)
            chunks = chunk_text(text, max_chars=max_chars)

            book_meta = load_book_meta(book_id)
            next_chunk_index = int(book_meta.get("next_chunk_index", 0) or 0)

            st = BookJobState(
                book_id=book_id,
                voice=voice,
                speed=speed,
                total_chunks=len(chunks),
                started_at_ms=_now_ms(),
                updated_at_ms=_now_ms(),
                state="running",
                next_chunk_index=next_chunk_index,
                last_error=None,
            )
            self._write_status(st)

            th = threading.Thread(
                target=self._run,
                name=f"bookjob:{book_id}",
                daemon=True,
                args=(st, chunks, synthesize_chunk, cancel_ev),
            )
            self._threads[book_id] = th
            th.start()

        return self.load_status(book_id)

    def _write_status(self, st: BookJobState) -> None:
        _job_json_path(st.book_id).write_text(json.dumps(st.__dict__, ensure_ascii=False), encoding="utf-8")

    def _run(
        self,
        st: BookJobState,
        chunks: list[str],
        synthesize_chunk: Callable[[str, int, str, str, float], None],
        cancel_ev: threading.Event,
    ) -> None:
        try:
            for idx in range(st.next_chunk_index, len(chunks)):
                if cancel_ev.is_set():
                    st.state = "cancelled"
                    st.updated_at_ms = _now_ms()
                    st.next_chunk_index = idx
                    self._write_status(st)
                    return

                synthesize_chunk(st.book_id, idx, chunks[idx], st.voice, st.speed)

                st.next_chunk_index = idx + 1
                st.updated_at_ms = _now_ms()
                self._write_status(st)

            st.state = "completed"
            st.updated_at_ms = _now_ms()
            self._write_status(st)
        except Exception as e:
            st.state = "failed"
            st.last_error = str(e)
            st.updated_at_ms = _now_ms()
            self._write_status(st)


book_job_manager = BookJobManager()
