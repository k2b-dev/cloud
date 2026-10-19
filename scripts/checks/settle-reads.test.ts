import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkSettleReadsSource, formatBaseline, rule } from "./settle-reads";

const file = "packages/demo/src/view.browser.test.ts";
const baseline = "scripts/checks/settle-reads.baseline";
const read = "await page.evaluate(() => getComputedStyle(document.body).opacity);";
const dirtyRead = `await page.click("button");\n${read}`;
const check = (source: string) => checkSettleReadsSource(file, source).map(({ line }) => line);

test.each([
  "click",
  "goto",
  "reload",
  "goBack",
  "goForward",
  "setContent",
  "dblclick",
  "tap",
  "press",
  "hover",
  "fill",
  "type",
  "check",
  "focus",
  "dispatchEvent",
  "emulateMedia",
  "setViewportSize",
  "newPage",
])("flags a read after %s", (action) => {
  expect(check(`async function sample() {\nawait page.${action}("target");\n${read}\n}`)).toEqual([3]);
});

test.each(["page.mouse.move(0, 0)", "keyboard.press('Enter')", "page.touchscreen.tap(0, 0)", "mouse.wheel(0, 10)"])(
  "flags a read after device input: %s",
  (action) => {
    expect(check(`async () => {\nawait ${action};\n${read}\n}`)).toEqual([3]);
  },
);

test.each(["getComputedStyle", "getBoundingClientRect", "getClientRects", "checkVisibility", "elementFromPoint"])(
  "recognizes %s in evaluate/evaluateAll callbacks",
  (api) => {
    expect(
      check(
        `async () => { await page.click('button');\nawait page.evaluate(() => document.body.${api}());\nawait page.locator('p').evaluateAll(elements => elements.map(el => el.${api}())); }`,
      ),
    ).toEqual([2, 3]);
  },
);

test("recognizes read calls made through identifiers", () => {
  expect(
    check(`async () => { await page.click('p');
await evaluate(() => getComputedStyle(document.body));
await evaluateAll(elements => elements.map(el => el.getClientRects()));
await boundingBox(); }`),
  ).toEqual([2, 3, 4]);
});

test("flags boundingBox after hover and every read until the next settle", () => {
  expect(check(`async () => {\nawait page.hover('p');\nawait page.locator('p').boundingBox();\n${read}\n${read}\n}`)).toEqual([3, 4, 5]);
});

test.each([
  "settled(page)",
  "launcher.settled(page)",
  "page.waitForFunction(() => ready)",
  "expect.poll(() => ready)",
  "page.locator('p').waitFor()",
  "keptThrough(locator, change)",
  "mostAtOnce(page, 'p', change)",
])("accepts a read after %s", (settle) => {
  expect(check(`async () => { await page.click('button'); await ${settle}; ${read} }`)).toEqual([]);
});

test("catches the OAuth pattern through a page opener and read helper", () => {
  const source = `
const open = async (): Promise<Page> => {
  const page = await browser.newPage();
  await page.goto(url);
  await page.evaluate(async () => { await document.fonts.ready; });
  return page;
};
const layoutOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).opacity);
test('layout', async () => {
  const page = await open();
  const layout = await layoutOf(page);
});`;
  expect(check(source)).toEqual([11]);
  expect(check(source.replace("  return page;", "  await settled(page);\n  return page;"))).toEqual([]);
});

test("a declared Page return dirties a caller unless the helper ends in a settle", () => {
  const source = `const open = async (): Promise<Page> => acquirePage();
async function sample() { await open();\n${read} }`;
  expect(check(source)).toEqual([3]);
  expect(check(source.replace("acquirePage()", "{ await settled(page); return page; }"))).toEqual([]);
});

test("propagates summaries through helpers regardless of declaration order", () => {
  expect(
    check(`
const outer = async () => middle();
const middle = async () => inner();
function inner() { return page.goto(url); }
async function sample() {
  await outer();
  await layoutOf(page);
}
const layoutOf = (page) => readLayout(page);
const readLayout = (page) => page.evaluate(measure);
function measure() { return getComputedStyle(document.body).opacity; }
`),
  ).toEqual([7]);
});

