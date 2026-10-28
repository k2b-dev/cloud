import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./page-errors";

// Built from parts, so this file holds no listener of its own.
const listener = ["page.on(", '"page', 'error"', ", (error) => errors.push(error.message));"].join("");

const run = async (files: Record<string, string>, fix = false) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-page-errors-"));
  try {
    const sources: Record<string, string> = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo"] } }),
      "packages/demo/package.json": JSON.stringify({ name: "demo" }),
      ...files,
    };
    for (const [path, source] of Object.entries(sources)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix, flags: new Set() });
    const baseline = await readFile(join(root, "scripts/checks/page-errors.baseline"), "utf8").catch(() => "");
    return { found: found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? "-"}`), baseline };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("accepts pageErrors(page) and code that is not a test", async () => {
  const { found } = await run({
    "packages/demo/src/list.browser.test.ts": "const errors = pageErrors(page);\n",
    "packages/demo/scripts/smoke.ts": `${listener}\n`,
    // Only calls count, not a comment or a string that quotes one.
    "packages/demo/src/notes.browser.test.ts": `// ${listener}\nconst example = '${listener}';\n`,
  });
  expect(found).toEqual([]);
});

test("reports an own pageerror listener in tests, browser suites, and harnesses", async () => {
  const { found } = await run({
    "packages/demo/src/list.browser.test.ts": `const errors: string[] = [];\n${listener}\n`,
    "packages/demo/src/flow.browser-suite.ts": `${listener}\n`,
    "packages/demo/src/page.browser-harness.tsx": `\n\n${listener}\n`,
    "packages/demo/src/other.browser.test.ts": `page.addListener (${["'page", "error'"].join("")}, () => {});\n`,
  });
  expect(found).toEqual([
    "packages/demo/src/flow.browser-suite.ts:1",
    "packages/demo/src/list.browser.test.ts:2",
    "packages/demo/src/other.browser.test.ts:1",
    "packages/demo/src/page.browser-harness.tsx:3",
  ]);
});

test("the baseline keeps known listeners and only shrinks", async () => {
  const known = "packages/demo/src/list.browser.test.ts | 2\n";
  expect(
    (await run({ "scripts/checks/page-errors.baseline": known, "packages/demo/src/list.browser.test.ts": `${listener}\n${listener}\n` }))
      .found,
  ).toEqual([]);
  // A migrated listener must lower its entry.
  const migrated = { "scripts/checks/page-errors.baseline": known, "packages/demo/src/list.browser.test.ts": `${listener}\n` };
  expect((await run(migrated)).found).toEqual(["scripts/checks/page-errors.baseline:-"]);
  expect((await run(migrated, true)).baseline).toContain("packages/demo/src/list.browser.test.ts | 1");
});
