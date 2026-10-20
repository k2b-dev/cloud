import { expect, test } from "bun:test";
import { parseSuiteTimes } from "./test-weights";

test("parses bare and timestamped suite times, ignoring headers and keeping the maximum", () => {
  const log = [
    "=== @k2b/ui ===",
    "=== integration database bootstrap ===",
    "2026-10-19T14:43:16.9438507Z === @k2b/ui ===",
    "2026-10-19T14:43:16.9438507Z === @k2b/ui src/x.browser.test.ts: 5.6s",
    "=== @k2b/ui: 12.3s",
    "=== @k2b/ui: 9.9s",
    "2026-10-19T14:43:16Z === @k2b/ui: 13.1s",
    "=== @k2b/app src/[id]/test: special.browser.test.ts: 2.4s",
    "=== zero: 0s",
    "unrelated output: 8.3s",
    "=== unfinished: 4.2s trailing output",
  ].join("\r\n");
  expect(parseSuiteTimes(log)).toEqual(
    new Map([
      ["@k2b/ui src/x.browser.test.ts", 5.6],
      ["@k2b/ui", 13.1],
      ["@k2b/app src/[id]/test: special.browser.test.ts", 2.4],
      ["zero", 0],
    ]),
  );
});