test("an evaluate callback reads only through what it defines itself, not through Node-side names", () => {
  // The callback runs in the page: `heights` in its type is no call of the same-file `heights` helper.
  expect(
    check(`
const heights = (selector) => page.locator(selector).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
async function sample() {
  await page.click("button");
  await page.evaluate(() => (window as unknown as { heights: Map<string, number[]> }).heights);
  await page.evaluate(() => { const measure = () => document.body.getBoundingClientRect().height; return measure(); });
}
`),
  ).toEqual([6]);
});

test("a helper contributes its leading read before its final action or settle", () => {
  expect(
    check(`
const readThenSettle = async () => { ${read} await settled(page); };
const readThenAct = async () => { ${read} await page.click('p'); };
async function sample() {
  await page.goto(url);
  await readThenSettle();
  ${read}
  await readThenAct();
  ${read}
}`),
  ).toEqual([6, 9]);
});

test("keeps nested functions independent and ignores evaluates without a read API", () => {
  expect(
    check(`async function sample() {
  await page.click('p');
  const nested = async () => { ${read} };
  function declared() { ${read} }
  const expression = async function () { ${read} };
  const object = { async method() { ${read} } };
  await page.evaluate(() => document.body.textContent);
}`),
  ).toEqual([]);
  expect(check(`const object = { async method() {\n${dirtyRead}\n} };`)).toEqual([3]);
});

test("walks nested control-flow blocks as one source-ordered flow", () => {
  expect(
    check(`async () => {
  if (condition) { await page.click('p'); }
  for (const value of values) { ${read} }
  while (condition) { ${read} }
  try { ${read} } catch { await settled(page); }
  switch (value) { case 1: ${read} }
}`),
  ).toEqual([3, 4, 5]);
});

test("visits call receivers and arguments before the call", () => {
  expect(
    check(`async () => {
  await page.click('p');
  await settled(page, page.evaluate(() => document.body.getBoundingClientRect()));
  ${read}
  await settled(page).then(await page.click('p'));
  ${read}
}`),
  ).toEqual([3, 6]);
});

test("allows a reason on the read line or directly above, but not an empty marker", () => {
  const source = `async () => {
await page.click('p');
${read} // settled: the first frame is the subject
// settled: the unsettled moment is the subject
${read}
// settled:
${read} // settled:${"   "}
${read}
}`;
  expect(check(source)).toEqual([7, 8]);
  const findings = checkSettleReadsSource(file, source);
  expect(findings[0]?.message).toContain("reason must be non-empty");
  expect(findings[1]?.message).toContain("reason must be non-empty");
});

test("strings, block comments and distant markers do not opt out", () => {
  expect(
    check(`async () => {
await page.click('p');
const fake = '// settled: not a comment'; ${read}
/* settled: not a line comment */
${read}
// settled: too far away

${read}
}`),
  ).toEqual([3, 5, 8]);
});

test("finds opt-outs after template expressions and ignores template text", () => {
  expect(
    check(
      "async () => {\nconst url = `https://${host}/page`;\nawait page.goto(url);\n// settled: the unsettled moment is the subject\n" +
        read +
        "\n}",
    ),
  ).toEqual([]);
  expect(
    check("async () => {\nawait page.goto(url);\nconst template = `value ${name} // settled: not a comment`; " + read + "\n}"),
  ).toEqual([3]);
});

test("property names and bindings do not reference same-file reader helpers", () => {
  expect(
    check(`const style = () => getComputedStyle(document.body);
async () => {
  await page.click('p');
  await page.evaluate(() => { const element = document.body; element.style.opacity = "1"; return { style: "opacity" }; });
  await page.evaluate(() => { const style = "opacity"; return document.body.textContent; });
}`),
  ).toEqual([]);
});

test("recursive helpers converge without descending into their bodies at call sites", () => {
  expect(check(`const cycle = () => cycle(); async () => { cycle(); ${read} }`)).toEqual([]);
});

