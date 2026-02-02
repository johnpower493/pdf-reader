from __future__ import annotations

from pydantic import BaseModel, Field


class UploadResponse(BaseModel):
    filename: str
    text: str
    book_id: str | None = None


class BookConvertRequest(BaseModel):
    book_id: str
    voice: str | None = None
    speed: float = Field(1.0, ge=0.5, le=2.0)


class BookJobStatus(BaseModel):
    book_id: str
    state: str
    voice: str | None = None
    speed: float | None = None
    total_chunks: int | None = None
    next_chunk_index: int
    started_at_ms: int | None = None
    updated_at_ms: int | None = None
    last_error: str | None = None


class BookMeta(BaseModel):
    book_id: str
    next_chunk_index: int
    total_duration_ms: int
    sample_rate: int | None = None
    chunk_durations_ms: list[int]


class BookCombined(BaseModel):
    book_id: str
    audio_url: str | None = None
    meta_url: str | None = None
    has_audio: bool
    has_meta: bool


class TTSRequest(BaseModel):
    text: str = Field(..., min_length=1)
    voice: str | None = None
    speed: float = Field(1.0, ge=0.5, le=2.0)

    # Optional: group/cache output by uploaded book name
    book_id: str | None = None
    chunk_index: int | None = Field(None, ge=0)


class WordTiming(BaseModel):
    word: str
    start_ms: int
    end_ms: int


class TTSResponse(BaseModel):
    sample_rate: int
    duration_ms: int
    timings: list[WordTiming]

    # If caching is enabled, backend returns a URL to a saved .wav in /output
    audio_url: str | None = None

    # Fallback for when URL serving isn't available
    audio_wav_base64: str | None = None

    cache_key: str | None = None
