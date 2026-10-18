import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { rule } from "./placeholder-states";

const findings = async (source: string, file = "packages/demo/src/Panel.tsx") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-placeholder-states-"));
  try {
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => ({ ...finding, file: relative(root, finding.file ?? "") }));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports literal status glyphs, expressions, templates, and elements with children once each", async () => {
  const found = await findings(
    [
      "export const Panel = () => <>",
      '  <Placeholder icon="ti ti-loader" />',
      '  <Placeholder icon="ti ti-loader-2 animate-spin" />',
      '  <Placeholder icon={failed ? "ti ti-alert-circle" : "ti ti-loader-3"} />',
      '  <Placeholder icon="ti ti-file-alert">Failed</Placeholder>',
      '  <Placeholder icon={"ti ti-alert-triangle"} />',
      "  <Placeholder icon={`ti ti-exclamation-circle`} />",
      "  <Placeholder icon={`ti ti-loader-quarter ${extra}`} />",
      "  <Placeholder icon={`${prefix} ti-file-alert ${suffix}`} />",
      "  <Placeholder icon={`${prefix} ti-exclamation-mark`} />",
      "</>;",
    ].join("\n"),
  );
  expect(found).toEqual(
    Array.from({ length: 9 }, (_, index) => ({
      file: "packages/demo/src/Panel.tsx",
      line: index + 2,
      message:
        'Placeholder shows a loading or error glyph without state="loading" or state="error": the default empty state puts its icon in the app-colour chip, and status needs its role and colour.',
    })),
  );
});

test("accepts status glyphs with an explicit state", async () => {
  expect(
    await findings(
      [
        "export const Panel = () => <>",
        '  <Placeholder state="loading" icon="ti ti-loader" />',
        '  <Placeholder icon={failed ? "ti ti-alert-circle" : "ti ti-loader-2"} state={failed ? "error" : "loading"} />',
        '  <Placeholder icon="ti ti-file-alert" state="error">Failed</Placeholder>',
        '  <Placeholder state="error" icon={"ti ti-alert-triangle"} />',
        '  <Placeholder icon={`ti ti-exclamation-circle`} state="error" />',
        "</>;",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("accepts empty-state glyphs and ignores status text outside Placeholder icons", async () => {
  expect(
    await findings(`export const Panel = () => <>
      <Placeholder icon="ti ti-folder-open" />
      <Placeholder icon={empty ? "ti ti-file-off" : "ti ti-search"}>Empty</Placeholder>
      <Placeholder icon="ti ti-alertness ti-loaderboard other-ti-file-alert ti-file-alert-off" />
      <Placeholder title="ti ti-alert-circle" />
      <Placeholder />
      <Other icon="ti ti-loader-2" />
    </>;`),
  ).toEqual([]);
});

test("scans packages, pwas, and docs-site/src only", async () => {
  for (const file of ["packages/demo/Panel.tsx", "pwas/demo/Panel.tsx", "docs-site/src/Panel.tsx"]) {
    expect(await findings('<Placeholder icon="ti ti-alert-circle" />', file)).toHaveLength(1);
  }
  for (const file of ["scripts/Panel.tsx", "docs-site/examples/Panel.tsx", "packages/demo/Panel.ts"]) {
    expect(await findings('<Placeholder icon="ti ti-alert-circle" />', file)).toEqual([]);
  }
});

test("skips test files", async () => {
  for (const file of ["packages/demo/Panel.test.tsx", "pwas/demo/Panel.behavior.test.tsx", "docs-site/src/Panel.spec.tsx"]) {
    expect(await findings('<Placeholder icon="ti ti-loader-2" />', file)).toEqual([]);
  }
});

test("the current workspace declares states for Placeholder status glyphs", async () => {
  expect(await rule.run({ workspaceRoot: resolve(import.meta.dir, "../.."), fix: false, flags: new Set() })).toEqual([]);
});
