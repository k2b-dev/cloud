import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./icon-controls";

const findings = async (source: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-icon-controls-"));
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

test("reports icon-only shared buttons and unnamed native controls", async () => {
  expect(
    await findings(
      [
        "export const Panel = () => (",
        "  <div>",
        '    <Button aria-label="Delete"><i class="ti ti-trash" /></Button>',
        '    <ButtonLink href="/x"><i class="ti ti-external-link" /></ButtonLink>',
        '    <button type="button"><i class="ti ti-x" /></button>',
        '    <a href="/admin"><i class="ti ti-check"></i></a>',
        '    <Tooltip.Trigger content="Close"><i class="ti ti-x" /></Tooltip.Trigger>',
        "  </div>",
        ");",
      ].join("\n"),
    ),
  ).toEqual([3, 4, 5, 6, 7].map((line) => `packages/demo/src/Panel.tsx:${line}`));
});

test("accepts icon buttons, named native controls, and controls with visible text", async () => {
  expect(
    await findings(
      [
        "export const Panel = (props: { attrs: object }) => (",
        "  <div>",
        '    <IconButton label="Delete"><i class="ti ti-trash" /></IconButton>',
        '    <Button aria-labelledby="section-title"><i class="ti ti-chevron-up" /></Button>',
        '    <button type="button" aria-label="Close"><i class="ti ti-x" /></button>',
        '    <button type="button" {...props.attrs}><i class="ti ti-x" /></button>',
        '    <Button><i class="ti ti-plus" /> Add</Button>',
        '    <Button><i class="ti ti-plus" /><span class="sr-only">Add</span></Button>',
        "  </div>",
        ");",
      ].join("\n"),
    ),
  ).toEqual([]);
});
