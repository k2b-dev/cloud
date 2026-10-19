import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  applySelectionAllowlist,
  checkSelectionSource,
  formatSelectionBaseline,
  rule,
  runSelectionTokens,
  type SelectionAllowance,
} from "./selection-tokens";

const file = "packages/demo/src/view.tsx";
const cssFile = "packages/demo/src/app.css";
const baseline = "scripts/checks/selection-tokens.baseline";
const key = `${file} | selection`;
const check = (source: string, path = file) => checkSelectionSource(path, source);

test("matches platform selection reads and only the two pale blue utilities", () => {
  const findings = check(`var(--ui-selected); var(--k2b-selected); bg-[var(--ui-selected)];
hover:bg-blue-100 dark:bg-blue-50/60 !bg-blue-50 [&:hover]:!bg-blue-100/40
bg-blue-500 bg-blue-950 bg-blue-1000 bg-blue-50ish bg-blue-50-extra prefix-bg-blue-50
var(--ui-selected-nav) var(--ui-app-selected) var(--ui-app-accent-text)`);
  expect(findings.map(({ line }) => line)).toEqual([1, 1, 1, 2, 2, 2, 2]);
  expect(findings.every(({ kind }) => kind === "selection")).toBe(true);
  expect(
    check(":root { --ui-selected: white; --k2b-selected: black; --ui-data-row-selected: var(--ui-selected); }", cssFile).map(
      ({ subject }) => subject,
    ),
  ).toEqual([":root { --ui-data-row-selected }"]);
});

test("finds balanced raw-accent mixes in CSS, Tailwind and inline styles, once per call", () => {
  expect(
    check(`color-mix(in srgb, var(--app-accent, var(--fallback)) 10%, white)
bg-[color-mix(in_srgb,var(--app-accent)_10%,var(--ui-surface))]
<div style="background: color-mix(in srgb, var(--app-accent) 10%, white)">
color-mix(in srgb, var(--app-accent) 10%, var(--app-accent) 90%)
color-mix(in srgb, var(--ui-app-accent-text) 10%, white)
color-mix(in srgb, var(--app-accent-border) 10%, white)
var(--app-accent); color-mix(in srgb, blue 10%, white)
color-mix(in srgb, var(--app-accent), white`).map(({ line, kind }) => [line, kind]),
  ).toEqual([
    [1, "accent-mix"],
    [2, "accent-mix"],
    [3, "accent-mix"],
    [4, "accent-mix"],
  ]);
  expect(
    check(".a { background: color-mix(\n in srgb, var(--app-accent, red) 10%, white); }", cssFile).map(({ line, subject }) => [
      line,
      subject,
    ]),
  ).toEqual([[1, ".a { background }"]]);
  expect(check("color-mix(in srgb, color-mix(in srgb, var(--app-accent), white), black)")).toHaveLength(2);
  expect(check('color-mix(in srgb, red, white); "var(--app-accent)"')).toEqual([]);
});

test("blanks comments, preserves line numbers, and keeps strings with comment markers", () => {
  expect(
    check(`// var(--ui-selected) bg-blue-50
/* color-mix(in srgb, var(--app-accent), white)
bg-blue-100 */
const url = "https://example.test"; const selected = "bg-blue-50";
const marker = "/*"; const style = "var(--ui-selected)"; // bg-blue-100
/* ignored */ const mix = 'color-mix(in_srgb,var(--app-accent)_10%,white)';`).map(({ line }) => line),
  ).toEqual([4, 5, 6]);
  expect(
    check(
      `/* .ignored { background: var(--ui-selected); }
.bg-blue-50 {} */
.a {
  /* background: var(--k2b-selected); */
  background: var(/* note */ --ui-selected);
}`,
      cssFile,
    ).map(({ line, subject }) => [line, subject]),
  ).toEqual([[5, ".a { background }"]]);
});

