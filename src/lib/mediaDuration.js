// Length in seconds of a remote audio/video file, read from its metadata, or null if it cannot be read.
// Media elements expose duration cross-origin without CORS, so WaveSpeed CDN and pasted URLs both work.
// Feeds input-length pricing (get_duration in WaveSpeed formulas) for video edit, extend and avatar models.
export function probeMediaDuration(url, timeoutMs = 20000) {
  return new Promise(resolve => {
    if (typeof document === "undefined" || !url) { resolve(null); return; }
    const el = document.createElement("video");
    let settled = false, timer = null;
    const finish = seconds => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      el.load(); // release the connection
      resolve(seconds);
    };
    el.preload = "metadata";
    el.muted = true;
    el.onloadedmetadata = () => finish(Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null);
    el.onerror = () => finish(null);
    timer = setTimeout(() => finish(null), timeoutMs);
    el.src = url;
  });
}
