// Test probe: runs the real PDF decoder in this process, then reports every thread the process started on stderr.
// It takes one snapshot after the render; a pool that grew and shrank again before that is out of its scope.
import { readdirSync, readFileSync } from "node:fs";

await import("../pdf-render-worker.ts");
// JSC starts its GC helper threads with the first collection, and a small render can finish before
// one runs. A full collection starts the pool, so its size, not the render's timing, is measured.
Bun.gc(true);
const counts: Record<string, number> = {};
for (const tid of readdirSync("/proc/self/task")) {
  // Pool indexes ("Bun Pool 3") are removed, so each pool counts under one name.
  const name = readFileSync(`/proc/self/task/${tid}/comm`, "utf8").trim().replace(/ \d+$/, "");
  counts[name] = (counts[name] ?? 0) + 1;
}
// One marked line, so other decoder output on stderr cannot be mistaken for the report.
console.error(`thread-counts ${JSON.stringify(counts)}`);
