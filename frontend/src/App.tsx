import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import {
  API_BASE,
  base64ToBlob,
  clearCache,
  getBookCombined,
  getBookMeta,
  getBookStatus,
  listVoices,
  startBookConvert,
  tts,
  uploadBook,
  type BookJobStatus,
  type WordTiming,
} from "./api";
import { activeWordIndex } from "./highlight";
import { clearSession, listSessions, saveSession, type PersistedSession } from "./persist";
import { detectSections, type Section } from "./sections";

function fnv1a64(input: string): string {
  // Fast, non-cryptographic hash to detect mismatched resume data.
  // Returns unsigned 64-bit as hex string.
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

function formatMs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

type Chunk = {
  index: number;
  sectionIndex: number;
  sectionTitle: string;
  text: string;
};

type LoadedChunk = {
  index: number;
  audioUrl: string;
  durationMs: number;
  // timings are in chunk-local ms
  timings: WordTiming[];
};

type GlobalTiming = WordTiming & {
  chunkIndex: number;
  localStartMs: number;
  localEndMs: number;
};

function chunkText(text: string, maxChars: number = 1200): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let j = Math.min(text.length, i + maxChars);
    const slice = text.slice(i, j);
    if (j < text.length) {
      const lastBreak = Math.max(
        slice.lastIndexOf(". "),
        slice.lastIndexOf("! "),
        slice.lastIndexOf("? "),
        slice.lastIndexOf("\n\n"),
        slice.lastIndexOf(" "),
      );
      if (lastBreak > maxChars * 0.5) j = i + lastBreak + 1;
    }
    const part = text.slice(i, j).trim();
    if (part) out.push(part);
    i = j;
  }
  return out;
}

