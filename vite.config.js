import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VERSION_META, buildVersion, versionContent, assertVersionTag } from "./scripts/lib/build-version.mjs";

// Every build stamps its version into index.html (Settings → Version reads it; scripts/lib/build-version.mjs) and
// fails if the tag is missing from the output, so no deploy can go out without saying which version it is.
const version = buildVersion();
const stampVersion = {
  name: "proxima-version",
  transformIndexHtml: () => [{ tag: "meta", attrs: { name: VERSION_META, content: versionContent(version) }, injectTo: "head" }],
  writeBundle(_, bundle) {
    const source = bundle["index.html"]?.source;
    try { assertVersionTag(typeof source === "string" ? source : new TextDecoder().decode(source), version); }
    catch (e) { this.error(e.message); }
  },
};

// This proxy is the key to making WaveSpeed work without CORS issues.
// When the app fetches "/wavespeed/api/v3/balance", Vite's dev server (running
// on YOUR machine, not in a browser) forwards it to api.wavespeed.ai.
// Server-to-server requests don't have CORS restrictions, so it just works.
// Your API key never leaves your machine.
export default defineConfig({
  plugins: [react(), stampVersion],
  server: {
    port: 5173,
    proxy: {
      "/wavespeed": {
        target: "https://api.wavespeed.ai",
        changeOrigin: true,
        secure: true,
        rewrite: (path) => path.replace(/^\/wavespeed/, ""),
      },
    },
  },
});
