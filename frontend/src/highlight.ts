import type { WordTiming } from "./api";

export function activeWordIndex(timings: WordTiming[], tMs: number): number {
  // timings are sorted; do a binary search
  let lo = 0;
  let hi = timings.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = timings[mid];
    if (tMs < w.start_ms) {
      hi = mid - 1;
    } else if (tMs > w.end_ms) {
      lo = mid + 1;
    } else {
      ans = mid;
      break;
    }
  }
  if (ans !== -1) return ans;

  // If we're between words, select the last word that started.
  lo = 0;
  hi = timings.length - 1;
  let lastStarted = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = timings[mid];
    if (w.start_ms <= tMs) {
      lastStarted = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return lastStarted;
}
