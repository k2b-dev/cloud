import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The admin page needs authenticated services; inspect only its base-column icon contract.
test("admin base icons use shared tiles with app ink and no inline styles", () => {
  const source = readFileSync(new URL("./admin.tsx", import.meta.url), "utf8");
  const icon = source.match(/<span\b([^>]*)>\s*<i class="ti ti-database"/)?.[1];
  const classes = icon?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
  expect(icon).toBeDefined();
  expect(classes).toContain("k2b-icon-tile");
  expect(classes).toContain("app-accent-text");
  expect(icon).not.toMatch(/\bstyle\s*=/);
  expect(source).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(source).not.toContain("bg-[var(--ui-selected)]");
});
