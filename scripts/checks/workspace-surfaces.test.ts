import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./workspace-surfaces";

const findings = async (source: string, file = "packages/demo/src/Panel.tsx") => {
  const root = await mkdtemp(join(tmpdir(), "cloud-workspace-surfaces-"));
  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui", "packages/ssr", "pwas/demo"] } }),
    );
    const path = join(root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test.each([
  '<div class="relative min-h-0 min-w-0 flex-1 overflow-hidden rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)] bg-[var(--ui-surface)]" />',
  '<div class={`relative flex-1 ${props.busy ? "rounded-xl border" : ""} overflow-hidden`} />',
  '<div className={props.busy ? "flex-1 rounded-xl border" : ""} />',
  '<div class="flex-1 md:rounded-xl dark:hover:border-2" />',
  '<div class="flex-1 [&:hover]:rounded-xl border-[1px]" />',
  '<Paper class="flex-1" />',
  '<Placeholder surface="paper" variant="panel" />',
  '<Placeholder surface={"paper"} variant={"panel"} />',
  '<Placeholder surface="paper" class="flex-1" description="Empty" />',
  ...["grow", "size-full", "inset-0", "h-full w-full"].map((fill) => `<div class="${fill} rounded-2xl border-4" />`),
  ...["ui-radius-frame", "k2b-radius-surface", "k2b-radius-dialog"].map(
    (radius) => `<div class="flex-1 rounded-[var(--${radius})] border-8" />`,
  ),
  '<div class="size-full rounded-3xl border-[0.125rem]" />',
])("reports a full-area card: %s", async (source) => {
  expect(await findings(`export const Panel = () => (\n${source}\n);`)).toEqual(["packages/demo/src/Panel.tsx:2"]);
});

test.each([
  '<div class="flex h-full w-72 shrink-0 flex-col rounded-[var(--ui-radius-surface)] border border-[var(--ui-border)]" />',
  '<div class="rounded-xl border grid p-4" />',
  '<input class="flex-1 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface)]" />',
  ...["full", "none", "sm", "md", "t-xl", "tl-xl"].map((radius) => `<div class="flex-1 rounded-${radius} border" />`),
  '<div class="flex-1 rounded border" />',
  '<div class="flex-1 rounded-xl border-[var(--ui-border)]" />',
  '<div class="flex-1 rounded-xl border-zinc-200" />',
  '<Placeholder surface="paper" />',
  '<Placeholder surface="paper" class="h-full" />',
  '<Placeholder variant="panel" class="flex-1" />',
  '<Paper class="p-4" />',
  '<div class="flex-1"><div class="rounded-xl border" /></div>',
  '<main><Placeholder surface="paper" variant="panel" /></main>',
])("accepts inset cards, controls, and unframed views: %s", async (source) => {
  expect(await findings(`export const Panel = () => (${source});`)).toEqual([]);
});

test.each(["Panel.test.tsx", "Panel.spec.tsx", "Panel.browser-harness.tsx", "Panel.browser-fixture.tsx"])(
  "ignores test and browser fixture files: %s",
  async (file) => {
    expect(await findings('<Paper class="flex-1" />', `packages/demo/src/${file}`)).toEqual([]);
  },
);

test.each(["packages/ui/src/Panel.tsx", "packages/ssr/src/Panel.tsx", "pwas/demo/src/Panel.tsx"])("checks source in %s", async (file) => {
  expect(await findings('<Paper class="flex-1" />', file)).toEqual([`${file}:1`]);
});

test("accepts a plain UI placeholder panel", async () => {
  expect(await findings('<Placeholder variant="panel" />', "packages/ui/src/Panel.tsx")).toEqual([]);
});

test("a workspace inside a standalone page still owns its surface", async () => {
  expect(await findings('<main><AppWorkspace.Main><Placeholder surface="paper" variant="panel" /></AppWorkspace.Main></main>')).toEqual([
    "packages/demo/src/Panel.tsx:1",
  ]);
});
