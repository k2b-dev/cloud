import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerSsrTestPlugin } from "../../../../ui/test/ssr-test-plugin";

const root = mkdtempSync(join(tmpdir(), "tools-screens-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { toolScreens } = await import("./screens");
const { tools } = await import("../tools/registry");

// The tool page renders only v2 screens (the v1 frame is gone): a tool in the registry without one would be a 404.
test("every tool in the registry has its v2 screen, and no screen is left without a tool", () => {
  expect(Object.keys(toolScreens).sort()).toEqual(tools.map((tool) => tool.id).sort());
});
