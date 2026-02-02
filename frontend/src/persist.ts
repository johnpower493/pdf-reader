export type PersistedSession = {
  // identity
  bookId: string;
  filename: string;

  // content
  text: string;
  // Added in v2 of the persisted format. Optional for backward compatibility.
  textHash?: string;

  // playback settings
  voice: string;
  speed: number;

  // resume info
  chunkIndex: number;
  sectionIndex?: number;
  localMs: number;

  // metadata
  updatedAtMs: number;
};

// Legacy single-session key (v1)
const LEGACY_KEY = "kvtr_session_v1";

// New multi-book library key
const LIB_KEY = "kvtr_session_library_v1";

export type SessionLibrary = {
  lastBookId?: string;
  sessions: Record<string, PersistedSession>;
};

function loadLibrary(): SessionLibrary {
  try {
    const raw = localStorage.getItem(LIB_KEY);
    if (!raw) return { sessions: {} };
    const parsed = JSON.parse(raw) as SessionLibrary;
    return { lastBookId: parsed.lastBookId, sessions: parsed.sessions ?? {} };
  } catch {
    return { sessions: {} };
  }
}

function saveLibrary(lib: SessionLibrary) {
  try {
    localStorage.setItem(LIB_KEY, JSON.stringify(lib));
  } catch {
    // ignore
  }
}

export function listSessions(): PersistedSession[] {
  const lib = loadLibrary();
  return Object.values(lib.sessions).sort((a, b) => (b.updatedAtMs ?? 0) - (a.updatedAtMs ?? 0));
}

export function loadSession(bookId?: string): PersistedSession | null {
  // Prefer new library
  const lib = loadLibrary();
  const bid = bookId ?? lib.lastBookId;
  if (bid && lib.sessions[bid]) return lib.sessions[bid] ?? null;

  // Backward compat: if legacy exists, surface it as a one-off session
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const legacy = JSON.parse(raw) as Omit<PersistedSession, "bookId" | "updatedAtMs"> & { bookId?: string };
    // Attempt to derive a stable bookId; if absent, fall back to filename stem.
    const derivedBookId = legacy.bookId ?? (legacy.filename ? legacy.filename.replace(/\.[^/.]+$/, "") : "book");
    return {
      ...legacy,
      bookId: derivedBookId,
      updatedAtMs: Date.now(),
    } as PersistedSession;
  } catch {
    return null;
  }
}

export function saveSession(s: Omit<PersistedSession, "updatedAtMs">) {
  const lib = loadLibrary();
  const full: PersistedSession = { ...s, updatedAtMs: Date.now() };
  lib.sessions[full.bookId] = full;
  lib.lastBookId = full.bookId;
  saveLibrary(lib);

  // Cleanup legacy to prevent confusion
  try {
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    // ignore
  }
}

export function clearSession(bookId?: string) {
  const lib = loadLibrary();
  if (!bookId) {
    // Clear everything
    saveLibrary({ sessions: {} });
    try {
      localStorage.removeItem(LEGACY_KEY);
    } catch {
      // ignore
    }
    return;
  }

  delete lib.sessions[bookId];
  if (lib.lastBookId === bookId) delete lib.lastBookId;
  saveLibrary(lib);
}
