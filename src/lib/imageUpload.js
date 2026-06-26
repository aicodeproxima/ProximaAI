// ─── Client-side image downscaling before upload ───
// The Vercel `/wavespeed` external rewrite returns 502
// ROUTER_EXTERNAL_TARGET_CONNECTION_ERROR for request bodies above ~3 MB
// (proven 2026-06-26: a 3.2 MB upload 502'd in 2.3s while the same body forwarded
// fine through the Edge function). Phone photos are 5-12 MB, so source-image uploads
// always failed ("spins ~10-15s then fails"). Shrinking to <~1.5 MB keeps uploads on
// the legacy path working. (Deploy 2a will route uploads through the Edge function,
// which handles larger bodies — at which point this cap can be relaxed.)

const RASTER_RE = /^image\/(jpeg|jpg|png|webp|bmp)$/i;

/**
 * Returns a downscaled JPEG File when `file` is a large raster image, else the
 * original file untouched. Never throws — on any failure it returns the original
 * so the upload can still be attempted.
 */
export async function downscaleImage(file, opts = {}) {
  const {
    maxEdge = 2048,
    maxBytes = 1_500_000,
    mime = "image/jpeg",
    quality = 0.9,
    minQuality = 0.5,
  } = opts;

  // Only re-encode static rasters. GIF/SVG/HEIC/etc. pass through unchanged.
  if (!file || !RASTER_RE.test(file.type)) return file;
  // Already small enough → leave as-is (preserve original format/quality/alpha).
  if (file.size <= maxBytes) return file;

  let bitmap;
  try {
    bitmap = await loadBitmap(file);
  } catch {
    return file; // decode failed → upload the original and let the server decide
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;
  const scale = Math.min(1, maxEdge / Math.max(srcW, srcH));
  let w = Math.max(1, Math.round(srcW * scale));
  let h = Math.max(1, Math.round(srcH * scale));

  // Drop quality first, then dimensions, until under maxBytes.
  let q = quality;
  let blob = await encode(bitmap, w, h, mime, q);
  while (blob && blob.size > maxBytes && q > minQuality) {
    q = Math.max(minQuality, Math.round((q - 0.1) * 100) / 100);
    blob = await encode(bitmap, w, h, mime, q);
  }
  let guard = 0;
  while (blob && blob.size > maxBytes && Math.max(w, h) > 512 && guard < 6) {
    w = Math.round(w * 0.8);
    h = Math.round(h * 0.8);
    blob = await encode(bitmap, w, h, mime, minQuality);
    guard++;
  }
  if (bitmap.close) bitmap.close();
  if (!blob) return file;

  const base = (file.name || "image").replace(/\.[^.]+$/, "");
  return new File([blob], `${base}.jpg`, { type: mime, lastModified: Date.now() });
}

function loadBitmap(file) {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file).catch(() => loadViaImg(file));
  }
  return loadViaImg(file);
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

function encode(bitmap, w, h, mime, q) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha → paint white so transparent PNGs don't turn black.
  if (mime === "image/jpeg") { ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h); }
  ctx.drawImage(bitmap, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, q));
}
