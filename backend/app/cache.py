from __future__ import annotations

import hashlib
import json
import os
from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Tuple

from .models import WordTiming


def cache_key(text: str, voice: str, speed: float) -> str:
    h = hashlib.sha256()
    h.update(b"kokoro_visual_reader_v1\n")
    h.update(voice.encode("utf-8"))
    h.update(b"\n")
    h.update(str(speed).encode("utf-8"))
    h.update(b"\n")
    h.update(text.encode("utf-8", errors="ignore"))
    return h.hexdigest()


def output_dir() -> Path:
    # Place output folder at backend/output
    return Path(__file__).resolve().parents[1] / "output"


def wav_path(key: str) -> Path:
    return output_dir() / f"{key}.wav"


def json_path(key: str) -> Path:
    return output_dir() / f"{key}.json"


def ensure_output_dir() -> None:
    output_dir().mkdir(parents=True, exist_ok=True)


def exists(key: str) -> bool:
    return wav_path(key).exists() and json_path(key).exists()


def load_metadata(key: str) -> dict[str, Any]:
    with json_path(key).open("r", encoding="utf-8") as f:
        return json.load(f)


def save_cache(key: str, wav_bytes: bytes, metadata: dict[str, Any]) -> None:
    ensure_output_dir()

    tmp_wav = wav_path(key).with_suffix(".wav.tmp")
    tmp_json = json_path(key).with_suffix(".json.tmp")

    tmp_wav.write_bytes(wav_bytes)
    tmp_json.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")

    os.replace(tmp_wav, wav_path(key))
    os.replace(tmp_json, json_path(key))


def timings_to_jsonable(timings: list[WordTiming]) -> list[dict[str, Any]]:
    return [{"word": t.word, "start_ms": t.start_ms, "end_ms": t.end_ms} for t in timings]
