import { defineConfig } from "vitest/config";

// Separate from vite.config.ts on purpose: the Vite config is rooted in
// client/ for the browser build, while tests live at the CardStore seam in
// server/.
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "client/**/*.test.ts"],
    environment: "node",
  },
});
