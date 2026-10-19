import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The page needs the authenticated shell; keep this class contract independent of its services.
test("admin primary destination uses the shared icon tile instead of a raw accent mix", () => {
  const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
  const span = source.match(/<span\b([^>]*)>\s*<i class=\{`\$\{primaryDestination\.icon\}/)?.[1];
  const classes = span?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
  expect(span).toBeDefined();
  expect(classes).toContain("k2b-icon-tile");
  expect(span).not.toMatch(/\bstyle=/);
  expect(source).not.toMatch(/color-mix\([^;"}]*var\(--app-accent\)/);
});
