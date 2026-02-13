 # Kokoro Visual Reader

A small **FastAPI + React** app for “visual TTS”: upload a book (`.pdf` or `.txt`), synthesize speech in **chunks**, and highlight words in the browser as audio plays.

- Backend: FastAPI serves TTS + timestamps and hosts generated audio under `/output`.
- Frontend: Vite/React UI that can play either (a) chunked audio or (b) a single combined `book.wav` stream when available, highlights the active word, supports click-to-seek, and persists multi-book resume state in `localStorage`.

## Repository layout

- `backend/` – FastAPI service
  - `backend/app/main.py` – API endpoints + Kokoro synthesis glue
  - `backend/app/text_extract.py` – PDF/TXT text extraction
  - `backend/app/cache.py` – global cache (`backend/output/<key>.wav/.json`)
  - `backend/app/book_output.py` – per-book chunk output and combined `book.wav/book.json`
- `frontend/` – React + TypeScript + Vite UI

## Quickstart

### 1) Backend (FastAPI)

Prereqs:
- Python 3.10+ recommended
- A working C++ build toolchain may be required by some audio/ML deps on your platform

Install + run:

```bash
python -m venv backend/.venv
# Windows: backend\.venv\Scripts\activate
# macOS/Linux: source backend/.venv/bin/activate
pip install -r backend/requirements.txt

# Install Kokoro (required for synthesis)
pip install git+https://github.com/hexgrad/kokoro.git

uvicorn backend.app.main:app --reload --port 8000
```

(Windows convenience script: `backend/run.ps1`.)

Backend will be available at:
- Health: `GET http://localhost:8000/api/health`
- Interactive docs: `http://localhost:8000/docs`

### 2) Frontend (Vite)

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`.

The frontend is currently configured to talk to `http://localhost:8000` (see `frontend/src/api.ts`).

## How it works

### Upload → chunk → synthesize

1. The UI uploads a `.pdf` or `.txt` to `POST /api/upload`.
2. The backend extracts text and returns it to the UI **plus** a `book_id`.
3. The extracted text is split into ~1200 character chunks.
4. Audio can be generated in two ways:
   - **Continuous background conversion** (recommended for large books): `POST /api/book/convert` will synthesize chunks sequentially in the background until complete.
   - **On-demand** chunk synthesis: `POST /api/tts` can synthesize a specific chunk when needed.
5. As chunks are generated, the backend also appends them into a best-effort combined stream:
   - `backend/output/<book_id>/book.wav`
   - `backend/output/<book_id>/book.json` (global timings + progress)
6. The UI prefers to stream the combined `book.wav` when available; otherwise it falls back to chunk playback.

### Output and caching

The backend serves a static `/output` route (mounted in `backend/app/main.py`). Files are written under `backend/output/`.

There are two caching modes:

1) **Global cache** (when `book_id`/`chunk_index` are not supplied)
- Audio: `backend/output/<cache_key>.wav`
- Metadata: `backend/output/<cache_key>.json`

2) **Book/chunk cache** (used by the UI)
- Chunk audio: `backend/output/<book_id>/chunks/<chunk_index>.wav`
- Chunk metadata: `backend/output/<book_id>/chunks/<chunk_index>.json`
- Combined outputs (best-effort, only if chunks are generated in order):
  - `backend/output/<book_id>/book.wav`
  - `backend/output/<book_id>/book.json`

The endpoint `POST /api/cache/clear` deletes only top-level `backend/output/*.wav` and `backend/output/*.json` (global cache). It does **not** delete per-book subdirectories.

### Word timings

If Kokoro provides token timestamps, they’re converted to `WordTiming`.
If not, the backend falls back to an estimated alignment that apportions time by token length (see `_estimate_word_timings()` in `backend/app/main.py`).

## API

### `GET /api/health`
Returns `{ "ok": true }`.

### `GET /api/voices`
Returns `{ "voices": string[] }` by listing `voices/*.pt` from the Hugging Face repo `hexgrad/Kokoro-82M`.

Note: This requires network access and `huggingface_hub` installed (it is included in `backend/requirements.txt`).

### `POST /api/upload`
Multipart form field: `file` (`.pdf` or `.txt`).

Response:
```json
{ "filename": "...", "text": "...", "book_id": "my_book" }
```

Notes:
- `book_id` is derived from the uploaded filename (stem) and sanitized.
- The backend also persists the uploaded text at `backend/output/<book_id>/source.txt` so background conversion can resume.
### `POST /api/tts`
Synthesize a single chunk of text.

Request body:
```json
{
  "text": "...",
  "voice": "af_heart",
  "speed": 1.0,
  "book_id": "optional",
  "chunk_index": 0
}
```

Notes:
- If `book_id` + `chunk_index` are provided, the result is written under `backend/output/<book_id>/chunks/` and appended into `book.wav/book.json` when chunks are generated in order.
- If `book_id/chunk_index` are not provided, the result is stored in the global cache (`backend/output/<cache_key>.*`).

Response:
```json
{
  "sample_rate": 24000,
  "duration_ms": 1234,
  "timings": [{"word":"Hello","start_ms":0,"end_ms":120}],
  "audio_url": "/output/...wav",
  "audio_wav_base64": "...",
  "cache_key": "..."
}
```

### `POST /api/cache/clear`
Returns `{ "deleted": number }`.

Only clears the **global** cache (`backend/output/*.wav` + `backend/output/*.json`). It does not delete per-book subdirectories.

## Book conversion APIs

### `POST /api/book/convert`
Start continuous background conversion for a book.

Request:
```json
{ "book_id": "my_book", "voice": "af_heart", "speed": 1.0 }
```

Response (`BookJobStatus`): includes `state`, `total_chunks`, and `next_chunk_index`.

### `GET /api/book/status?book_id=...`
Poll conversion progress.

### `POST /api/book/cancel?book_id=...`
Request cancellation.

### `GET /api/book/meta?book_id=...`
Return per-book persisted meta useful for fast seeking:
- `chunk_durations_ms` for the contiguous generated prefix
- `total_duration_ms`

### `GET /api/book/combined?book_id=...`
Return whether the combined streaming assets exist and their URLs:
- `audio_url`: `/output/<book_id>/book.wav`
- `meta_url`: `/output/<book_id>/book.json`

## Resume / persistence

- Backend conversion progress persists on disk under `backend/output/<book_id>/` and can be resumed by calling `POST /api/book/convert` again after a restart.
- Frontend resume state is stored in `localStorage` as a multi-book library under key `kvtr_session_library_v1` (see `frontend/src/persist.ts`).

## Troubleshooting

- **`Kokoro is not installed`**: install it with:
  ```bash
  pip install git+https://github.com/hexgrad/kokoro.git
  ```
- **No voices listed**: `GET /api/voices` needs internet access to query Hugging Face.
- **CORS errors**: backend allows Vite dev origins by default (`http://localhost:5173`). If you change the frontend port/origin, update `allow_origins` in `backend/app/main.py`.
- **Large PDFs / poor extraction**: `pypdf` extraction quality varies by document. Consider converting to text first for best results.

## Development notes

- Frontend resume state is stored in `localStorage` as a multi-book session library under key `kvtr_session_library_v1` (see `frontend/src/persist.ts`).
- The UI assumes chunk indices are stable and merges timings strictly in chunk order to avoid prefetch reordering.
