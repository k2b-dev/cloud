import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./v2-part-classes";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-v2-part-classes-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const path = join(root, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("markup outside @k2b/ui may name a primitive's root but not one of its inner parts", async () => {
  expect(
    await findings({
      "packages/ui/src/v2/row.tsx": [
        "export const Row = (props: { children: unknown }) => (",
        '  <div class="k2-row" data-k2-part="Row">',
        '    <span class="k2-row-lead" />',
        "    {props.children}",
        "  </div>",
        ");",
      ].join("\n"),
      "packages/demo/src/Page.tsx": [
        "export const Page = (props: { wide: boolean }) => (",
        '  <div class="k2-ui">',
        '    <div class="k2-row">root</div>',
        '    <span class={props.wide ? "k2-row-lead" : ""}>part</span>',
        '    <p class="k2-t-meta">type role</p>',
        "  </div>",
        ");",
      ].join("\n"),
      // a const, `attr:class` and a selector in a .ts module count too
      "packages/demo/src/names.ts": [
        'export const lead = "k2-row-lead";',
        'export const pick = () => document.querySelector(".k2-row-lead");',
      ].join("\n"),
      "packages/demo/src/Attr.tsx": 'export const Attr = () => <i attr:class="k2-row-lead" />;',
      // the skill's recipes are copied by people
      "packages/ui/skills/k2b-ui/recipes/row.tsx": 'export const Recipe = () => <span class="k2-row-lead" />;',
      // @k2b/ui's own sources may
      "packages/ui/src/v2/other.tsx": 'export const Other = () => <div class="k2-x"><span class="k2-row-lead" /></div>;',
    }),
  ).toEqual([
    "packages/demo/src/Attr.tsx:1",
    "packages/demo/src/Page.tsx:4",
    "packages/demo/src/names.ts:1",
    "packages/demo/src/names.ts:2",
    "packages/ui/skills/k2b-ui/recipes/row.tsx:1",
  ]);
});
