import { defineConfig } from "drizzle-kit";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectStorePaths } from "./server/project-store.js";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

try {
  process.loadEnvFile(path.join(appRoot, ".env"));
} catch {
  // No .env file — environment variables come from the shell.
}

const repoPath = process.env.JEEVES_REPO_PATH ?? appRoot;
const { dbPath } = resolveProjectStorePaths(repoPath);

export default defineConfig({
  schema: "./server/db/schema.ts",
  out: "./server/db/migrations",
  dialect: "sqlite",
  dbCredentials: {
    url: dbPath,
  },
});
