import { defineConfig } from "vite";

// Dev server on 5173. The page talks to the API at http://127.0.0.1:8787 by
// default (see src/config.ts). If the API does not send CORS headers, start
// the page with VITE_OPENLID_API_BASE=same-origin and this proxy forwards /api.
const apiTarget = process.env.OPENLID_API_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
});
