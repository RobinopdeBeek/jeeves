import fs from "node:fs";
import path from "node:path";
import type { RunFinalizeContext } from "./runner.js";

/** Exchange path harvested into artifact kind `human-review-report` (slice 9 keeps this path). */
export const HUMAN_REVIEW_REPORT_STUB_EXCHANGE = ".jeeves/human-review-report.html";

/** Minimal placeholder Human Review Report — replaced by real assemble in slice 9. */
export const HUMAN_REVIEW_REPORT_STUB_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Human Review Report (stub)</title>
</head>
<body>
  <h1>Human Review Report</h1>
  <p>Prepare Human Review stub — interactive assemble lands in slice 9.</p>
</body>
</html>
`;

/** Host-owned stub body: write placeholder report HTML; no agent, no commits. */
export async function writePrepareHumanReviewStub(
  ctx: RunFinalizeContext,
): Promise<void> {
  const abs = path.join(
    ctx.workspacePath,
    ...HUMAN_REVIEW_REPORT_STUB_EXCHANGE.split("/"),
  );
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, HUMAN_REVIEW_REPORT_STUB_HTML, "utf8");
}
