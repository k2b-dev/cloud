import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./notice-cards";

const findings = async (source: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-notice-cards-"));
  try {
    const path = join(root, "packages/demo/src/Panel.tsx");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source);
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports decorative icons and size, opacity, or palette overrides inside notices", async () => {
  expect(
    await findings(
      [
        // One fragment holds both notices, so the sample is valid TSX and the rule reads all of it.
        "export const Panel = (props: { busy: boolean }) => (<>",
        '  <NoticeCard tone="neutral" bodyClass="flex items-center gap-2">',
        '    <i class="ti ti-photo-shield shrink-0" aria-hidden="true" />',
        '    <span class="opacity-70">Remote images are blocked.</span>',
        '    <p class={`mt-1 ${props.busy ? "text-xs" : ""}`}>Loading</p>',
        '    <code class="rounded bg-blue-100 dark:bg-blue-900">openid</code>',
        '    <h2 class="text-sm font-medium">Endpoints</h2>',
        "  </NoticeCard>",
        '  <NoticeRow><i class="ti ti-photo" /><span class="text-xs">Row</span></NoticeRow>',
        "</>);",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7, 9, 9].map((line) => `packages/demo/src/Panel.tsx:${line}`));
});

test("accepts calm notice content, icons in controls, and overrides outside notices", async () => {
  expect(
    await findings(
      [
        "export const Panel = () => (",
        "  <div>",
        '    <NoticeCard tone="info" title="Remote images are blocked" bodyClass="flex flex-col gap-2">',
        '      <h2 class="font-semibold text-primary">Endpoints</h2>',
        '      <dl><dt class="text-dimmed">Token</dt><dd><code class="break-all">/oauth/token</code></dd></dl>',
        '      <Button variant="secondary" size="xs"><i class="ti ti-photo text-lg" aria-hidden="true" />Load images</Button>',
        '      <IconButton label="Close"><i class="ti ti-x text-[18px]" /></IconButton>',
        "    </NoticeCard>",
        '    <NoticeRow tile="ti ti-photo" action={<SplitButton menuLabel="More" items={[]}><i class="ti ti-photo" aria-hidden="true" />Load</SplitButton>}>',
        '      <p class="truncate"><strong class="text-primary">Images blocked</strong></p>',
        "    </NoticeRow>",
        '    <span class="text-xs opacity-70 bg-blue-100"><i class="ti ti-info-circle" /></span>',
        "  </div>",
        ");",
      ].join("\n"),
    ),
  ).toEqual([]);
});

test("control icon sizes do not exempt colours, opacity or the control's text", async () => {
  expect(
    await findings(
      [
        'export const Panel = () => <NoticeCard tone="info">',
        '  <IconButton label="Close">',
        '    <i class="ti ti-x text-[18px] text-[red] opacity-50" />',
        '    <span class="text-sm">Close</span>',
        '    <i class="ti ti-x text-[1.125rem]"><span class="text-sm">Text</span></i>',
        "  </IconButton>",
        '  <p class="text-[18px]">Notice content</p>',
        "</NoticeCard>;",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 7].map((line) => `packages/demo/src/Panel.tsx:${line}`));
});

test("reports a frame around a notice that is its only child (K10, K14)", async () => {
  expect(
    await findings(
      [
        "export const Panel = (props: { error?: string }) => (<>",
        '  <div class="rounded-lg border p-3"><NoticeCard tone="danger" title="Sync failed" /></div>',
        '  <Paper><Show when={props.error}><NoticeRow tone="warning" title="Check" /></Show></Paper>',
        '  <div class="border-b px-4"><NoticeCard tone="info" title="A line below is a row line" /></div>',
        '  <div class="rounded-lg border"><h2>Sync</h2><NoticeCard tone="info" title="A second child" /></div>',
        '  <div class="flex gap-2"><NoticeCard tone="info" title="No frame" /></div>',
        "</>);",
      ].join("\n"),
    ),
  ).toEqual(["packages/demo/src/Panel.tsx:2", "packages/demo/src/Panel.tsx:3"]);
});
