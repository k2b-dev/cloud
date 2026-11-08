import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { retiredStudioImports } from "./retired-studio";

test("rejects Studio imports, browser fallbacks and build entrypoints while retaining chat code", () => {
  const root = "/fixture";
  const file = root + "/packages/assistant/src/frontend/fixture.ts";
  const source = [
    'import "../artifacts/service";',
    'export * from "../artifacts/contracts";',
    "import(`../artifacts/html/host`);",
    'require("../cli/code-host");',
    'new URL("../artifacts/runtime/cli-host.ts",import.meta.url);',
    'Bun.file("../artifacts/migrate.ts");',
    'import "@/artifacts/database";',
    'import "../chat-code/runner-code-host";',
  ].join("\n");
  expect(retiredStudioImports(file, source, root).map((f) => f.line)).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("Assistant image has no browser installation or production Playwright package", () => {
  const root = resolve(import.meta.dir, "../..");
  const prod = readFileSync(resolve(root, "Dockerfile"), "utf8");
  const dev = readFileSync(resolve(root, "Dockerfile.dev"), "utf8");
  const extras = readFileSync(resolve(root, "packages/assistant/scripts/build-extras.ts"), "utf8");
  const pkg = JSON.parse(readFileSync(resolve(root, "packages/assistant/package.json"), "utf8"));
  expect(prod).not.toMatch(/chromium|CLOUD_CLI_CHROMIUM|playwright/i);
  expect(dev).not.toMatch(/chromium|INSTALL_CHROMIUM/i);
  expect(extras).not.toMatch(/playwright|code-host-process|artifacts\/html/);
  expect(pkg.dependencies.playwright).toBeUndefined();
  expect(pkg.dependencies["@k2b/rsql"]).toBeUndefined();
});
