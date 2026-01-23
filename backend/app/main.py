from __future__ import annotations

import base64
import io
import json
import re
from typing import List

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .models import TTSRequest, TTSResponse, UploadResponse, WordTiming
from .text_extract import extract_text_from_pdf, extract_text_from_txt
from .voices import list_kokoro_voice_ids
from .cache import cache_key as tts_cache_key, exists as cache_exists, load_metadata, save_cache, timings_to_jsonable
from .cache_admin import clear_output_cache
from .book_output import (
    append_to_combined,
    chunk_json_path,
    chunk_wav_path,
    ensure_book_dirs,
    sanitize_book_id,
)

app = FastAPI(title="Kokoro Visual TTS")

# Serve cached output WAVs
# Ensure folder exists before mounting.
try:
    from .cache import ensure_output_dir

    ensure_output_dir()
except Exception:
    pass

app.mount("/output", StaticFiles(directory="output"), name="output")

# For local dev: allow Vite dev server
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"] ,
    allow_headers=["*"],
)


_WORD_RE = re.compile(r"\S+")


def _estimate_word_timings(text: str, duration_ms: int) -> list[WordTiming]:
    """Fallback alignment when the TTS engine doesn't provide per-word timestamps.

    We apportion time based on token length (chars), which is surprisingly usable
    for highlighting while audio plays.
    """
    tokens = [(m.group(0), m.start(), m.end()) for m in _WORD_RE.finditer(text)]
    if not tokens:
        return []

    weights = np.array([max(1, len(tok[0])) for tok in tokens], dtype=np.float64)
    weights = weights / weights.sum()
    starts = np.cumsum(np.concatenate([[0.0], weights[:-1]]))
    ends = np.cumsum(weights)

    timings: list[WordTiming] = []
    for (word, _, _), s, e in zip(tokens, starts, ends):
        timings.append(
            WordTiming(
                word=word,
                start_ms=int(round(s * duration_ms)),
                end_ms=int(round(e * duration_ms)),
            )
        )
    return timings


_KOKORO_DEFAULT_VOICE = "af_heart"
_KOKORO_SR = 24000
_KOKORO_PIPELINE = None


def _get_kokoro_pipeline():
    global _KOKORO_PIPELINE
    if _KOKORO_PIPELINE is not None:
        return _KOKORO_PIPELINE

    try:
        from kokoro import KPipeline  # type: ignore
    except Exception as e:  # pragma: no cover
        raise RuntimeError(
            "Kokoro is not installed. Install it with: pip install git+https://github.com/hexgrad/kokoro.git"
        ) from e

    # English: lang_code 'a'/'b' are accepted by Kokoro for English processing.
    _KOKORO_PIPELINE = KPipeline(lang_code="a")
    return _KOKORO_PIPELINE


def _kokoro_synthesize(text: str, voice: str | None, speed: float) -> tuple[np.ndarray, int, list[WordTiming]]:
    """Return (audio_float32_mono, sample_rate, word_timings).

    Kokoro provides timestamps on its internal `MToken`s. We convert those to
    per-token timings and offset them across segments.
    """
    pipeline = _get_kokoro_pipeline()
    voice = voice or _KOKORO_DEFAULT_VOICE

    audio_parts: list[np.ndarray] = []
    timings: list[WordTiming] = []

    total_samples = 0
    for result in pipeline(text, voice=voice, speed=speed):
        a = result.audio
        if a is None:
            continue
        a_np = np.asarray(a, dtype=np.float32)
        if a_np.ndim > 1:
            a_np = a_np.mean(axis=1)

        offset_ms = int(round(total_samples / _KOKORO_SR * 1000.0))

        if result.tokens:
            for t in result.tokens:
                # Kokoro sets start_ts/end_ts in seconds (see join_timestamps)
                start_ts = getattr(t, "start_ts", None)
                end_ts = getattr(t, "end_ts", None)
                word = getattr(t, "text", "")
                if not word or start_ts is None or end_ts is None:
                    continue
                timings.append(
                    WordTiming(
                        word=word,
                        start_ms=offset_ms + int(round(float(start_ts) * 1000.0)),
                        end_ms=offset_ms + int(round(float(end_ts) * 1000.0)),
                    )
                )

        audio_parts.append(a_np)
        total_samples += int(a_np.shape[0])

    if not audio_parts:
        return np.zeros((0,), dtype=np.float32), _KOKORO_SR, []

    return np.concatenate(audio_parts), _KOKORO_SR, timings


@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/voices")
def voices():
    """List available Kokoro voice IDs (e.g., af_heart)."""
    return {"voices": list_kokoro_voice_ids()}


@app.get("/api/debug/device")
def debug_device():
    """Debug endpoint: report torch/cuda availability and Kokoro device placement."""
    info: dict[str, object] = {}

    try:
        import torch  # type: ignore

        info["torch_version"] = getattr(torch, "__version__", None)
        info["cuda_available"] = bool(torch.cuda.is_available())
        info["cuda_device_count"] = int(torch.cuda.device_count()) if torch.cuda.is_available() else 0
        if torch.cuda.is_available() and torch.cuda.device_count() > 0:
            try:
                info["cuda_device_0_name"] = torch.cuda.get_device_name(0)
            except Exception:
                info["cuda_device_0_name"] = None
    except Exception as e:
        info["torch_error"] = str(e)
        return info

    # Best-effort Kokoro pipeline/model device detection
    try:
        p = _get_kokoro_pipeline()
        model = getattr(p, "model", None)
        info["kokoro_pipeline_type"] = type(p).__name__
        info["kokoro_model_type"] = type(model).__name__ if model is not None else None

        device = None
        if model is not None:
            # Try typical torch.nn.Module patterns
            try:
                params = list(model.parameters())
                if params:
                    device = str(params[0].device)
            except Exception:
                device = None

            if device is None:
                # Fallback: common attribute names
                for attr in ("device", "_device"):
                    if hasattr(model, attr):
                        try:
                            device = str(getattr(model, attr))
                            break
                        except Exception:
                            pass

        info["kokoro_device"] = device
    except Exception as e:
        info["kokoro_error"] = str(e)

    return info


