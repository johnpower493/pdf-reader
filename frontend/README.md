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

The API base URL is currently hard-coded in `src/api.ts`:

- `API_BASE = "http://localhost:8000"`

If you run the backend elsewhere, update that constant (or refactor to use a Vite env var).

## What the UI does

- Upload `.pdf`/`.txt` and display extracted text length.
- Split text into ~1200 character chunks (`chunkText()` in `src/App.tsx`).
- Generate audio per chunk via `POST /api/tts` using `book_id` (derived from filename) and `chunk_index`.
- Play audio, highlight active word (binary search in `src/highlight.ts`), and allow click-to-seek by word.
- Persist resume state (filename/text/voice/speed + playback position) in `localStorage` under key `kvtr_session_v1`.

## Scripts

- `npm run dev` – start Vite dev server
- `npm run build` – typecheck + production build
- `npm run preview` – preview production build
- `npm run lint` – run ESLint
