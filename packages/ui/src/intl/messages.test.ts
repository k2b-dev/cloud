import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-messages-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { checkUiMessages } = await import("./messages");

describe("@k2b/ui generic messages", () => {
  test("keeps every shipped locale complete", () => {
    expect(checkUiMessages()).toEqual([]);
  });
});