@app.post("/api/cache/clear")
def cache_clear():
    """Clear cached WAV/JSON files under backend/output."""
    n = clear_output_cache()
    return {"deleted": n}


@app.post("/api/upload", response_model=UploadResponse)
async def upload(file: UploadFile = File(...)):
    filename = file.filename or "uploaded"
    data = await file.read()

    if filename.lower().endswith(".pdf"):
        try:
            text = extract_text_from_pdf(data)
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Failed to extract text from PDF: {e}")
    elif filename.lower().endswith(".txt"):
        text = extract_text_from_txt(data)
    else:
        raise HTTPException(status_code=400, detail="Only .pdf and .txt are supported")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="No extractable text found")

    return UploadResponse(filename=filename, text=text)


@app.post("/api/tts", response_model=TTSResponse)
def tts(req: TTSRequest):
    voice = req.voice or _KOKORO_DEFAULT_VOICE

    book_id = sanitize_book_id(req.book_id) if req.book_id else None
    chunk_index = req.chunk_index

    # If book/chunk is provided, use book-scoped keying for deterministic storage
    if book_id is not None and chunk_index is not None:
        key = f"{book_id}:{chunk_index}:{voice}:{req.speed}"
    else:
        key = tts_cache_key(req.text, voice=voice, speed=req.speed)

    # Cache hit: return timings + URL without re-synthesizing
    if book_id is not None and chunk_index is not None:
        ensure_book_dirs(book_id)
        wav_p = chunk_wav_path(book_id, chunk_index)
        json_p = chunk_json_path(book_id, chunk_index)
        if wav_p.exists() and json_p.exists():
            meta = json.loads(json_p.read_text(encoding="utf-8"))
            timings = [WordTiming(**t) for t in meta.get("timings", [])]
            rel = f"/output/{book_id}/chunks/{chunk_index:06d}.wav"
            return TTSResponse(
                sample_rate=int(meta.get("sample_rate", _KOKORO_SR)),
                duration_ms=int(meta.get("duration_ms", 0)),
                timings=timings,
                audio_url=rel,
                cache_key=key,
            )
    else:
        if cache_exists(key):
            meta = load_metadata(key)
            timings = [WordTiming(**t) for t in meta.get("timings", [])]
            return TTSResponse(
                sample_rate=int(meta.get("sample_rate", _KOKORO_SR)),
                duration_ms=int(meta.get("duration_ms", 0)),
                timings=timings,
                audio_url=f"/output/{key}.wav",
                cache_key=key,
            )

    audio, sr, timings = _kokoro_synthesize(req.text, voice, req.speed)

    duration_ms = int(round(len(audio) / sr * 1000.0))
    if not timings:
        timings = _estimate_word_timings(req.text, duration_ms)

    # Encode as WAV for easy browser playback
    buf = io.BytesIO()
    sf.write(buf, audio, sr, format="WAV", subtype="PCM_16")
    wav_bytes = buf.getvalue()

    if book_id is not None and chunk_index is not None:
        ensure_book_dirs(book_id)
        wav_p = chunk_wav_path(book_id, chunk_index)
        json_p = chunk_json_path(book_id, chunk_index)
        wav_p.write_bytes(wav_bytes)
        json_p.write_text(
            json.dumps(
                {
                    "cache_key": key,
                    "sample_rate": sr,
                    "duration_ms": duration_ms,
                    "voice": voice,
                    "speed": req.speed,
                    "book_id": book_id,
                    "chunk_index": chunk_index,
                    "timings": timings_to_jsonable(timings),
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        # Append into combined book.wav/book.json if this is the next chunk
        append_to_combined(
            book_id,
            wav_bytes,
            sample_rate=sr,
            chunk_duration_ms=duration_ms,
            timings=timings,
            chunk_index=chunk_index,
        )

        rel = f"/output/{book_id}/chunks/{chunk_index:06d}.wav"
        return TTSResponse(
            sample_rate=sr,
            duration_ms=duration_ms,
            timings=timings,
            audio_url=rel,
            audio_wav_base64=base64.b64encode(wav_bytes).decode("ascii"),
            cache_key=key,
        )

    # Save cache to disk (global cache)
    save_cache(
        key,
        wav_bytes,
        {
            "cache_key": key,
            "sample_rate": sr,
            "duration_ms": duration_ms,
            "voice": voice,
            "speed": req.speed,
            "timings": timings_to_jsonable(timings),
        },
    )

    return TTSResponse(
        sample_rate=sr,
        duration_ms=duration_ms,
        timings=timings,
        audio_url=f"/output/{key}.wav",
        # keep base64 for backwards compatibility / fallback
        audio_wav_base64=base64.b64encode(wav_bytes).decode("ascii"),
        cache_key=key,
    )
