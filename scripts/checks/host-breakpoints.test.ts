import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { checkHostBreakpointSource, formatBaseline, rule } from "./host-breakpoints";

const css = "packages/example/src/styles/app.css";
const tsx = "packages/example/src/Workspace.tsx";
const baseline = "scripts/checks/host-breakpoints.baseline";
const widths = ["64rem", "63.99rem", "63.999rem", "80rem", "79.999rem", "1024px", "1023px", "1280px", "1279px"];

test("finds CSS media conditions, including negation, multiline conditions and nested rules", () => {
  for (const value of widths)
    for (const bound of ["min", "max"]) {
      const condition = `not all and (${bound}-width: ${value})`;
      const findings = checkHostBreakpointSource(
        css,
        `/* @media (min-width: 64rem) {} */\n@layer app {\n@media\n ${condition} { .item { display: none; } }\n}`,
      );
      expect(findings.map(({ line, key }) => ({ line, key }))).toEqual([{ line: 3, key: `${css} | media | @media ${condition}` }]);
    }
});

test("finds literal matchMedia arguments and query constants, without reading comments or unrelated strings", () => {
  for (const value of widths) {
    const query = `(min-width: ${value})`;
    const findings = checkHostBreakpointSource(
      tsx,
      `// matchMedia('${query}')\nconst NOTE = '${query}';\nconst WIDE_QUERY = '${query}';\nwindow.matchMedia('${query}');\nmatchMedia(\`${query}\`);`,
    );
    expect(findings.map(({ line }) => line)).toEqual([3, 4, 5]);
  }
  expect(checkHostBreakpointSource(tsx, 'const WIDE_QUERY = "(min-width: 64rem)"; matchMedia(WIDE_QUERY);')).toHaveLength(1);
});

test("finds display tokens in JSX classes, branches, classList and templates with important and stacked variants", () => {
  for (const variant of ["lg", "xl", "max-lg", "max-xl"]) {
    for (const utility of ["hidden", "block", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "contents"]) {
      for (const token of [`${variant}:${utility}`, `${variant}:!${utility}`, `${variant}:${utility}!`, `hover:${variant}:${utility}`]) {
        expect(checkHostBreakpointSource(tsx, `<div class="${token}" />`).map(({ key }) => key)).toEqual([`${tsx} | display | ${token}`]);
      }
    }
  }
  expect(checkHostBreakpointSource(tsx, '<div class={ok ? "lg:hidden" : "xl:flex"} />')).toHaveLength(2);
  expect(checkHostBreakpointSource(tsx, "<div class={`lg:hidden ${extra} xl:flex`} />")).toHaveLength(2);
  expect(checkHostBreakpointSource(tsx, '<div classList={{ "lg:hidden": ok }} />')).toHaveLength(1);
  expect(checkHostBreakpointSource(tsx, 'const chrome = "lg:hidden"; <div class={chrome} />')).toHaveLength(1);
});

test("ignores content utilities, host variants, phone, pointer and motion decisions", () => {
  expect(
    checkHostBreakpointSource(
      tsx,
      '<div class="lg:grid-cols-2 lg:flex-1 lg:items-start xl:p-4 md:hidden @min-[64rem]/k2b-app-area:hidden [@container(foo:bar)]:block" />',
    ),
  ).toEqual([]);
  for (const condition of ["(min-width: 48rem)", "(max-width: 767px)", "(pointer: coarse)", "(prefers-reduced-motion: reduce)"]) {
    expect(checkHostBreakpointSource(css, `@media ${condition} { .x { display: none; } }`)).toEqual([]);
    expect(checkHostBreakpointSource(tsx, `matchMedia('${condition}')`)).toEqual([]);
  }
  expect(checkHostBreakpointSource(css, "@container k2b-app-area (min-width: 64rem) { .x { display: flex; } }")).toEqual([]);
});

test("allows only the window-owned shell and panel files", () => {
  for (const file of [
    "packages/cloud/src/styles/global.css",
    "packages/cloud/src/styles/panel.css",
    "packages/cloud/src/browser/panel-slot.ts",
    "packages/cloud/src/browser/spotlight-position.ts",
  ]) {
    expect(
      checkHostBreakpointSource(file, file.endsWith(".css") ? "@media (min-width: 64rem) {}" : 'matchMedia("(min-width: 64rem)")'),
    ).toEqual([]);
  }
});

test("skips tests, browser fixtures, build outputs, and source outside packages/*/src", () => {
  for (const file of [
    "packages/example/src/app.browser.test.tsx",
    "packages/example/src/app.spec.tsx",
    "packages/example/src/app.test.css",
    "packages/example/src/app.browser-harness.tsx",
    "packages/example/src/app.browser-fixture.tsx",
    "packages/example/src/__tests__/app.tsx",
    "packages/example/src/dist/app.tsx",
    "packages/example/dist/app.tsx",
    "scripts/example.tsx",
  ])
    expect(checkHostBreakpointSource(file, '<div class="lg:hidden" />')).toEqual([]);
});

const workspace = async (keys: string[] = []) => {
  const root = await mkdtemp(join(tmpdir(), "host-breakpoints-"));
  const source = '<div class="lg:hidden" />';
  for (const [file, text] of [
    [tsx, source],
    [baseline, formatBaseline(keys)],
  ]) {
    await mkdir(dirname(join(root, file!)), { recursive: true });
    await writeFile(join(root, file!), text!);
  }
  const run = async (fix = false, flags = new Set<string>()) =>
    (await rule.run({ workspaceRoot: root, fix, flags })).map(({ file, line }) => `${relative(root, file ?? "")}${line ? `:${line}` : ""}`);
  return { root, source, run };
};

test("new findings fail, including with --fix, which never adds baseline entries", async () => {
  const { root, run } = await workspace();
  try {
    expect(await run()).toEqual([`${tsx}:1`]);
    expect(await run(true)).toEqual([`${tsx}:1`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline counts findings by file and occurrence; --fix only removes stale entries", async () => {
  const key = `${tsx} | display | lg:hidden`;
  const stale = `${css} | media | @media (min-width: 64rem)`;
  const { root, source, run } = await workspace([key, key, stale]);
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await run()).toEqual([baseline, baseline]);
    expect(await run(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([key]));
    await run(false, new Set(["--warnings"]));
    expect(warnings.mock.calls.some(([warning]) => String(warning).includes(`${tsx}:1`))).toBe(true);
    await writeFile(join(root, tsx), `${source}\n${source}`);
    expect(await run()).toEqual([`${tsx}:2`]);
    const other = "packages/example/src/Other.tsx";
    await writeFile(join(root, other), source);
    expect(await run(true)).toEqual([`${other}:1`, `${tsx}:2`]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([key]));
    await rm(join(root, other));
    await writeFile(join(root, tsx), '<div class="md:hidden" />');
    expect(await run()).toEqual([baseline]);
    expect(await run(true)).toEqual([]);
    expect(await readFile(join(root, baseline), "utf8")).toBe(formatBaseline([]));
    expect(await run(true)).toEqual([]);
  } finally {
    warnings.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});
