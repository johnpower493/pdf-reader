import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { API_BASE, base64ToBlob, clearCache, listVoices, tts, uploadBook, type WordTiming } from "./api";
import { activeWordIndex } from "./highlight";
import { clearSession, loadSession, saveSession } from "./persist";
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
  const [text, setText] = useState<string>("");

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

  // Merged word timings across loaded chunks (in strict chunk order).
  // Derived from `loadedChunks` to avoid race conditions and ensure the reader
  // always shows words as soon as chunks are available.
  const globalTimings = useMemo((): GlobalTiming[] => {
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
  }, [baseChunkIndex, chunks.length, loadedChunks]);

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

  const canPrevChunk = currentChunkIndex > 0;
  const canNextChunk = currentChunkIndex + 1 < chunks.length;
  const canPrevSection = currentSectionIndex > 0;
  const canNextSection = currentSectionIndex + 1 < sections.length;


  // Keep globalMs in sync with audio time + current chunk offset.
  // Note: globalMs is relative to baseChunkIndex (not necessarily chunk 0).
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => {
      setGlobalMs(currentOffsetMs + a.currentTime * 1000);
    };
    a.addEventListener("timeupdate", onTime);
    return () => a.removeEventListener("timeupdate", onTime);
  }, [currentOffsetMs]);

  // Persist resume state (throttled-ish by timeupdate frequency)
  useEffect(() => {
    if (!text || !filename) return;
    saveSession({
      filename,
      text,
      textHash: fnv1a64(text),
      voice,
      speed,
      chunkIndex: currentChunkIndex,
      sectionIndex: currentSectionIndex,
      localMs: Math.max(0, globalMs - currentOffsetMs),
    });
  }, [filename, text, voice, speed, currentChunkIndex, currentSectionIndex, globalMs, currentOffsetMs]);

  // auto-scroll active word into view
  useEffect(() => {
    if (activeIdx < 0) return;
    const el = document.getElementById(`w-${activeIdx}`);
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

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

  // On mount, offer resume
  const [resumeAvailable, setResumeAvailable] = useState(false);
  useEffect(() => {
    const s = loadSession();
    setResumeAvailable(!!s);
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
      setText(res.text);

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

      setResumeAvailable(false);
      clearSession();
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

    const bookId = filename ? filename.replace(/\.[^/.]+$/, "") : undefined;
    const res = await tts(chunk.text, voice, speed, { book_id: bookId, chunk_index: idx });
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
    if (!chunks.length) return;
    setError("");
    setStatus("");

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
    await startFrom(0);
  }

  async function onResume() {
    const s = loadSession();
    if (!s) return;

    // Validate resume payload to avoid resuming into mismatched/corrupted data.
    const computed = fnv1a64(s.text);
    // If hash is present, enforce it. If absent (older session), accept and proceed.
    if (s.textHash && s.textHash !== computed) {
      setError("Resume data does not match saved content (text hash mismatch). Please upload again.");
      clearSession();
      setResumeAvailable(false);
      return;
    }

    genEpochRef.current++;
    resetPlaybackState();

    setFilename(s.filename);
    setText(s.text);
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

    setResumeAvailable(false);

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
  }, [currentChunkIndex, chunks, currentSectionIndex, ensureChunkReadyAndMaybePlay, prefetch]);

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

          {resumeAvailable && !text && (
            <div style={{ marginTop: 10 }}>
              <div className="small">Resume your last session?</div>
              <div className="row" style={{ marginTop: 8 }}>
                <button className="button" onClick={onResume}>
                  Resume
                </button>
                <button
                  className="button"
                  onClick={() => {
                    clearSession();
                    setResumeAvailable(false);
                  }}
                >
                  Dismiss
                </button>
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

          <div className="small" style={{ marginTop: 10 }}>
            Time: {formatMs(globalMs)} / {playableTotalMs ? formatMs(playableTotalMs) : "—"}
            {baseChunkIndex > 0 ? ` (from chunk ${baseChunkIndex + 1})` : ""}
          </div>

          <input
            type="range"
            min={0}
            max={Math.max(0, playableTotalMs)}
            step={50}
            value={Math.min(globalMs, playableTotalMs || globalMs)}
            disabled={!playableTotalMs || loading}
            onChange={(e) => {
              const targetMs = Number(e.target.value);
              // Find chunk within playable contiguous prefix and seek.
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
