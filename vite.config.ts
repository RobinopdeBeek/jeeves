import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

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
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});