function msToS(ms: number) {
  return ms / 1000;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [filename, setFilename] = useState<string>("");
  const [bookId, setBookId] = useState<string | null>(null);
  const [text, setText] = useState<string>("");

  const [bookJob, setBookJob] = useState<BookJobStatus | null>(null);
  const [bookMeta, setBookMeta] = useState<import("./api").BookMeta | null>(null);
  const [bookCombined, setBookCombined] = useState<import("./api").BookCombined | null>(null);
  const [combinedTimings, setCombinedTimings] = useState<WordTiming[] | null>(null);

  const [voice, setVoice] = useState<string>("af_heart");
  const [availableVoices, setAvailableVoices] = useState<string[]>([]);
  const [speed, setSpeed] = useState<number>(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");
  const [status, setStatus] = useState<string>("");

  const [hasAudio, setHasAudio] = useState(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Book structure
  const [sections, setSections] = useState<Section[]>([]);
  const [currentSectionIndex, setCurrentSectionIndex] = useState<number>(0);

  // Playback state
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loadedChunks, setLoadedChunks] = useState<Map<number, LoadedChunk>>(() => new Map());
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number>(0);
  // The start of the current "global" timeline. If we start playback from a later
  // chunk (or jump ahead before earlier chunks are generated), we set this so word
  // timings can still render.
  const [baseChunkIndex, setBaseChunkIndex] = useState<number>(0);
  const [globalMs, setGlobalMs] = useState<number>(0);

  // Word timings for highlighting.
  // If combined timings exist (from /output/<book_id>/book.json), use them directly.
  // Otherwise, fall back to merging timings across loaded chunks.
  const globalTimings = useMemo((): GlobalTiming[] => {
    if (combinedTimings && combinedTimings.length > 0) {
      return combinedTimings.map((t) => ({
        word: t.word,
        start_ms: t.start_ms,
        end_ms: t.end_ms,
        chunkIndex: 0,
        localStartMs: t.start_ms,
        localEndMs: t.end_ms,
      }));
    }

    const out: GlobalTiming[] = [];
    let offsetMs = 0;

    for (let chunkIdx = baseChunkIndex; chunkIdx < chunks.length; chunkIdx++) {
      const c = loadedChunks.get(chunkIdx);
      if (!c) break; // only show contiguous loaded region

      for (const t of c.timings) {
        out.push({
          word: t.word,
          start_ms: t.start_ms + offsetMs,
          end_ms: t.end_ms + offsetMs,
          chunkIndex: chunkIdx,
          localStartMs: t.start_ms,
          localEndMs: t.end_ms,
        });
      }

      offsetMs += c.durationMs;
    }

    return out;
  }, [baseChunkIndex, chunks.length, loadedChunks, combinedTimings]);

  // For canceling in-flight synthesis when restarting/jumping
  const genEpochRef = useRef<number>(0);

  const activeIdx = useMemo(() => activeWordIndex(globalTimings, globalMs), [globalTimings, globalMs]);

  // Precomputed prefix duration for quick offset calculations (relative to baseChunkIndex)
  const prefixDurationsMs = useMemo(() => {
    const maxIdx = chunks.length;
    const prefix: number[] = [0];
    let total = 0;
    for (let i = baseChunkIndex; i < maxIdx; i++) {
      const c = loadedChunks.get(i);
      total += c?.durationMs ?? 0;
      prefix.push(total);
    }
    return prefix;
  }, [baseChunkIndex, chunks.length, loadedChunks]);

  const currentOffsetMs = useMemo(() => {
    const rel = Math.max(0, currentChunkIndex - baseChunkIndex);
    return prefixDurationsMs[rel] ?? 0;
  }, [prefixDurationsMs, currentChunkIndex, baseChunkIndex]);

  // Duration we can confidently seek within: contiguous durations from chunk 0..N
  const playablePrefixMs = useMemo(() => {
    const prefix: number[] = [0];
    let total = 0;
    for (let i = baseChunkIndex; i < chunks.length; i++) {
      const c = loadedChunks.get(i);
      if (!c) break;
      total += c.durationMs;
      prefix.push(total);
    }
    return prefix;
  }, [baseChunkIndex, chunks.length, loadedChunks]);

  const playableTotalMs = playablePrefixMs[playablePrefixMs.length - 1] ?? 0;

  const generatedTotalMs = useMemo(() => {
    // Total duration we know exists on backend (contiguous generated prefix)
    const ds = bookMeta?.chunk_durations_ms ?? [];
    return ds.reduce((a, b) => a + (b ?? 0), 0);
  }, [bookMeta]);

  const generatedPrefixMs = useMemo(() => {
    const ds = bookMeta?.chunk_durations_ms ?? [];
    const prefix: number[] = [0];
    let total = 0;
    for (const d of ds) {
      total += d ?? 0;
      prefix.push(total);
    }
    return prefix;
  }, [bookMeta]);

  function findChunkByMs(prefix: number[], ms: number): { idx: number; localMs: number } {
    // prefix has length N+1, prefix[0]=0, prefix[N]=total
    let lo = 0;
    let hi = Math.max(0, prefix.length - 1);
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if ((prefix[mid] ?? 0) <= ms) lo = mid;
      else hi = mid;
    }
    const idx = Math.max(0, Math.min(prefix.length - 2, lo));
    const start = prefix[idx] ?? 0;
    return { idx, localMs: Math.max(0, ms - start) };
  }

  const canPrevChunk = currentChunkIndex > 0;
  const canNextChunk = currentChunkIndex + 1 < chunks.length;
  const canPrevSection = currentSectionIndex > 0;
  const canNextSection = currentSectionIndex + 1 < sections.length;


  // Keep globalMs in sync with audio time.
  // - In combined mode: globalMs is just the single audio element time.
  // - In chunk mode: globalMs includes the current chunk offset.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      if (combinedTimings && bookCombined?.has_audio) setGlobalMs(a.currentTime * 1000);
      else setGlobalMs(currentOffsetMs + a.currentTime * 1000);
    };
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [currentOffsetMs, combinedTimings, bookCombined]);

  // Persist resume state (throttled-ish by timeupdate frequency)
  useEffect(() => {
    if (!text || !filename || !bookId) return;
    saveSession({
      bookId,
      filename,
      text,
      textHash: fnv1a64(text),
      voice,
      speed,
      chunkIndex: currentChunkIndex,
      sectionIndex: currentSectionIndex,
      localMs: Math.max(0, (combinedTimings && bookCombined?.has_audio ? globalMs : globalMs - currentOffsetMs)),
    });
  }, [bookId, filename, text, voice, speed, currentChunkIndex, currentSectionIndex, globalMs, currentOffsetMs]);

  // auto-scroll active word into view
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = document.getElementById(`w-${activeIdx}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  // Poll book conversion status + meta while a book is loaded.
  useEffect(() => {
    if (!bookId) return;

    let cancelled = false;
    let timer: number | undefined;

    const tick = async () => {
      try {
        const [st, meta, comb] = await Promise.all([getBookStatus(bookId), getBookMeta(bookId), getBookCombined(bookId)]);
        if (!cancelled) {
          setBookJob(st);
          setBookMeta(meta);
          setBookCombined(comb);

          // If combined meta exists, fetch merged timings for accurate highlighting.
          if (comb?.has_meta && comb.meta_url) {
            fetch(`${API_BASE}${comb.meta_url}`)
              .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed_book_json"))))
              .then((j) => {
                const t = (j?.timings ?? []) as WordTiming[];
                if (!cancelled) setCombinedTimings(t);
              })
              .catch(() => {
                // ignore
              });
          }
        }
      } catch {
        // ignore polling errors
      } finally {
        if (!cancelled) timer = window.setTimeout(tick, 2000);
      }
    };

    void tick();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [bookId]);

  // Load voices
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listVoices();
        if (!cancelled) setAvailableVoices(res.voices ?? []);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // On mount, offer resume + show recent books
  const [recentSessions, setRecentSessions] = useState<PersistedSession[]>([]);
  useEffect(() => {
    const recents = listSessions();
    setRecentSessions(recents);
  }, []);

  function stopAudio() {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
      a.src = "";
    }
    setHasAudio(false);
  }

  function onStop() {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
      // Do NOT clear src; user expects Play to resume from start of current chunk.
    }
    setHasAudio(!!audioRef.current?.src);
    setStatus("Stopped");
  }

  function resetPlaybackState() {
    stopAudio();
    // revoke urls only if we created blob URLs
    for (const c of loadedChunks.values()) {
      if (c.audioUrl.startsWith("blob:")) URL.revokeObjectURL(c.audioUrl);
    }
    setLoadedChunks(new Map());
    setGlobalMs(0);
    setCurrentChunkIndex(0);
    setBaseChunkIndex(0);

  }

  async function onUpload() {
    if (!file) return;
    setError("");
    setStatus("");
    setLoading(true);

    // new book: reset
    genEpochRef.current++;
    resetPlaybackState();

    try {
      const res = await uploadBook(file);
      setFilename(res.filename);
      setBookId(res.book_id ?? (res.filename ? res.filename.replace(/\.[^/.]+$/, "") : null));
      setText(res.text);
      setBookJob(null);
      setBookMeta(null);
      setBookCombined(null);
      setCombinedTimings(null);

      const secs = detectSections(res.text);
      setSections(secs);
      setCurrentSectionIndex(0);

      // Flatten section chunks into a single chunk list for TTS caching and playback.
      const flat: Chunk[] = [];
      for (let si = 0; si < secs.length; si++) {
        const s = secs[si]!;
        const title = (s.title || `Section ${si + 1}`).trim();
        const parts = chunkText(res.text.slice(s.start, s.end), 1200);
        for (const part of parts) {
          flat.push({ index: flat.length, sectionIndex: si, sectionTitle: title, text: part });
        }
      }
      setChunks(flat);

      // Do NOT clear other sessions; just refresh recent list.
      setRecentSessions(listSessions());
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  const loadChunk = useCallback(
    async (idx: number, epoch: number): Promise<LoadedChunk> => {
    const existing = loadedChunks.get(idx);
    if (existing) return existing;
    const chunk = chunks[idx];
    if (!chunk) throw new Error(`Chunk ${idx} not found`);

    const res = await tts(chunk.text, voice, speed, { book_id: bookId ?? undefined, chunk_index: idx });
    if (genEpochRef.current !== epoch) throw new Error("generation_cancelled");

    let url: string | null = null;
    if (res.audio_url) {
      // backend returns a relative URL like /output/<key>.wav
      url = res.audio_url.startsWith("http") ? res.audio_url : `${API_BASE}${res.audio_url}`;
    } else if (res.audio_wav_base64) {
      const blob = base64ToBlob(res.audio_wav_base64, "audio/wav");
      url = URL.createObjectURL(blob);
    }
    if (!url) throw new Error("No audio returned from backend");

    const loaded: LoadedChunk = {
      index: idx,
      audioUrl: url,
      durationMs: res.duration_ms,
      timings: res.timings,
    };

    return loaded;
    },
    [chunks, filename, loadedChunks, speed, voice],
  );

  const ensureChunkReadyAndMaybePlay = useCallback(
    async (idx: number, epoch: number, seekLocalMs?: number) => {
    // load
    const loaded = await loadChunk(idx, epoch);

    // commit to state
    setLoadedChunks((prev) => {
      const next = new Map(prev);
      next.set(idx, loaded);
      return next;
    });

    // If this is the current chunk, set audio src and play
    if (audioRef.current) {
      const a = audioRef.current;
      a.src = loaded.audioUrl;
      a.currentTime = seekLocalMs ? msToS(seekLocalMs) : 0;
      setHasAudio(true);
      await a.play();
    }
    },
    [loadChunk],
  );

  const prefetch = useCallback(
    async (idx: number, epoch: number) => {
    if (idx < 0 || idx >= chunks.length) return;
    if (loadedChunks.has(idx)) return;
    try {
      const loaded = await loadChunk(idx, epoch);
      if (genEpochRef.current !== epoch) return;
      setLoadedChunks((prev) => {
        const next = new Map(prev);
        next.set(idx, loaded);
        return next;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === "generation_cancelled") return;
      // ignore prefetch failures; main playback will surface errors
    }
    },
    [chunks.length, loadedChunks, loadChunk],
  );

  async function startFrom(chunkIdx: number, seekLocalMs?: number) {
    setError("");
    setStatus("");

    // Combined playback mode (stream single book.wav)
    if (bookId && bookCombined?.has_audio && bookCombined.audio_url && audioRef.current) {
      const a = audioRef.current;
      const url = bookCombined.audio_url.startsWith("http") ? bookCombined.audio_url : `${API_BASE}${bookCombined.audio_url}`;

      // Reset local chunk state but keep book text
      resetPlaybackState();
      setBaseChunkIndex(0);
      setCurrentChunkIndex(0);

      // Map requested chunkIdx/localMs into a single global ms, using backend chunk durations.
      const prefix = generatedPrefixMs.length > 1 ? generatedPrefixMs : playablePrefixMs;
      const chunkStart = prefix[chunkIdx] ?? 0;
      const targetMs = chunkStart + (seekLocalMs ?? 0);

      setLoading(true);
      try {
        if (a.src !== url) a.src = url;
        a.currentTime = msToS(targetMs);
        setHasAudio(true);
        await a.play();
      } finally {
        setLoading(false);
      }
      return;
    }

    // Chunk-by-chunk mode (legacy)
    if (!chunks.length) return;

    const epoch = genEpochRef.current + 1;
    genEpochRef.current = epoch;

    setLoading(true);
    try {
      // reset playback but keep text/chunks
      resetPlaybackState();
      setBaseChunkIndex(chunkIdx);
      setCurrentChunkIndex(chunkIdx);

      // Load & play selected chunk
      await ensureChunkReadyAndMaybePlay(chunkIdx, epoch, seekLocalMs);

      // Prefetch next chunk immediately
      prefetch(chunkIdx + 1, epoch);

      // Also prefetch one more in background
      prefetch(chunkIdx + 2, epoch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "generation_cancelled") setError(msg);
    } finally {
      setLoading(false);
    }
  }

  async function onSpeak() {
    if (!text.trim()) return;

    // Best-effort: start continuous background conversion so playback doesn't have to wait chunk-by-chunk.
    if (bookId) {
      startBookConvert({ book_id: bookId, voice, speed }).then(setBookJob).catch(() => {
        // non-fatal
      });
    }

    await startFrom(0);
  }

  async function onResumeSession(s: PersistedSession) {
    if (!s) return;

    // Validate resume payload to avoid resuming into mismatched/corrupted data.
    const computed = fnv1a64(s.text);
    // If hash is present, enforce it. If absent (older session), accept and proceed.
    if (s.textHash && s.textHash !== computed) {
      setError("Resume data does not match saved content (text hash mismatch). Please upload again.");
      // Clear this book's session only
      clearSession(s.bookId);
      setRecentSessions(listSessions());
      return;
    }

    genEpochRef.current++;
    resetPlaybackState();

    setFilename(s.filename);
    setBookId(s.bookId);
    setText(s.text);
    setBookJob(null);
    setBookMeta(null);
    setBookCombined(null);
    setCombinedTimings(null);
    setVoice(s.voice);
    setSpeed(s.speed);

    const secs = detectSections(s.text);
    setSections(secs);

    const flat: Chunk[] = [];
    for (let si = 0; si < secs.length; si++) {
      const sec = secs[si]!;
      const title = (sec.title || `Section ${si + 1}`).trim();
      const parts = chunkText(s.text.slice(sec.start, sec.end), 1200);
      for (const part of parts) {
        flat.push({ index: flat.length, sectionIndex: si, sectionTitle: title, text: part });
      }
    }
    setChunks(flat);

    // Best-effort: infer section index from chunk index.
    const resumeChunk = s.chunkIndex ?? 0;
    const resumeSection = flat[resumeChunk]?.sectionIndex ?? 0;
    setCurrentSectionIndex(resumeSection);

    // Give React a tick to apply chunks state, then start
    setTimeout(() => {
      startFrom(resumeChunk, s.localMs ?? 0);
    }, 0);
  }

  // When the audio element ends, advance to next chunk (generate if needed)
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;

    const onEnded = async () => {
      // In combined mode, the audio element naturally ends the book.
      if (combinedTimings && bookCombined?.has_audio) return;

      const nextIdx = currentChunkIndex + 1;
      if (nextIdx >= chunks.length) return;

      setCurrentChunkIndex(nextIdx);
      setCurrentSectionIndex(chunks[nextIdx]?.sectionIndex ?? currentSectionIndex);

      const epoch = genEpochRef.current;
      setLoading(true);
      try {
        // ensure and play next
        await ensureChunkReadyAndMaybePlay(nextIdx, epoch);
        // prefetch further
        prefetch(nextIdx + 1, epoch);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg !== "generation_cancelled") setError(msg);
      } finally {
        setLoading(false);
      }
    };
    a.addEventListener("ended", onEnded);
    return () => a.removeEventListener("ended", onEnded);
  }, [currentChunkIndex, chunks, currentSectionIndex, ensureChunkReadyAndMaybePlay, prefetch, combinedTimings, bookCombined]);

  function firstChunkIndexForSection(sectionIdx: number): number {
    const idx = chunks.findIndex((c) => c.sectionIndex === sectionIdx);
    return idx >= 0 ? idx : 0;
  }

  async function jumpToSection(sectionIdx: number) {
    if (!sections.length) return;
    const clamped = Math.max(0, Math.min(sections.length - 1, sectionIdx));
    setCurrentSectionIndex(clamped);
    const chunkIdx = firstChunkIndexForSection(clamped);
    await jumpToChunk(chunkIdx, 0);
  }

  async function jumpToChunk(chunkIdx: number, seekLocalMs?: number) {
    // In combined mode, jump by time within the single book.wav stream.
    if (bookId && bookCombined?.has_audio && bookCombined.audio_url && audioRef.current) {
      const prefix = generatedPrefixMs.length > 1 ? generatedPrefixMs : playablePrefixMs;
      const targetMs = (prefix[chunkIdx] ?? 0) + (seekLocalMs ?? 0);
      const a = audioRef.current;
      const url = bookCombined.audio_url.startsWith("http") ? bookCombined.audio_url : `${API_BASE}${bookCombined.audio_url}`;
      if (a.src !== url) a.src = url;
      a.currentTime = msToS(targetMs);
      setHasAudio(true);
      await a.play();
      return;
    }

    if (!chunks.length) return;
    if (chunkIdx < 0 || chunkIdx >= chunks.length) return;

    setError("");
    setStatus("");

    const epoch = genEpochRef.current + 1;
    genEpochRef.current = epoch;

    // If we haven't generated earlier chunks, move the base so words/timings can render.
    // Also allow user to jump back before the base.
    if (!loadedChunks.has(0)) {
      if (chunkIdx < baseChunkIndex || (baseChunkIndex === 0 && chunkIdx !== 0)) {
        setBaseChunkIndex(chunkIdx);
      }
    }

    setCurrentChunkIndex(chunkIdx);
    setCurrentSectionIndex(chunks[chunkIdx]?.sectionIndex ?? currentSectionIndex);
    setLoading(true);
    try {
      await ensureChunkReadyAndMaybePlay(chunkIdx, epoch, seekLocalMs);
      prefetch(chunkIdx + 1, epoch);
      prefetch(chunkIdx - 1, epoch);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== "generation_cancelled") setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // Click-to-seek by word
  async function onWordClick(idx: number) {
    const t = globalTimings[idx];
    if (!t) return;

    // Combined mode: timings are global, so seek directly.
    if (combinedTimings && bookCombined?.has_audio && bookCombined.audio_url && audioRef.current) {
      const a = audioRef.current;
      const url = bookCombined.audio_url.startsWith("http") ? bookCombined.audio_url : `${API_BASE}${bookCombined.audio_url}`;
      if (a.src !== url) a.src = url;
      a.currentTime = msToS(t.start_ms);
      setHasAudio(true);
      await a.play();
      return;
    }

    const epoch = genEpochRef.current;

    // If clicking within current chunk and loaded, just seek
    if (t.chunkIndex === currentChunkIndex && loadedChunks.has(currentChunkIndex) && audioRef.current) {
      audioRef.current.currentTime = msToS(t.localStartMs);
      await audioRef.current.play();
      return;
    }

    // Jump to that chunk without resetting already-generated chunks
    await jumpToChunk(t.chunkIndex, t.localStartMs);

    // Opportunistic prefetch the following chunk
    prefetch(t.chunkIndex + 1, epoch);
  }

  const words = useMemo(() => globalTimings.map((t) => t.word), [globalTimings]);

  return (
    <div className="container">
      <div className="header">
        <div>
          <div className="title">Kokoro Visual Reader</div>
          <div className="subtitle">Full-book chunked playback, word highlighting, resume, and click-to-seek.</div>
        </div>
        <div className="small">Backend: {API_BASE}</div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>Book</h2>
          <div className="row">
            <input type="file" accept=".pdf,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <button className="button" disabled={!file || loading} onClick={onUpload}>
              {loading ? "Working…" : "Upload"}
            </button>
          </div>

          {recentSessions.length > 0 && !text && (
            <div style={{ marginTop: 10 }}>
              <div className="small">Recent books</div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                {recentSessions.slice(0, 8).map((s) => (
                  <div key={s.bookId} className="row" style={{ gap: 8 }}>
                    <button className="button" onClick={() => void onResumeSession(s)}>
                      Resume
                    </button>
                    <div className="small" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.filename} — chunk {s.chunkIndex + 1} @ {formatMs(s.localMs)}
                    </div>
                    <button
                      className="button"
                      onClick={() => {
                        clearSession(s.bookId);
                        setRecentSessions(listSessions());
                      }}
                      title="Remove from recent"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="small" style={{ marginTop: 8 }}>
            {filename ? `Loaded: ${filename}` : "No book loaded"}
          </div>
          {text && (
            <div className="small" style={{ marginTop: 10 }}>
              Extracted text length: {text.length.toLocaleString()} chars
            </div>
          )}

          <h2 style={{ marginTop: 18 }}>Structure</h2>
          <div className="kv">
            <label>Section</label>
            <select
              value={currentSectionIndex}
              onChange={(e) => {
                const idx = parseInt(e.target.value, 10);
                void jumpToSection(Number.isFinite(idx) ? idx : 0);
              }}
              disabled={!sections.length || loading}
            >
              {sections.map((s, idx) => (
                <option key={idx} value={idx}>
                  {idx + 1}. {s.title}
                </option>
              ))}
            </select>
          </div>

          <h2 style={{ marginTop: 18 }}>Speech</h2>
          <div className="kv">
            <label>Voice</label>
            {availableVoices.length > 0 ? (
              <select value={voice} onChange={(e) => setVoice(e.target.value)}>
                {availableVoices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <input value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="af_heart" />
            )}
            <label>Speed</label>
            <input
              type="range"
              min={0.6}
              max={1.6}
              step={0.05}
              value={speed}
              onChange={(e) => setSpeed(parseFloat(e.target.value))}
            />
          </div>

          <div className="row">
            <button className="button" disabled={!text || loading} onClick={onSpeak}>
              {loading ? "Working…" : "Play from start"}
            </button>
            <button
              className="button"
              disabled={!hasAudio || loading}
              onClick={() => (audioRef.current?.paused ? audioRef.current?.play() : audioRef.current?.pause())}
            >
              Play/Pause
            </button>
            <button className="button" disabled={!hasAudio || loading} onClick={onStop}>
              Stop
            </button>
            <button
              className="button"
              disabled={loading || !sections.length || !canPrevSection}
              onClick={() => void jumpToSection(currentSectionIndex - 1)}
              title="Previous section"
            >
              Prev section
            </button>
            <button
              className="button"
              disabled={loading || !sections.length || !canNextSection}
              onClick={() => void jumpToSection(currentSectionIndex + 1)}
              title="Next section"
            >
              Next section
            </button>
            <button
              className="button"
              disabled={loading || !chunks.length || !canPrevChunk}
              onClick={() => void jumpToChunk(currentChunkIndex - 1)}
              title="Previous chunk"
            >
              Prev chunk
            </button>
            <button
              className="button"
              disabled={loading || !chunks.length || !canNextChunk}
              onClick={() => void jumpToChunk(currentChunkIndex + 1)}
              title="Next chunk"
            >
              Next chunk
            </button>
            <button
              className="button"
              disabled={loading}
              onClick={async () => {
                setError("");
                setStatus("");
                try {
                  const res = await clearCache();
                  setStatus(`Cleared cache files: ${res.deleted}`);
                } catch (e: unknown) {
                  const msg = e instanceof Error ? e.message : String(e);
                  setError(msg);
                }
              }}
            >
              Clear cache
            </button>
          </div>

          <div className="small" style={{ marginTop: 10 }}>
            Sections: {sections.length} | Current: {currentSectionIndex + 1}/{Math.max(1, sections.length)} | Chunks: {chunks.length} | Loaded: {loadedChunks.size} | Current chunk: {currentChunkIndex + 1}/{Math.max(1, chunks.length)}
          </div>

          {bookId && (
            <div className="small" style={{ marginTop: 6 }}>
              Background conversion: {bookJob?.state ?? "—"}
              {bookJob?.total_chunks != null ? ` (${bookJob.next_chunk_index}/${bookJob.total_chunks})` : ""}
              {bookJob?.last_error ? ` — ${bookJob.last_error}` : ""}
            </div>
          )}

          <div className="small" style={{ marginTop: 10 }}>
            Time: {formatMs(globalMs)} / {generatedTotalMs ? formatMs(generatedTotalMs) : playableTotalMs ? formatMs(playableTotalMs) : "—"}
            {baseChunkIndex > 0 ? ` (from chunk ${baseChunkIndex + 1})` : ""}
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(0, generatedTotalMs || playableTotalMs)}
            step={50}
            value={Math.min(globalMs, (generatedTotalMs || playableTotalMs) || globalMs)}
            disabled={!(generatedTotalMs || playableTotalMs) || loading}
            onChange={(e) => {
              const targetMs = Number(e.target.value);

              // Combined mode: direct seek within the single audio.
              if (combinedTimings && bookCombined?.has_audio && audioRef.current) {
                audioRef.current.currentTime = msToS(targetMs);
                void audioRef.current.play();
                return;
              }

              // Prefer backend-generated prefix mapping when available.
              if (generatedPrefixMs.length > 1) {
                const found = findChunkByMs(generatedPrefixMs, targetMs);
                void jumpToChunk(found.idx, found.localMs);
                return;
              }

              // Fallback: Find chunk within playable contiguous prefix and seek.
              let relChunk = 0;
              for (let i = 0; i < playablePrefixMs.length - 1; i++) {
                if (targetMs >= playablePrefixMs[i] && targetMs < playablePrefixMs[i + 1]) {
                  relChunk = i;
                  break;
                }
              }
              const chunkIdx = baseChunkIndex + relChunk;
              const localMs = targetMs - (playablePrefixMs[relChunk] ?? 0);

              // If seeking within the currently playing loaded chunk, do a cheap seek.
              if (chunkIdx === currentChunkIndex && loadedChunks.has(chunkIdx) && audioRef.current) {
                audioRef.current.currentTime = msToS(localMs);
                void audioRef.current.play();
                return;
              }

              void jumpToChunk(chunkIdx, localMs);
            }}
            style={{ width: "100%", marginTop: 6 }}
            title="Seek within generated audio"
          />

          {status && (
            <div className="small" style={{ marginTop: 12 }}>
              {status}
            </div>
          )}
          {error && (
            <div className="error" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>

        <div className="card">
          <h2>Reader</h2>
          <audio ref={audioRef} controls style={{ width: "100%", marginBottom: 12 }} />
          <div className="reader">
            {words.length === 0 ? (
              <div className="small">Click Play from start. Words appear as chunks are generated.</div>
            ) : (
              words.map((w, idx) => (
                <span
                  id={`w-${idx}`}
                  key={idx}
                  className={`word ${idx === activeIdx ? "active" : ""}`}
                  onClick={() => onWordClick(idx)}
                  style={{ cursor: "pointer" }}
                  title="Click to play from here"
                >
                  {w}{" "}
                </span>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
