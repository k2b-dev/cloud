import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkTestClockSource, formatBaseline, rule } from "./test-clock";

const file = "packages/demo/src/view.behavior.test.tsx";
const baseline = "scripts/checks/test-clock.baseline";
const check = (source: string) => checkTestClockSource(file, source).map(({ line }) => line);

test("finds both clock reads, including whitespace and multiple reads per line", () => {
  expect(check("new Date(); Date.now();\nnew  Date ( );\nDate . now (\n );\nnew\nDate(\n);")).toEqual([1, 1, 2, 3, 5]);
  expect(check("new Date(x); new Date(0); new Date('2026-10-14T10:00:00Z'); performance.now();")).toEqual([]);
});

test("ignores comments and preserves line numbers and quoted comment markers", () => {
  expect(
    check(`// new Date()
/* Date.now()
   new Date() */
new /* comment */ Date();
Date.now(); // new Date()
const url = "http://localhost"; new Date();
const marker = '/*'; Date.now();
`),
  ).toEqual([4, 5, 6, 7]);
});

test("finds clock reads inside strings and page scripts, including escaped quotes", () => {
  expect(check("'new Date()';\n\"Date.now()\";\n`page: new Date()`;")).toEqual([1, 2, 3]);
  expect(check(String.raw`"escaped \" // Date.now()"; 'escaped \' /* new Date()';`)).toEqual([1, 1]);
});

test("accepts a real-clock reason only in a line comment on this or the preceding line", () => {
  expect(
    check(`new Date(); // real clock: exercises clock drift
// real clock: checks the current date contract
Date.now();
new Date();
// real clock:
Date.now(); // real clock:${"   "}
/* real clock: block comments do not opt out */
new Date();
const reason = "// real clock: a string is not a comment"; Date.now();
`),
  ).toEqual([4, 6, 8, 9]);
  expect(check("// real clock: deliberate\n\nnew Date();")).toEqual([3]);
});

const workspace = async (files: Record<string, string>, counts?: ReadonlyMap<string, number>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-test-clock-"));
  if (counts) files[baseline] = formatBaseline(counts);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const run = (fix = false) => rule.run({ workspaceRoot: root, fix, flags: new Set() });
  const locations = async (fix = false) =>
    (await run(fix)).map((finding) => `${relative(root, finding.file!)}${finding.line ? `:${finding.line}` : ""}`);
  return { root, run, locations };
};

test("scopes UI tests, fixtures, harnesses and suites across every source root", async () => {
  const included = [
    file,
    "packages/demo/view.browser.test.ts",
    "packages/demo/view.render.test.tsx",
    "packages/demo/view-browser-harness.tsx",
    "packages/demo/view.browser-fixture.ts",
    "pwas/demo/view-browser-suite.ts",
    "docs-site/src/browser-harness.tsx",
  ];
  const excluded = ["packages/demo/view.test.ts", "packages/demo/browser.ts", "packages/demo/almostbrowser-harness.tsx"];
  const { root, locations } = await workspace(Object.fromEntries([...included, ...excluded].map((path) => [path, "new Date();"])));
  try {
    expect(await locations()).toEqual(included.sort().map((path) => `${path}:1`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an excess reports every finding in that file and fix never raises its count", async () => {
  const counts = new Map([[file, 1]]);
  const { root, locations } = await workspace({ [file]: "new Date();" }, counts);
  try {
    expect(await locations()).toEqual([]);
    await writeFile(join(root, file), "new Date();\nDate.now();");
    expect(await locations()).toEqual([`${file}:1`, `${file}:2`]);
    expect(await locations(true)).toEqual([`${file}:1`, `${file}:2`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lower counts fail until fix lowers them and removes empty or missing entries", async () => {
  const empty = "packages/demo/empty.browser.test.ts";
  const missing = "pwas/demo/missing.render.test.ts";
  const counts = new Map([
    [file, 2],
    [empty, 1],
    [missing, 1],
  ]);
  const { root, run, locations } = await workspace({ [file]: "new Date();", [empty]: "new Date(0);" }, counts);
  try {
    const findings = await run();
    expect(findings).toHaveLength(3);
    expect(findings.every(({ message }) => message.includes("lower/remove the entry"))).toBe(true);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
    expect(await locations(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[file, 1]])));
    expect(await locations()).toEqual([]);
    await writeFile(join(root, file), "// fixed");
    expect(await locations()).toEqual([baseline]);
    expect(await locations(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fix lowers known counts without adding a new file or hiding its findings", async () => {
  const other = "packages/demo/other.browser.test.ts";
  const { root, locations } = await workspace({ [file]: "new Date();", [other]: "Date.now();" }, new Map([[file, 2]]));
  try {
    expect(await locations(true)).toEqual([`${other}:1`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[file, 1]])));
    expect(await locations()).toEqual([`${other}:1`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
