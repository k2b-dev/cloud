import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkTestClockSource, formatBaseline, rule } from "./test-clock";

const file = "packages/demo/src/view.behavior.test.tsx";
const baseline = "scripts/checks/test-clock.baseline";
const check = (source: string) => checkTestClockSource(file, source).map(({ line }) => line);
const browserFile = "packages/demo/src/view.browser.test.ts";
const pin = 'await page.clock.setFixedTime(new Date("2026-10-09T08:00:00Z"));';
const playwrightClockMessage =
  "Playwright's clock.setFixedTime/setSystemTime also installs its fake clock (timers, animation frames, performance); pin only Date with a page script (see pinPageClock in packages/chat/src/frontend/ChatWorkspace.browser.test.ts), or add // playwright clock: <reason> when fake timers are the subject of the test.";

test("flags Playwright date pins on any receiver with a fake-clock explanation", () => {
  expect(checkTestClockSource(browserFile, pin)).toEqual([{ file: browserFile, line: 1, message: playwrightClockMessage }]);
  expect(check('context.clock.setSystemTime(new Date("2026-10-09T08:00:00Z"));')).toEqual([1]);
  expect(check("await  page . clock . setFixedTime (0);\ncontext\n . clock\n . setSystemTime\n (0);")).toEqual([1, 3]);
  expect(check("tab /* receiver */ . clock /* method */ . setFixedTime /* args */ (0);")).toEqual([1]);
});

test("accepts Playwright clock reasons only in adjacent line comments and keeps opt-outs separate", () => {
  expect(check(`${pin} // playwright clock: drives fake timers`)).toEqual([]);
  expect(check(`// playwright clock: drives fake timers\n${pin}`)).toEqual([]);
  for (const comment of ["// playwright clock:", "// playwright clock:   ", "// real clock: drives fake timers"]) {
    expect(check(`${pin} ${comment}`)).toEqual([1]);
    expect(check(`${comment}\n${pin}`)).toEqual([2]);
  }
  expect(check(`// playwright clock: drives fake timers\n\n${pin}`)).toEqual([3]);
  expect(check(`/* playwright clock: drives fake timers */\n${pin}`)).toEqual([2]);
  expect(check(`${pin} /* playwright clock: drives fake timers */`)).toEqual([1]);
  expect(check(`const reason = "// playwright clock: drives fake timers"; ${pin}`)).toEqual([1]);
  expect(check("new Date(); // playwright clock: drives fake timers\nDate.now();")).toEqual([1, 2]);
});

test("allows bun clock pins and deliberate Playwright timer controls", () => {
  expect(
    check(`setSystemTime(new Date("2026-10-09T08:00:00Z"));
setSystemTime();
page.clock.install();
page.clock.runFor(1000);
page.clock.fastForward("30:00");
page.clock.pauseAt(0);
page.clock.resume();
page.clock.setTimezone("UTC");`),
  ).toEqual([]);
});

test("ignores Playwright pins in strings and comments while preserving real code line numbers", () => {
  expect(
    check(`"page.clock.setFixedTime(0)";
'context.clock.setSystemTime(0)';
page.addInitScript(\`page.clock.setFixedTime(0);\`);
// page.clock.setFixedTime(0)
/* context.clock.setSystemTime(0)
page.clock.setFixedTime(0) */
${pin}`),
  ).toEqual([7]);
  expect(check(String.raw`"escaped \" // page.clock.setFixedTime(0)"; 'escaped \' /* context.clock.setSystemTime(0)';`)).toEqual([]);
});

test("regular-expression quotes neither hide later pins nor create Playwright opt-outs", () => {
  expect(check(`const font = /url\\((\\.\\/[^)"']+\\.woff2)[^)]*\\)/;\n${pin}`)).toEqual([2]);
  expect(check("const pattern = /.clock.setFixedTime(0)/;")).toEqual([]);
  expect(check(`const pattern = /["'// playwright clock: not a comment]/; ${pin}`)).toEqual([1]);
});

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

