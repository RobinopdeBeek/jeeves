import fs from "node:fs";
import path from "node:path";
import type { RunFinalizeContext } from "./runner.js";

/** Exchange path harvested into artifact kind `eval` (slice 9 keeps this path). */
export const PREPEVAL_STUB_EXCHANGE = ".jeeves/eval.html";

/** Minimal placeholder Evaluation — replaced by real eval-assemble in slice 9. */
export const PREPEVAL_STUB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Evaluation (stub)</title>
</head>
<body>
  <h1>Evaluation</h1>
  <p>Prepare Eval stub — interactive assemble lands in slice 9.</p>
</body>
</html>
`;

/** Host-owned stub body: write placeholder eval.html; no agent, no commits. */
export async function writePrepareEvalStub(
  ctx: RunFinalizeContext,
): Promise<void> {
  const abs = path.join(ctx.workspacePath, ...PREPEVAL_STUB_EXCHANGE.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, PREPEVAL_STUB_HTML, "utf8");
}
