from __future__ import annotations

import json
import re
import wave
from pathlib import Path
from typing import Any

from .cache import output_dir
from .models import WordTiming


_SAFE_RE = re.compile(r"[^a-zA-Z0-9._-]+")


def sanitize_book_id(book_id: str) -> str:
    book_id = book_id.strip().strip(".")
    book_id = _SAFE_RE.sub("_", book_id)
    return book_id[:120] or "book"


def book_dir(book_id: str) -> Path:
    return output_dir() / sanitize_book_id(book_id)


def chunk_wav_path(book_id: str, chunk_index: int) -> Path:
    return book_dir(book_id) / "chunks" / f"{chunk_index:06d}.wav"


def chunk_json_path(book_id: str, chunk_index: int) -> Path:
    return book_dir(book_id) / "chunks" / f"{chunk_index:06d}.json"


def combined_wav_path(book_id: str) -> Path:
    return book_dir(book_id) / "book.wav"


def combined_json_path(book_id: str) -> Path:
    return book_dir(book_id) / "book.json"


def ensure_book_dirs(book_id: str) -> None:
    (book_dir(book_id) / "chunks").mkdir(parents=True, exist_ok=True)


def load_book_meta(book_id: str) -> dict[str, Any]:
    p = combined_json_path(book_id)
    if not p.exists():
        return {
            "book_id": sanitize_book_id(book_id),
            "sample_rate": None,
            "total_duration_ms": 0,
            "next_chunk_index": 0,
            "timings": [],
        }
    return json.loads(p.read_text(encoding="utf-8"))


def save_book_meta(book_id: str, meta: dict[str, Any]) -> None:
    combined_json_path(book_id).write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")


def _find_data_chunk(f) -> tuple[int, int] | None:
    """Return (data_size_offset, data_size) for a WAV file handle opened in r+b.

    WAV layout: RIFF header then chunks. We scan chunks until we find 'data'.
    data_size_offset points to the 4-byte little-endian size field.
    """
    import struct

    f.seek(0)
    hdr = f.read(12)
    if len(hdr) != 12 or hdr[0:4] != b"RIFF" or hdr[8:12] != b"WAVE":
        return None

    while True:
        ch = f.read(8)
        if len(ch) != 8:
            return None
        chunk_id = ch[0:4]
        (chunk_size,) = struct.unpack("<I", ch[4:8])
        if chunk_id == b"data":
            data_size_offset = f.tell() - 4
            data_size = chunk_size
            return (data_size_offset, data_size)
        # Skip payload (padded to even)
        f.seek(chunk_size + (chunk_size % 2), 1)


def _append_pcm16_mono_wav(out_wav: Path, frames: bytes, sample_rate: int) -> None:
    """Append PCM16 mono frames to an existing WAV without rewriting.

    If file doesn't exist, create it.
    If it exists, append frames to the 'data' chunk and update RIFF/data sizes.
    """
    import struct

    if not out_wav.exists():
        with wave.open(str(out_wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            w.writeframes(frames)
        return

    # Update header sizes in-place.
    with out_wav.open("r+b") as f:
        found = _find_data_chunk(f)
        if not found:
            return

        data_size_offset, data_size = found

        # Validate fmt chunk by using wave module (read-only) to confirm format.
        with wave.open(str(out_wav), "rb") as existing:
            if existing.getnchannels() != 1 or existing.getsampwidth() != 2 or existing.getframerate() != sample_rate:
                return

        # Seek to end of data chunk and append
        data_payload_offset = data_size_offset + 4
        f.seek(data_payload_offset + data_size)
        f.write(frames)

        new_data_size = data_size + len(frames)

        # Update data chunk size
        f.seek(data_size_offset)
        f.write(struct.pack("<I", new_data_size))

        # Update RIFF chunk size = file_size - 8
        file_size = f.seek(0, 2)
        riff_size = file_size - 8
        f.seek(4)
        f.write(struct.pack("<I", riff_size))


def append_to_combined(
    book_id: str,
    chunk_wav: bytes,
    *,
    sample_rate: int,
    chunk_duration_ms: int,
    timings: list[WordTiming],
    chunk_index: int,
) -> None:
    """Append a chunk WAV (PCM16) to output/<book_id>/book.wav and update book.json timings.

    Assumes chunks are appended in order. If called out of order, it will not append.
    """
    ensure_book_dirs(book_id)
    meta = load_book_meta(book_id)

    expected = int(meta.get("next_chunk_index", 0) or 0)
    if chunk_index != expected:
        return

    # Determine sample rate; enforce consistency.
    sr = meta.get("sample_rate")
    if sr is None:
        meta["sample_rate"] = sample_rate
    elif int(sr) != int(sample_rate):
        return

    # Read frames from chunk wav bytes
    import io

    with wave.open(io.BytesIO(chunk_wav), "rb") as r:
        nch = r.getnchannels()
        sampwidth = r.getsampwidth()
        fr = r.getframerate()
        if nch != 1 or sampwidth != 2 or fr != sample_rate:
            return
        frames = r.readframes(r.getnframes())

    # Fast append
    out_wav = combined_wav_path(book_id)
    _append_pcm16_mono_wav(out_wav, frames, sample_rate)

    # Update global timings
    offset_ms = int(meta.get("total_duration_ms", 0) or 0)
    merged = meta.get("timings", [])
    for t in timings:
        merged.append({"word": t.word, "start_ms": t.start_ms + offset_ms, "end_ms": t.end_ms + offset_ms})

    meta["timings"] = merged
    meta["total_duration_ms"] = offset_ms + int(chunk_duration_ms)
    meta["next_chunk_index"] = expected + 1

    save_book_meta(book_id, meta)