const listenerMessage =
  "Playwright events reach the test process late under load; measure browser timing in the page (performance.now() in a page or init script) and assert on those times.";

test("reports each clock read in multiline Playwright listeners once with the listener message", () => {
  const findings = checkTestClockSource(
    file,
    `page.on("request", (request) => {
  performance.now();
  Date.now();
  new Date();
});
context.once('response', async (response) => {
  Date.now();
  performance.now();
});`,
  );
  expect(findings).toEqual([2, 3, 4, 7, 8].map((line) => ({ file, line, message: listenerMessage })));
});

test("allows duration clocks outside Playwright listeners and in other event listeners", () => {
  expect(
    check(`performance.now();
socket.on("message", () => performance.now());
page.on(eventName, () => performance.now());
page.on("request-extra", () => performance.now());`),
  ).toEqual([]);
});

test("recognizes all Playwright events and listener methods", () => {
  const events = [
    "request",
    "requestfinished",
    "requestfailed",
    "response",
    "console",
    "websocket",
    "framenavigated",
    "frameattached",
    "framedetached",
    "load",
    "domcontentloaded",
    "dialog",
    "popup",
    "pageerror",
    "download",
    "filechooser",
    "worker",
    "close",
    "crash",
    "page",
    "serviceworker",
  ];
  for (const method of ["on", "once", "addListener"]) {
    for (const event of events) {
      expect(checkTestClockSource(file, `target.${method}("${event}", () => performance.now());`)).toEqual([
        { file, line: 1, message: listenerMessage },
      ]);
    }
  }
});

test("ends listener calls by counting nested parentheses and skipping quoted and template parentheses", () => {
  const findings = checkTestClockSource(
    file,
    `page.on(/* event */ "request", () => {
  fn("escaped \\\" )", 'escaped \\\' )', \`template ) (\`, (value) => value());
  /* ) */ performance.now();
  context.once('response', () => Date.now());
});
performance.now();
new Date();`,
  );
  expect(findings.map(({ line }) => line)).toEqual([3, 4, 7]);
  expect(findings.slice(0, 2).every(({ message }) => message === listenerMessage)).toBe(true);
  expect(findings[2]!.message).not.toBe(listenerMessage);
});

test("counts clock reads inside listener strings consistently with page script strings", () => {
  const findings = checkTestClockSource(
    file,
    `page.on("request", () => {
  const script = "performance.now(); Date.now(); new Date();";
});
const script = "performance.now();";`,
  );
  expect(findings).toEqual(Array.from({ length: 3 }, () => ({ file, line: 2, message: listenerMessage })));
});

test("accepts real-clock reasons for Playwright listener reads on the same or preceding line", () => {
  expect(
    check(`page.on("request", () => {
  performance.now(); // real clock: measures event delivery in the test process
  // real clock: checks listener wall-clock behavior
  Date.now(); new Date();
  // real clock:
  performance.now();
  // real clock: a blank line breaks the opt-out

  performance.now();
});`),
  ).toEqual([6, 9]);
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

test("baseline counts Playwright pins together with clock reads without raising allowances", async () => {
  const counts = new Map([[browserFile, 2]]);
  const { root, locations } = await workspace({ [browserFile]: `Date.now();\n${pin}` }, counts);
  try {
    expect(await locations()).toEqual([]);
    await writeFile(join(root, browserFile), `Date.now();\n${pin}\ncontext.clock.setSystemTime(0);`);
    expect(await locations()).toEqual([1, 2, 3].map((line) => `${browserFile}:${line}`));
    expect(await locations(true)).toEqual([1, 2, 3].map((line) => `${browserFile}:${line}`));
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(counts));
    await writeFile(join(root, browserFile), pin);
    expect(await locations()).toEqual([baseline]);
    expect(await locations(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline(new Map([[browserFile, 1]])));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