test("raw-accent ink and focus utilities retain their source line and subject", () => {
  const utilities = [
    "text-[var(--app-accent)]",
    "hover:text-[var(--app-accent)]/80",
    "focus-visible:outline-[var(--app-accent)]",
    "ring-(--app-accent)",
    "dark:!ring-[var(--app-accent)]/50",
    "dark:!border-[var(--app-accent,var(--color-blue-500))]/50",
    "outline-(--app-accent)",
    "text-(--app-accent)/80!",
    "border-(--app-accent)",
    ...["x", "y", "t", "r", "b", "l", "s", "e"].map((side) => `focus:!border-${side}-[var(--app-accent)]`),
  ];
  const lines = utilities.map((utility) => `  <span class="${utility}" />`);
  const findings = check(`// A reintroduced raw accent\n${lines.join("\n")}`);
  expect(findings.map(({ kind, line, subject }) => ({ kind, line, subject }))).toEqual(
    lines.map((source, index) => ({ kind: "accent-raw", line: index + 2, subject: source.trim() })),
  );
  expect(findings[0]!.message).toContain("--ui-app-accent-text");
  expect(findings[0]!.message).toContain("--ui-focus, focus-ui, --k2b-focus-ring");
  expect(findings[0]!.message).toContain("--ui-app-accent-border");
});

test("raw-accent CSS reports only ink, outline and border-color declarations outside mixes", () => {
  expect(
    check(
      `.a:focus-visible { outline: 2px solid var(--app-accent); }
.b { color: var(--app-accent, red); }
.c { outline-color: var(--app-accent) }
.d { border-color: var(--app-accent) }
.e { color: color-mix(in srgb, var(--app-accent) 80%, black); }
.f { outline: color-mix(in srgb, var(--app-accent) 80%, black) var(--app-accent , red); }
.g:hover { @apply text-[var(--app-accent)] bg-[var(--app-accent)]; }`,
      cssFile,
    ).map(({ kind, line, subject }) => [kind, line, subject]),
  ).toEqual([
    ["accent-raw", 1, ".a:focus-visible { outline }"],
    ["accent-raw", 2, ".b { color }"],
    ["accent-raw", 3, ".c { outline-color }"],
    ["accent-raw", 4, ".d { border-color }"],
    ["accent-mix", 5, ".e { color }"],
    ["accent-mix", 6, ".f { outline }"],
    ["accent-raw", 6, ".f { outline }"],
    ["accent-raw", 7, ".g:hover { @apply }"],
  ]);
});

test("raw-accent detection permits backgrounds, token definitions, semantic ink and longer names", () => {
  expect(
    check(
      `.mail-unread-dot {
  background: var(--app-accent);
  background-color: var(--app-accent);
  box-shadow: 0 0 2px var(--app-accent);
  fill: var(--app-accent);
  border: 1px solid var(--app-accent);
  --ui-app-accent-border: var(--app-accent, var(--color-blue-500));
  color: var(--ui-app-accent-text);
  color: var(--app-accent-ink);
  outline-color: var(--app-accent-ink);
}
/* .comment { color: var(--app-accent); } */`,
      cssFile,
    ),
  ).toEqual([]);
  expect(
    check(`bg-[var(--app-accent)] text-[var(--ui-app-accent-text)] text-[var(--app-accent-ink)]
foo-text-[var(--app-accent)] foo-ring-(--app-accent) border-(--app-accent-ink)
// text-[var(--app-accent)]
/* outline-(--app-accent) */`),
  ).toEqual([]);
  expect(
    check(
      ":root { color: var(--app-accent); outline: 2px solid var(--app-accent); outline-color: var(--app-accent); border-color: var(--app-accent); }",
      "packages/cloud/src/styles/tokens.css",
    ),
  ).toEqual([]);
});

test("CSS subjects include normalized selectors, declaration properties, utilities and nested preludes", () => {
  expect(
    check(
      `.plain,
.other { background: var(--ui-selected); color: var(--k2b-selected); }
@media (width > 20rem) {
  @utility btn-input-active {
    @apply hover:bg-blue-50;
    &:hover { background: var(--ui-selected); }
  }
}
.parent { &[data-state="selected"] { @apply !bg-blue-100; } }
.a { content: "{ ; }"; background: var(--k2b-selected) }`,
      cssFile,
    ).map(({ subject }) => subject),
  ).toEqual([
    ".plain, .other { background }",
    ".plain, .other { color }",
    "@utility btn-input-active { @apply }",
    "@utility btn-input-active &:hover { background }",
    '.parent &[data-state="selected"] { @apply }',
    ".a { background }",
  ]);
});

