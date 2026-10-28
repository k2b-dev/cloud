import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { importTimeSpy, rule } from "./module-mocks";

const initializationMock = [
  'const limiter = spyOn(server, "rateLimit").mockReturnValue(noLimit);',
  'const { routes } = await import("./routes");',
  "limiter.mockRestore();",
].join("\n");

test("recognizes restored import-time spies without treating request-time spies as module replacements", () => {
  expect(importTimeSpy(initializationMock)).toBe(0);
  expect(importTimeSpy(initializationMock.replace("limiter.mockRestore();", "afterAll(() => limiter.mockRestore());"))).toBe(-1);
  expect(importTimeSpy(initializationMock.replace('await import("./routes")', "existingRoutes"))).toBe(-1);
  expect(importTimeSpy(initializationMock.replace("limiter.mockRestore();", "other.mockRestore();"))).toBe(-1);
  expect(
    importTimeSpy(
      initializationMock
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    ),
  ).toBe(-1);
});

const findings = async (script?: string, routesSource = "") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-module-mocks-"));
  try {
    for (const dir of ["packages/demo/src", "scripts", "tests"]) await mkdir(join(root, dir), { recursive: true });
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      "packages/demo/package.json": JSON.stringify({ name: "demo", scripts: script ? { test: script } : {} }),
      "packages/demo/src/routes.test.ts": routesSource,
      "packages/demo/src/replacement.test.ts": 'mock.module("./service", () => ({}));',
      "packages/demo/src/dom.behavior.test.ts": initializationMock,
    };
    for (const [path, source] of Object.entries(files)) await writeFile(join(root, path), source);
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() }))
      .map((finding) => ({
        file: relative(root, finding.file!),
        line: finding.line,
      }))
      .sort((a, b) => a.file.localeCompare(b.file));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([undefined, "bun test"])("rejects module replacements in a shared suite (%s)", async (script) => {
  expect(await findings(script)).toEqual([{ file: "packages/demo/src/replacement.test.ts", line: 1 }]);
});

test.each([undefined, "bun test"])("also rejects import-time spies in a shared suite (%s)", async (script) => {
  expect(await findings(script, initializationMock)).toEqual([
    { file: "packages/demo/src/replacement.test.ts", line: 1 },
    { file: "packages/demo/src/routes.test.ts", line: 1 },
  ]);
});

test("accepts package isolation and the runner's isolated behavior suite", async () => {
  expect(await findings("bun test --isolate", initializationMock)).toEqual([]);
});
