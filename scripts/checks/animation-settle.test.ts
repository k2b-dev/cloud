import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkSource, rule } from "./animation-settle";

test("reports each document-wide or subtree animation call without a timeline check", () => {
  const findings = checkSource(
    "settle.browser.test.ts",
    [
      'page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));',
      "page.evaluate(() => Promise.all(container.getAnimations({ subtree: true }).map((animation) => animation.finished)));",
    ].join("\n"),
  );
  expect(findings.map(({ file, line }) => `${file}:${line}`)).toEqual(["settle.browser.test.ts:1", "settle.browser.test.ts:2"]);
  expect(findings.every(({ message }) => message.includes("animation.timeline === document.timeline"))).toBe(true);
});

test("accepts filtered animation waits and specific elements without subtree", () => {
  expect(
    checkSource(
      "settle.browser.test.ts",
      `
    page.waitForFunction(() => document
      .getAnimations()
      .filter((animation) => animation.timeline === document.timeline)
      .every((animation) => animation.playState !== "running"));
    page.evaluate(() => Promise.all(container
      .getAnimations({ subtree: true })
      .filter((animation) => animation.timeline === document.timeline)
      .map((animation) => animation.finished)));
    page.evaluate(() => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  `,
    ),
  ).toEqual([]);
});

test("keeps timeline checks local to the statement and ignores code examples", () => {
  expect(
    checkSource(
      "settle.browser.test.ts",
      `
    const filtered = document.getAnimations().filter((animation) => animation.timeline === document.timeline);
    const unfiltered = document.getAnimations().map((animation) => animation.finished);
    const example = "document.getAnimations()";
    // document.getAnimations()
  `,
    ).map(({ line }) => line),
  ).toEqual([3]);
  expect(
    checkSource(
      "motion.browser.test.ts",
      `
    // This fixture has no navigation labels; count every timeline.
    const running = document.getAnimations().filter((animation) => animation.playState === "running").length;
  `,
    ),
  ).toHaveLength(1);
});

test.each([
  "// animation.timeline === document.timeline\nconst running = document.getAnimations().length;",
  'const running = document.getAnimations().map(() => "animation.timeline");',
  "const timeline = document.getAnimations().length;",
  "const running = document.getAnimations().map(() => ({ timeline: true }));",
  'const running = document.getAnimations().filter((animation) => animation["timeline"]);',
  "/* animation-settle: all timelines */\nconst running = document.getAnimations().length;",
  "// animation-settle: all timelines-extra\nconst running = document.getAnimations().length;",
  "const running = document.getAnimations().length; // animation-settle: all timelines",
  "const previous = 1; // animation-settle: all timelines\nconst running = document.getAnimations().length;",
  "// animation-settle: all timelines\nconst previous = 1;\nconst running = document.getAnimations().length;",
  "page.evaluate(() => {\n// animation-settle: all timelines\nreturn 0;\n}, document.getAnimations());",
])("reports text or misplaced markers without a timeline property access: %s", (source) => {
  expect(checkSource("settle.browser.test.ts", source)).toHaveLength(1);
});

test.each([
  "// animation-settle: all timelines\nconst running = document.getAnimations().length;",
  "// animation-settle: all timelines - Count view-transition pseudo-elements.\nconst running = document.getAnimations().length;",
  "// Count all fixture motion.\n// animation-settle: all timelines\nconst running = container.getAnimations({ subtree: true }).length;",
])("accepts an explicit leading all-timelines marker: %s", (source) => {
  expect(checkSource("motion.browser.test.ts", source)).toEqual([]);
});

test("checks test files, browser suites, and browser harnesses across workspaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-animation-settle-"));
  try {
    const source = "document.getAnimations().map((animation) => animation.finished);";
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "pwas/demo", "docs-site"] } }),
      "packages/demo/src/settle.browser.test.ts": source,
      "packages/demo/src/settle.spec.tsx": source,
      "packages/demo/src/settle.browser-suite.ts": source,
      "packages/demo/src/settle.browser-harness.tsx": source,
      "pwas/demo/src/settle.browser.test.ts": source,
      "docs-site/src/settle.test.ts": source,
      "scripts/settle.test.ts": source,
      "tests/settle.test.ts": source,
      "packages/demo/src/production.ts": source,
    };
    for (const [path, content] of Object.entries(files)) {
      const file = join(root, path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map(({ file }) => relative(root, file!))).toEqual([
      "docs-site/src/settle.test.ts",
      "packages/demo/src/settle.browser-harness.tsx",
      "packages/demo/src/settle.browser-suite.ts",
      "packages/demo/src/settle.browser.test.ts",
      "packages/demo/src/settle.spec.tsx",
      "pwas/demo/src/settle.browser.test.ts",
      "scripts/settle.test.ts",
      "tests/settle.test.ts",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
