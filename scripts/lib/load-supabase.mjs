// Loads src/lib/supabase.js in Node for tests: inlines the two Vite env values, appends a test-only hook that swaps in a
// fake supabase-js client, imports a temporary copy next to the original (so its relative imports resolve), and deletes
// the copy right away. Production code is never changed.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export async function loadSupabase({ url = "https://x.supabase.co", key = "pk_test", file = process.env.SUPABASE_JS } = {}) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "../../src/lib");
  let src = readFileSync(file || join(dir, "supabase.js"), "utf8")   // SUPABASE_JS=<path>: test another copy (e.g. a staged one)
    .replaceAll("import.meta.env.VITE_SUPABASE_URL", JSON.stringify(url))
    .replaceAll("import.meta.env.VITE_SUPABASE_ANON_KEY", JSON.stringify(key));
  if (src.includes("import.meta.env")) throw new Error("load-supabase: supabase.js reads another import.meta.env value");
  src += "\nexport function __setClientForTests(c) { supabase = c; }\n";
  const tmp = join(dir, `.supabase-test-${process.pid}-${Date.now()}.mjs`);
  writeFileSync(tmp, src);
  try { return await import(pathToFileURL(tmp).href); } finally { unlinkSync(tmp); }
}

// A chainable stand-in for supabase.from(table): records every call; awaiting it resolves to `answer()`.
export function fakeClient(answer = () => ({ data: null, error: null })) {
  const calls = [];
  const builder = (table) => {
    const q = { table, ops: [] };
    calls.push(q);
    const b = new Proxy({}, {
      get(_, prop) {
        if (prop === "then") return (res, rej) => Promise.resolve().then(() => answer(q)).then(res, rej);
        return (...args) => { q.ops.push([prop, ...args]); return b; };
      },
    });
    return b;
  };
  return { calls, from: builder };
}