const workspace = async (files: Record<string, string>, counts?: ReadonlyMap<string, number>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-settle-reads-"));
  const contents = {
    "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "pwas/demo", "docs-site"] } }),
    ...files,
    ...(counts ? { [baseline]: formatBaseline(counts) } : {}),
  };
  for (const [path, content] of Object.entries(contents)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const run = (fix = false) => rule.run({ workspaceRoot: root, fix, flags: new Set() });
  const locations = async (fix = false) =>
    (await run(fix)).map((finding) => `${relative(root, finding.file!)}${finding.line ? `:${finding.line}` : ""}`);
  return { root, run, locations };
};

test("checks only browser tests, suites and harnesses in workspaces, scripts and tests", async () => {
  const included = [
    file,
    "packages/demo/view.browser-suite.ts",
    "packages/demo/view.browser-harness.tsx",
    "pwas/demo/view.browser.test.ts",
    "docs-site/src/view.browser.test.ts",
    "scripts/view.browser.test.ts",
    "tests/view.browser.test.ts",
  ];
  const excluded = [
    "packages/demo/view.test.ts",
    "packages/demo/view.browser.test.tsx",
    "packages/demo/view.ts",
    "other/view.browser.test.ts",
    "packages/demo/dist/view.browser.test.ts",
    "packages/demo/node_modules/view.browser.test.ts",
  ];
  const { root, locations } = await workspace(Object.fromEntries([...included, ...excluded].map((path) => [path, dirtyRead])));
  try {
    expect(await locations()).toEqual(included.sort().map((path) => `${path}:2`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an excess reports all reads and fix never raises the baseline", async () => {
  const counts = new Map([[file, 1]]);
  const { root, locations } = await workspace({ [file]: `${dirtyRead}\n${read}` }, counts);
  try {
    expect(await locations()).toEqual([`${file}:2`, `${file}:3`]);
    expect(await locations(true)).toEqual([`${file}:2`, `${file}:3`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lower counts fail until fix lowers them and removes empty or missing entries", async () => {
  const empty = "packages/demo/empty.browser.test.ts";
  const missing = "packages/demo/missing.browser.test.ts";
  const counts = new Map([
    [file, 2],
    [empty, 1],
    [missing, 1],
  ]);
  const { root, run, locations } = await workspace({ [file]: dirtyRead, [empty]: "// fixed" }, counts);
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

test("fix lowers known counts without adding a new file or hiding its reads", async () => {
  const other = "packages/demo/other.browser.test.ts";
  const { root, locations } = await workspace({ [file]: dirtyRead, [other]: dirtyRead }, new Map([[file, 2]]));
  try {
    expect(await locations(true)).toEqual([`${other}:2`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[file, 1]])));
    expect(await locations()).toEqual([`${other}:2`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("resolves a helper name in the scope that declares it", () => {
  // A browser-side `box` inside an evaluate callback does not hide the Node-side reader of the same name.
  expect(
    check(`
const box = (page) => page.locator("p").boundingBox();
async function sample() {
  await page.evaluate(() => { const box = () => 1; return box(); });
  await page.click("p");
  await box(page);
}
`),
  ).toEqual([6]);
});

test("a settle counts only when the flow waits for it", () => {
  expect(
    check(`async () => {
  await page.click("button");
  settled(page);
  void expect.poll(() => ready);
  await page.locator("p").boundingBox();
}`),
  ).toEqual([5]);
  expect(
    check(`const open = async () => { await page.goto(url); return settled(page); };
const ready = () => settled(page);
async function sample() { await open(); await page.click("p"); await ready(); await page.locator("p").boundingBox(); }`),
  ).toEqual([]);
  // Beside other work in Promise.all or race, a settle does not finish before that work reads.
  expect(check(`async () => { await page.click("p"); await Promise.all([settled(page), page.locator("p").boundingBox()]); }`)).toEqual([1]);
  expect(check(`async () => { await page.click("p"); await Promise.race([settled(page), Promise.resolve()]); ${read} }`)).toEqual([1]);
});

test("a parameter or variable shadows a helper of the same name", () => {
  expect(
    check(`const box = (page) => page.locator("p").boundingBox();
const ready = async () => { await settled(page); };
async function sample(box: () => string) { await page.click("p"); box(); }
async function other() { const ready = () => undefined; await page.click("p"); await ready(); await page.locator("p").boundingBox(); }`),
  ).toEqual([4]);
});

test("a settle whose promise is discarded does not count", () => {
  expect(
    check(`const ready = () => void settled(page);
const pending = () => { return { pending: settled(page) }; };
async function sample() { await page.click("p"); await ready(); await pending(); await page.locator("p").boundingBox(); }`),
  ).toEqual([3]);
  expect(check(`async () => { await page.click("p"); await expect.poll(() => ready).toBe(true); ${read} }`)).toEqual([]);
});

test("parses .ts files as TypeScript, so a generic arrow does not hide later reads", () => {
  const source = `const fixture = <T>(value: T) => value;\nasync () => { await page.click("p"); await page.locator("p").boundingBox(); };`;
  expect(check(source)).toEqual([2]);
});
