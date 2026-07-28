import { defineConfig } from "vitest/config";
import path from "node:path";

// Separate from vite.config.ts on purpose: the Vite config is rooted in
// client/ for the browser build, while tests live at the CardStore seam in
// server/.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "client"),
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
  test: {
    include: ["server/**/*.test.ts", "client/**/*.test.ts", "shared/**/*.test.ts"],
    environment: "node",
  },
});
