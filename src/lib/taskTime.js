// The running time and the 1-minute progress bar of a pending or running generation. Pure; tested by
// scripts/test-live-elapsed.mjs.
// Owner 2026-10-26: "I need a 1 minute loading bar on the generations that is missing while processing with working
// seconds". Measured cause: both were drawn from task.wallClockMs, which only the page polling the generation updates,
// so another tab or device showed "⏱ 0ms" and an empty bar until the result arrived. Every page now counts from the
// start time; the polling page's own count wins when it is ahead (a start time from another device's clock may be off).

export const PROGRESS_BAR_MS = 60000;

export function liveElapsedMs(task, now = Date.now()) {
  const own = Number(task?.wallClockMs);
  const start = Number(task?.startTime);
  const since = Number.isFinite(start) ? now - start : 0;
  return Math.max(Number.isFinite(own) ? own : 0, since, 0);
}

// The bar fills over one minute and stops at 95% until the result is in.
export function progressPercent(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(95, (v / PROGRESS_BAR_MS) * 100);
}
