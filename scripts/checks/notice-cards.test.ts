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
        "export const Panel = (props: { busy: boolean }) => (",
        '  <NoticeCard tone="neutral" bodyClass="flex items-center gap-2">',
        '    <i class="ti ti-photo-shield shrink-0" aria-hidden="true" />',
        '    <span class="opacity-70">Remote images are blocked.</span>',
        '    <p class={`mt-1 ${props.busy ? "text-xs" : ""}`}>Loading</p>',
        '    <code class="rounded bg-blue-100 dark:bg-blue-900">openid</code>',
        '    <h2 class="text-sm font-medium">Endpoints</h2>',
        "  </NoticeCard>",
        ");",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7].map((line) => `packages/demo/src/Panel.tsx:${line}`));
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
        '      <Button variant="secondary" size="xs"><i class="ti ti-photo" aria-hidden="true" />Load images</Button>',
        '      <IconButton label="Close"><i class="ti ti-x" /></IconButton>',
        "    </NoticeCard>",
        '    <span class="text-xs opacity-70 bg-blue-100"><i class="ti ti-info-circle" /></span>',
        "  </div>",
        ");",
      ].join("\n"),
    ),
  ).toEqual([]);
});
