import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkSource, rule } from "./cookie-store";

test("reports each direct browser cookie store read with its location", () => {
  const findings = checkSource(
    "cookies.browser.test.ts",
    ["const cookies = await context.cookies();", "const cookie = (await page.context().cookies(page.url()))[0];"].join("\n"),
  );
  expect(findings.map(({ file, line }) => `${file}:${line}`)).toEqual(["cookies.browser.test.ts:1", "cookies.browser.test.ts:2"]);
  expect(
    findings.every(
      ({ message }) =>
        message.includes("storedCookie(page, name)") &&
        message.includes("packages/ui/test/browser") &&
        message.includes("WebKit stores document.cookie writes asynchronously") &&
        message.includes("docs-site/docs/en/contributing/testing.md"),
    ),
  ).toBe(true);
});

test.each([
  "// cookie-store: HttpOnly cookie set by the server response\nconst cookies = await context.cookies();",
  "// Inspect the server session.\n// cookie-store: HttpOnly cookie\nconst cookies = await page.context().cookies();",
])("accepts a leading line comment with a reason: %s", (source) => {
  expect(checkSource("cookies.browser.test.ts", source)).toEqual([]);
});

test.each([
  "// cookie-store:\nconst cookies = await context.cookies();",
  "// cookie-store:   \nconst cookies = await context.cookies();",
  "/* cookie-store: HttpOnly cookie */\nconst cookies = await context.cookies();",
  "const cookies = await context.cookies(); // cookie-store: HttpOnly cookie",
  "const previous = 1; // cookie-store: HttpOnly cookie\nconst cookies = await context.cookies();",
  "// cookie-store: HttpOnly cookie\nconst previous = 1;\nconst cookies = await context.cookies();",
  "page.evaluate(() => {\n// cookie-store: HttpOnly cookie\nreturn 0;\n}, context.cookies());",
])("rejects empty reasons and misplaced comments: %s", (source) => {
  expect(checkSource("cookies.browser.test.ts", source)).toHaveLength(1);
});

test("ignores unrelated identifiers, property reads, and code examples", () => {
  expect(
    checkSource(
      "cookies.test.ts",
      `
    import { cookies } from "@k2b/stdlib";
    cookies.get("theme");
    const header = request.cookies;
    const example = "context.cookies()";
    // page.context().cookies()
    await storedCookie(page, "theme");
  `,
    ),
  ).toEqual([]);
});

test("checks test files, browser suites, and browser harnesses but excludes the helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-cookie-store-"));
  try {
    const source = "await page.context().cookies();";
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui", "pwas/demo", "docs-site"] } }),
      "packages/demo/src/cookies.browser.test.ts": source,
      "packages/demo/src/cookies.spec.tsx": source,
      "packages/demo/src/cookies.browser-suite.ts": source,
      "packages/demo/src/cookies.browser-harness.tsx": source,
      "pwas/demo/src/cookies.browser.test.ts": source,
      "docs-site/src/cookies.test.ts": source,
      "scripts/cookies.test.ts": source,
      "tests/cookies.test.ts": source,
      "packages/demo/src/production.ts": source,
      "packages/ui/test/browser.ts": source,
    };
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map(({ file }) => relative(root, file!))).toEqual([
      "docs-site/src/cookies.test.ts",
      "packages/demo/src/cookies.browser-harness.tsx",
      "packages/demo/src/cookies.browser-suite.ts",
      "packages/demo/src/cookies.browser.test.ts",
      "packages/demo/src/cookies.spec.tsx",
      "pwas/demo/src/cookies.browser.test.ts",
      "scripts/cookies.test.ts",
      "tests/cookies.test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
