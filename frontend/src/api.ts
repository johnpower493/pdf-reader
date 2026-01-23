export type UploadResponse = {
  filename: string;
  text: string;
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

export const API_BASE = "http://localhost:8000";

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

export function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}
