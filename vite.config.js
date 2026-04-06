import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// This proxy is the key to making WaveSpeed work without CORS issues.
// When the app fetches "/wavespeed/api/v3/balance", Vite's dev server (running
// on YOUR machine, not in a browser) forwards it to api.wavespeed.ai.
// Server-to-server requests don't have CORS restrictions, so it just works.
// Your API key never leaves your machine.
export default defineConfig({
  plugins: [react()],
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
