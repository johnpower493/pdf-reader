# Kokoro Visual Reader (frontend)

React + TypeScript + Vite UI for the Kokoro Visual Reader project.

## Prerequisites

- Node.js 18+ (recommended)
- Backend running at `http://localhost:8000`

## Setup

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Backend configuration

The API base URL is configurable via Vite env var (recommended):

- `VITE_API_BASE=http://localhost:8000`

and falls back to `http://localhost:8000` for local dev (see `src/api.ts`).

## What the UI does

- Upload `.pdf`/`.txt` and display extracted text length.
- Split text into ~1200 character chunks (`chunkText()` in `src/App.tsx`).
- Start background conversion for a book (recommended for large uploads) via `POST /api/book/convert`.
- Play audio either:
  - **Combined streaming mode**: stream `/output/<book_id>/book.wav` when available and use `/output/<book_id>/book.json` merged timings for highlighting + accurate seeking.
  - **Fallback chunk mode**: generate per chunk via `POST /api/tts` using `book_id` and `chunk_index`.
- Highlight active word (binary search in `src/highlight.ts`) and allow click-to-seek by word.
- Persist multi-book resume state (filename/text/voice/speed + playback position) in `localStorage` under key `kvtr_session_library_v1` (see `src/persist.ts`).

## Scripts

- `npm run dev` – start Vite dev server
- `npm run build` – typecheck + production build
- `npm run preview` – preview production build
- `npm run lint` – run ESLint
