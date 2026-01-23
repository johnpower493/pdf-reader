import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { API_BASE, base64ToBlob, clearCache, listVoices, tts, uploadBook, type WordTiming } from "./api";
import { activeWordIndex } from "./highlight";
import { clearSession, loadSession, saveSession } from "./persist";

type Chunk = {
  index: number;
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

  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Playback state
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loadedChunks, setLoadedChunks] = useState<Map<number, LoadedChunk>>(() => new Map());
  const [currentChunkIndex, setCurrentChunkIndex] = useState<number>(0);
  const [globalMs, setGlobalMs] = useState<number>(0);

  // Merged word timings across loaded chunks (in strict chunk order)
  const [globalTimings, setGlobalTimings] = useState<GlobalTiming[]>([]);
  const nextMergeIndexRef = useRef<number>(0);
  const mergeOffsetMsRef = useRef<number>(0);

  // For canceling in-flight synthesis when restarting/jumping
  const genEpochRef = useRef<number>(0);

  const activeIdx = useMemo(() => activeWordIndex(globalTimings, globalMs), [globalTimings, globalMs]);

  // Precomputed prefix duration for quick offset calculations
  const prefixDurationsMs = useMemo(() => {
    const maxIdx = chunks.length;
    const prefix: number[] = new Array(maxIdx + 1).fill(0);
    for (let i = 0; i < maxIdx; i++) {
      const c = loadedChunks.get(i);
      prefix[i + 1] = prefix[i] + (c?.durationMs ?? 0);
    }
    return prefix;
  }, [chunks.length, loadedChunks]);

  const currentOffsetMs = useMemo(() => prefixDurationsMs[currentChunkIndex] ?? 0, [prefixDurationsMs, currentChunkIndex]);

  // When loadedChunks updates (prefetch can complete out-of-order), merge timings in strict chunk order.
  useEffect(() => {
    tryMergeInOrder();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedChunks]);

  // Keep globalMs in sync with audio time + current chunk offset
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
      voice,
      speed,
      chunkIndex: currentChunkIndex,
      localMs: Math.max(0, globalMs - currentOffsetMs),
    });
  }, [filename, text, voice, speed, currentChunkIndex, globalMs, currentOffsetMs]);

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
  }

  function resetPlaybackState() {
    stopAudio();
    // revoke urls only if we created blob URLs
    for (const c of loadedChunks.values()) {
      if (c.audioUrl.startsWith("blob:")) URL.revokeObjectURL(c.audioUrl);
    }
    setLoadedChunks(new Map());
    setGlobalTimings([]);
    setGlobalMs(0);
    setCurrentChunkIndex(0);

    nextMergeIndexRef.current = 0;
    mergeOffsetMsRef.current = 0;
  }

  async function onUpload() {
    if (!file) return;
    setError("");
    setLoading(true);

    // new book: reset
    genEpochRef.current++;
    resetPlaybackState();

    try {
      const res = await uploadBook(file);
      setFilename(res.filename);
      setText(res.text);
      setChunks(chunkText(res.text, 1200).map((t, i) => ({ index: i, text: t })));
      setResumeAvailable(false);
      clearSession();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  }

  async function loadChunk(idx: number, epoch: number): Promise<LoadedChunk> {
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
  }

  function tryMergeInOrder() {
    // We merge timings strictly in chunk order to avoid out-of-order prefetch scrambling.
    // We also compute offsets based on the merged duration so far.

    setGlobalTimings((prev) => {
      const alreadyMerged = new Set(prev.map((t) => t.chunkIndex));
      let nextIndex = nextMergeIndexRef.current;
      let offsetMs = mergeOffsetMsRef.current;

      const additions: GlobalTiming[] = [];
      while (true) {
        const c = loadedChunks.get(nextIndex);
        if (!c) break;
        if (alreadyMerged.has(nextIndex)) {
          // if this happens, advance safely
          offsetMs += c.durationMs;
          nextIndex += 1;
          continue;
        }

        for (const t of c.timings) {
          additions.push({
            word: t.word,
            start_ms: t.start_ms + offsetMs,
            end_ms: t.end_ms + offsetMs,
            chunkIndex: nextIndex,
            localStartMs: t.start_ms,
            localEndMs: t.end_ms,
          });
        }

        offsetMs += c.durationMs;
        nextIndex += 1;
      }

      nextMergeIndexRef.current = nextIndex;
      mergeOffsetMsRef.current = offsetMs;

      if (additions.length === 0) return prev;
      return [...prev, ...additions];
    });
  }

  async function ensureChunkReadyAndMaybePlay(idx: number, epoch: number, seekLocalMs?: number) {
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
      await a.play();
    }
  }

  async function prefetch(idx: number, epoch: number) {
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
    } catch (e: any) {
      if (String(e?.message ?? e) === "generation_cancelled") return;
      // ignore prefetch failures; main playback will surface errors
    }
  }

  async function startFrom(chunkIdx: number, seekLocalMs?: number) {
    if (!chunks.length) return;
    setError("");

    const epoch = genEpochRef.current + 1;
    genEpochRef.current = epoch;

    setLoading(true);
    try {
      // reset playback but keep text/chunks
      resetPlaybackState();
      setCurrentChunkIndex(chunkIdx);

      // Load & play chunk 1 ASAP
      await ensureChunkReadyAndMaybePlay(chunkIdx, epoch, seekLocalMs);

      // Prefetch next chunk immediately
      prefetch(chunkIdx + 1, epoch);

      // Also prefetch one more in background
      prefetch(chunkIdx + 2, epoch);
    } catch (e: any) {
      const msg = String(e?.message ?? e);
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

    genEpochRef.current++;
    resetPlaybackState();

    setFilename(s.filename);
    setText(s.text);
    setVoice(s.voice);
    setSpeed(s.speed);
    const ch = chunkText(s.text, 1200).map((t, i) => ({ index: i, text: t }));
    setChunks(ch);
    setResumeAvailable(false);

    // Give React a tick to apply chunks state, then start
    setTimeout(() => {
      startFrom(s.chunkIndex ?? 0, s.localMs ?? 0);
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

      const epoch = genEpochRef.current;
      setLoading(true);
      try {
        // ensure and play next
        await ensureChunkReadyAndMaybePlay(nextIdx, epoch);
        // prefetch further
        prefetch(nextIdx + 1, epoch);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        if (msg !== "generation_cancelled") setError(msg);
      } finally {
        setLoading(false);
      }
    };
    a.addEventListener("ended", onEnded);
    return () => a.removeEventListener("ended", onEnded);
  }, [currentChunkIndex, chunks.length, prefixDurationsMs]);

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

    // Jump to that chunk (start from it)
    await startFrom(t.chunkIndex, t.localStartMs);

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
        <div className="small">Backend: http://localhost:8000</div>
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
              disabled={!audioRef.current}
              onClick={() => (audioRef.current?.paused ? audioRef.current?.play() : audioRef.current?.pause())}
            >
              Play/Pause
            </button>
            <button
              className="button"
              disabled={loading}
              onClick={async () => {
                setError("");
                try {
                  const res = await clearCache();
                  setError(`Cleared cache files: ${res.deleted}`);
                } catch (e: any) {
                  setError(String(e?.message ?? e));
                }
              }}
            >
              Clear cache
            </button>
          </div>

          <div className="small" style={{ marginTop: 10 }}>
            Chunks: {chunks.length} | Loaded: {loadedChunks.size} | Current chunk: {currentChunkIndex + 1}/{Math.max(1, chunks.length)}
          </div>

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
