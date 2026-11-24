import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { registerSsrTestPlugin } from "../../../test/ssr-test-plugin";

// The catalog reads the locale from a Solid module (`.tsx`), so it is imported after the plugin that compiles it.
const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-v2-messages-tests-"));
registerSsrTestPlugin({ dev: true, rootDir: root });
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const { checkBehaviorMessages } = await import("./messages");

test("every locale has every behaviour message", () => {
  expect(() => checkBehaviorMessages()).not.toThrow();
});
