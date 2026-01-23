export type PersistedSession = {
  filename: string;
  text: string;
  voice: string;
  speed: number;
  // resume info
  chunkIndex: number;
  localMs: number;
};

const KEY = "kvtr_session_v1";

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}

export function saveSession(s: PersistedSession) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}