test("CSS allowlist requires the exact subject; TS uses a line substring; unmatched entries are stale", () => {
  const findings = check(
    ".control { background: var(--ui-selected); color: var(--k2b-selected); } .row { background: var(--ui-selected); }",
    cssFile,
  );
  const allowances: SelectionAllowance[] = [
    { file: cssFile, subject: ".control { background }", reason: "Control: selected option." },
    { file: cssFile, subject: ".row", reason: "Control: deliberately inexact stale entry." },
  ];
  const result = applySelectionAllowlist(findings, allowances);
  expect(result.remaining.map(({ subject }) => subject)).toEqual([".control { color }", ".row { background }"]);
  expect(result.stale).toHaveLength(1);
  expect(result.stale[0]!.message).toContain("Stale selection-tokens allowlist entry");
  const ts = check('  const control = "bg-blue-50";\nconst row = "bg-blue-50";');
  expect(ts[0]!.subject).toBe('const control = "bg-blue-50";');
  expect(
    applySelectionAllowlist(ts, [{ file, subject: "const control =", reason: "Control: pressed button." }]).remaining.map(
      ({ line }) => line,
    ),
  ).toEqual([2]);
  expect(applySelectionAllowlist(ts, [{ file: cssFile, subject: "const control =", reason: "Control: wrong file." }]).stale).toHaveLength(
    1,
  );
  expect(applySelectionAllowlist([], allowances).stale).toHaveLength(2);
});

test("a keyboard-active option allowance cannot hide a combined picked-row selector", () => {
  const active = ".cloud-resource-search__result.is-active";
  const picked = ".cloud-resource-search__result.is-selected";
  const allowances = [{ file: cssFile, subject: `${active} { background }`, reason: "Control: keyboard-active listbox option." }];
  const combined = applySelectionAllowlist(check(`${active}, ${picked} { background: var(--k2b-selected); }`, cssFile), allowances);
  expect(combined.remaining).toHaveLength(1);
  expect(combined.stale).toHaveLength(1);
  const split = applySelectionAllowlist(
    check(`${active} { background: var(--k2b-selected); } ${picked} { background: var(--k2b-selected); }`, cssFile),
    allowances,
  );
  expect(split.remaining.map(({ subject }) => subject)).toEqual([`${picked} { background }`]);
  expect(split.stale).toEqual([]);
});

const workspace = async (
  files: Record<string, string>,
  counts?: ReadonlyMap<string, number>,
  allowances: readonly SelectionAllowance[] = [],
) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-selection-tokens-"));
  files["package.json"] = JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/core", "packages/cloud", "packages/ui"] } });
  if (counts) files[baseline] = formatSelectionBaseline(counts);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  const run = (fix = false) => runSelectionTokens({ workspaceRoot: root, fix, flags: new Set() }, allowances);
  const locations = async (fix = false) => (await run(fix)).map(({ file, line }) => `${relative(root, file!)}${line ? `:${line}` : ""}`);
  return { root, run, locations };
};

