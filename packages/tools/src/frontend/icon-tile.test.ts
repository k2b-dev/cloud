import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "tools-icon-tile-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });

process.once("exit", () => rmSync(root, { recursive: true, force: true }));

// ShowToolHeader is private to the authenticated route; do not load its services.
test("tool header uses a shared icon tile with app ink and no inline styles", () => {
  const source = readFileSync(new URL("./[tool]/page.tsx", import.meta.url), "utf8");
  const header = source.slice(source.indexOf("const ShowToolHeader ="));
  const icon = header.match(/<div\b([^>]*)>\s*<i class=\{`\$\{props\.icon\}/)?.[1];
  const classes = icon?.match(/\bclass="([^"]*)"/)?.[1]?.split(/\s+/);
  expect(icon).toBeDefined();
  expect(classes).toContain("k2b-icon-tile");
  expect(classes).toContain("app-accent-text");
  expect(icon).not.toMatch(/\bstyle\s*=/);
  expect(source).not.toMatch(/color-mix\([^;"}]*--app-accent/);
  expect(source).not.toContain("bg-[var(--ui-selected)]");
});
