import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "cloud-code-nav-status-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
registerSsrTestPlugin({ dev: true, rootDir: root });

const { codeNavAttentionLabel } = await import("./CodeNavStatus");

test("Code navigation keeps its attention label localized, including the base-locale fallback", () => {
  expect(codeNavAttentionLabel("en")).toBe("Code needs attention");
  expect(codeNavAttentionLabel("de")).toBe("Code braucht Aufmerksamkeit");
  expect(codeNavAttentionLabel("fr")).toBe("Code needs attention");
});