test("scans workspace source only, excluding ui, tests, harnesses, suites and fixtures", async () => {
  const included = [file, cssFile, "packages/core/src/page.tsx", "packages/cloud/src/view.ts"];
  const excluded = [
    "packages/ui/src/control.tsx",
    "packages/demo/src/view.test.tsx",
    "packages/demo/src/view.spec.ts",
    "packages/demo/src/view.browser.test.ts",
    "packages/demo/src/browser-harness.tsx",
    "packages/demo/src/view.browser-suite.ts",
    "packages/demo/src/view-browser-fixture.tsx",
    "packages/demo/src/fixtures/view.ts",
    "packages/demo/src/view.test-fixture.ts",
    "packages/other/src/view.tsx",
    "packages/demo/view.tsx",
    "packages/demo/src/view.md",
  ];
  const { root, locations } = await workspace(
    Object.fromEntries(
      [...included, ...excluded].map((path) => [path, path.endsWith(".css") ? ".row { background: var(--ui-selected); }" : '"bg-blue-50"']),
    ),
  );
  try {
    expect((await locations()).sort()).toEqual(included.sort().map((path) => `${path}:1`));
    expect(rule.name).toBe("selection-tokens");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("regression: a Core navigation link using platform blue is reported", async () => {
  const nav = "packages/core/src/pages/me/AccountHub.tsx";
  const source = '<a class={active ? "bg-[var(--ui-selected)] text-primary" : ""}>Profile</a>';
  const { root, run } = await workspace({ [nav]: source });
  try {
    expect(await run()).toMatchObject([{ file: join(root, nav), line: 1, kind: "selection", subject: source }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exceeding a baseline reports every finding for that file/kind and fix never raises it", async () => {
  const counts = new Map([[key, 1]]);
  const { root, locations } = await workspace({ [file]: '"bg-blue-50";' }, counts);
  try {
    expect(await locations()).toEqual([]);
    await writeFile(join(root, file), '"bg-blue-50";\n"var(--ui-selected)";');
    expect(await locations()).toEqual([`${file}:1`, `${file}:2`]);
    expect(await locations(true)).toEqual([`${file}:1`, `${file}:2`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatSelectionBaseline(counts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline accepts accent-raw and a raised count fails without increasing the baseline", async () => {
  const counts = new Map([[`${file} | accent-raw`, 1]]);
  const source = '<a class="text-[var(--app-accent)]">Mail</a>';
  const { root, run } = await workspace({ [file]: source }, counts);
  try {
    expect(await run()).toEqual([]);
    await writeFile(join(root, file), `${source}\n<span class="ring-(--app-accent)" />`);
    const expected = [
      { file: join(root, file), line: 1, kind: "accent-raw" },
      { file: join(root, file), line: 2, kind: "accent-raw" },
    ];
    expect(await run()).toMatchObject(expected);
    expect(await run(true)).toMatchObject(expected);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatSelectionBaseline(counts));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lower counts and missing files fail until fix lowers or removes entries, without adding new debt", async () => {
  const other = "packages/demo/src/other.ts";
  const missingKey = "packages/demo/src/missing.css | accent-mix";
  const counts = new Map([
    [key, 2],
    [missingKey, 1],
  ]);
  const { root, run, locations } = await workspace({ [file]: '"bg-blue-50";', [other]: '"bg-blue-100";' }, counts);
  try {
    expect(await run()).toHaveLength(3);
    expect((await run()).filter(({ message }) => message.includes("lower/remove the entry"))).toHaveLength(2);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatSelectionBaseline(counts));
    expect(await locations(true)).toEqual([`${other}:1`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatSelectionBaseline(new Map([[key, 1]])));
    await writeFile(join(root, file), "// migrated");
    expect(await locations()).toEqual([`${other}:1`, baseline]);
    expect(await locations(true)).toEqual([`${other}:1`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatSelectionBaseline(new Map()));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline counts are separate for selection and accent-mix, after allowlisting", async () => {
  const source = 'const control = "bg-blue-50";\nconst row = "bg-blue-100";\nconst mix = "color-mix(in_srgb,var(--app-accent)_10%,white)";';
  const allowances = [{ file, subject: "const control =", reason: "Control: selected option." }];
  const { root, run } = await workspace(
    { [file]: source },
    new Map([
      [key, 1],
      [`${file} | accent-mix`, 1],
    ]),
    allowances,
  );
  try {
    expect(await run()).toEqual([]);
    await writeFile(join(root, file), source.replace('"bg-blue-50"', '"bg-white"'));
    expect(await run()).toMatchObject([{ message: expect.stringContaining("Stale selection-tokens allowlist entry") }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
