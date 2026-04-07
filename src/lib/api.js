// ─── WaveSpeed API Integration ───

const API_BASE = "/wavespeed/api/v3";

export async function proxiedFetch(url, options = {}) {
  const res = await fetch(url, options);
  return { res, proxyIndex: 0 };
}

export async function submitTask(apiKey, modelSlug, payload) {
  const url = `${API_BASE}/${modelSlug}`;
  const { res } = await proxiedFetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw { code: res.status, message: err.message || res.statusText };
  }
  return res.json();
}

export async function pollResult(apiKey, pollUrl) {
  // Rewrite absolute WaveSpeed URLs to go through our proxy
  let target = pollUrl;
  if (pollUrl.startsWith("http")) {
    target = pollUrl.replace(/^https?:\/\/api\.wavespeed\.ai/, "/wavespeed");
  } else if (!pollUrl.startsWith("/wavespeed")) {
    target = `${API_BASE}${pollUrl}`;
  }
  const { res } = await proxiedFetch(target, {
    headers: { "Authorization": `Bearer ${apiKey}` },
  });
  if (!res.ok) throw { code: res.status, message: res.statusText };
  return res.json();
}

export async function checkBalance(apiKey) {
  try {
    const { res } = await proxiedFetch(`${API_BASE}/balance`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { error: `HTTP ${res.status}${txt ? ": " + txt.slice(0, 150) : ""}`, balance: null };
    }
    const data = await res.json();
    const bal = data?.data?.balance ?? data?.balance ?? null;
    return { error: null, balance: typeof bal === "number" ? bal.toFixed(2) : bal };
  } catch (e) {
    return { error: e.message || "Network error", balance: null };
  }
}

export async function uploadMedia(apiKey, file) {
  const formData = new FormData();
  formData.append("file", file);
  const { res } = await proxiedFetch(`${API_BASE}/media/upload/binary`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
  const data = await res.json();
  return data?.data?.download_url || data?.data?.url;
}

export { API_BASE };
