import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Load .env so the proxy target and client port honour the same
// JEEVES_PORT/JEEVES_CLIENT_PORT overrides the server and port guard use.
try {
  process.loadEnvFile(path.resolve(__dirname, ".env"));
} catch {
  // No .env — fall back to defaults / shell env.
}

// Fixed dev ports. Kept in sync with server/index.ts (JEEVES_PORT) and
// scripts/ensure-ports.ts, which frees these ports before dev starts.
const serverPort = Number(process.env.JEEVES_PORT ?? 3939);
const clientPort = Number(process.env.JEEVES_CLIENT_PORT ?? 3940);

// The client is a Vite project rooted in client/; production output goes to
// client/dist, which the Hono server serves as static files.
export default defineConfig({
  root: "client",
  publicDir: path.resolve(__dirname, "public"),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    host: true,
    // strictPort: fail loudly instead of wandering to 5174 when the port is
    // taken. ensure-ports frees clientPort first, so this should never fire.
    port: clientPort,
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${serverPort}`,
      "/ws": {
        target: `ws://127.0.0.1:${serverPort}`,
        ws: true,
      },
    },
  },
});
