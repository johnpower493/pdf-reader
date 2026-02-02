export type UploadResponse = {
  filename: string;
  text: string;
  book_id?: string | null;
};

export type BookConvertRequest = {
  book_id: string;
  voice?: string | null;
  speed?: number;
};

export type BookJobStatus = {
  book_id: string;
  state: string; // idle|running|completed|failed|cancelled
  voice?: string | null;
  speed?: number | null;
  total_chunks?: number | null;
  next_chunk_index: number;
  started_at_ms?: number | null;
  updated_at_ms?: number | null;
  last_error?: string | null;
};

export type WordTiming = {
  word: string;
  start_ms: number;
  end_ms: number;
};

export type TTSResponse = {
  sample_rate: number;
  duration_ms: number;
  timings: WordTiming[];

  audio_url?: string | null;
  audio_wav_base64?: string | null;
  cache_key?: string | null;
};

export type VoicesResponse = {
  voices: string[];
};

// Configurable via Vite env var (recommended for deployments):
//   VITE_API_BASE=http://localhost:8000
// Falls back to localhost for local dev.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export async function uploadBook(file: File): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function listVoices(): Promise<VoicesResponse> {
  const res = await fetch(`${API_BASE}/api/voices`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function clearCache(): Promise<{ deleted: number }> {
  const res = await fetch(`${API_BASE}/api/cache/clear`, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function tts(
  text: string,
  voice?: string,
  speed: number = 1,
  opts?: { book_id?: string; chunk_index?: number },
): Promise<TTSResponse> {
  const res = await fetch(`${API_BASE}/api/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, voice, speed, ...opts }),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function startBookConvert(req: BookConvertRequest): Promise<BookJobStatus> {
  const res = await fetch(`${API_BASE}/api/book/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function getBookStatus(book_id: string): Promise<BookJobStatus> {
  const res = await fetch(`${API_BASE}/api/book/status?book_id=${encodeURIComponent(book_id)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type BookMeta = {
  book_id: string;
  next_chunk_index: number;
  total_duration_ms: number;
  sample_rate?: number | null;
  chunk_durations_ms: number[];
};

export async function getBookMeta(book_id: string): Promise<BookMeta> {
  const res = await fetch(`${API_BASE}/api/book/meta?book_id=${encodeURIComponent(book_id)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export type BookCombined = {
  book_id: string;
  audio_url?: string | null;
  meta_url?: string | null;
  has_audio: boolean;
  has_meta: boolean;
};

export async function getBookCombined(book_id: string): Promise<BookCombined> {
  const res = await fetch(`${API_BASE}/api/book/combined?book_id=${encodeURIComponent(book_id)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export async function cancelBookConvert(book_id: string): Promise<BookJobStatus> {
  const res = await fetch(`${API_BASE}/api/book/cancel?book_id=${encodeURIComponent(book_id)}`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
