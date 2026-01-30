# Kokoro Visual Reader

A small **FastAPI + React** app for “visual TTS”: upload a book (`.pdf` or `.txt`), synthesize speech in **chunks**, and highlight words in the browser as audio plays.

- Backend: FastAPI serves TTS + timestamps and hosts generated audio under `/output`.
- Frontend: Vite/React UI that plays chunked audio, highlights the active word, supports click-to-seek, and persists resume state in `localStorage`.

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
2. The extracted text is split into ~1200 character chunks (see `chunkText()` in `frontend/src/App.tsx`).
3. Each chunk is synthesized on-demand with `POST /api/tts`.
4. The backend returns:
   - audio (preferably a URL under `/output/...`)
   - `duration_ms`
   - `timings`: a list of `{ word, start_ms, end_ms }`
5. The UI merges chunk-local timings into global timings to drive word highlighting + click-to-seek.

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
{ "filename": "...", "text": "..." }
```

### `POST /api/tts`
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

## Troubleshooting

- **`Kokoro is not installed`**: install it with:
  ```bash
  pip install git+https://github.com/hexgrad/kokoro.git
  ```
- **No voices listed**: `GET /api/voices` needs internet access to query Hugging Face.
- **CORS errors**: backend allows Vite dev origins by default (`http://localhost:5173`). If you change the frontend port/origin, update `allow_origins` in `backend/app/main.py`.
- **Large PDFs / poor extraction**: `pypdf` extraction quality varies by document. Consider converting to text first for best results.

## Development notes

- Frontend resume state is stored in `localStorage` under key `kvtr_session_v1` (see `frontend/src/persist.ts`).
- The UI assumes chunk indices are stable and merges timings strictly in chunk order to avoid prefetch reordering.
