import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./browser-test-promises";

// Built from parts, so the root test runner does not take this file for a browser test.
const launcher = ["..", "..", "..", "ui", "test", "browser"].join("/");

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-browser-test-promises-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => ({ ...finding, file: relative(root, finding.file ?? "") }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports each promise matcher in Playwright tests and shared-launcher browser suites", async () => {
  const found = await findings({
    "scripts/browser.test.ts": `import type { Page } from "playwright";\n\nawait expect(read()).resolves.toBe(1); await expect(write()).rejects.toThrow();\n`,
    "packages/demo/flow.browser-suite.ts": `import { launchBrowser } from "${launcher}.ts";\nexpect(read()).resolves.toBe(1);\nexpect(write()).rejects.toThrow();\n`,
    "tests/flow.spec.tsx": `import { launchBrowser } from '${launcher}';\nexpect(read()).resolves.toBe(1);\n`,
  });
  expect(found.map(({ file, line }) => `${file}:${line}`)).toEqual([
    "packages/demo/flow.browser-suite.ts:2",
    "packages/demo/flow.browser-suite.ts:3",
    "scripts/browser.test.ts:3",
    "scripts/browser.test.ts:3",
    "tests/flow.spec.tsx:2",
  ]);
  for (const finding of found) {
    expect(finding.message).toBe(
      "await the promise and assert on its value instead of expect(...).resolves/.rejects: Bun's matcher runs a nested event loop that reorders Playwright's channel messages and can close the browser connection (#1502); see docs-site/docs/en/contributing/testing.md",
    );
  }
});

test("ignores non-Playwright tests, non-test sources, and generated directories", async () => {
  const source = `import { launchBrowser } from "${launcher}";\nexpect(read()).resolves.toBe(1);\n`;
  expect(
    await findings({
      "tests/unit.test.ts": "expect(read()).resolves.toBe(1); expect(write()).rejects.toThrow();\n",
      "src/browser.ts": source,
      ...Object.fromEntries(["node_modules", "dist", "build", "_ssr", ".local"].map((dir) => [`${dir}/flow.browser.test.ts`, source])),
    }),
  ).toEqual([]);
});

test("blanks comments and strings while preserving line numbers", async () => {
  const found = await findings({
    "flow.test.ts": [
      'import type { Page } from "playwright";',
      "// expect(read()).resolves.toBe(1);",
      "/* .rejects",
      "   .resolves */",
      'const double = "escaped \\" .resolves";',
      "const single = 'escaped \\' .rejects';",
      "const template = `multiline .resolves",
      "escaped \\` .rejects`;",
      "expect(read()) /* .rejects */ .resolves.toBe(1);",
      "expect(write()).rejects.toThrow();",
    ].join("\r\n"),
  });
  expect(found.map(({ line }) => line)).toEqual([9, 10]);
});

test("allows whitespace and optional chaining but requires an exact member name", async () => {
  const found = await findings({
    "flow.test.ts": `import type { Page } from "playwright";\nexpect(read()). resolves.toBe(1);\nexpect(write())?.rejects.toThrow();\nobject.resolvesLater; object.rejects$;\n`,
  });
  expect(found.map(({ line }) => line)).toEqual([2, 3]);
});
