import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./component-class-list";

const findings = async (source: string) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-component-class-list-"));
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

test("reports classList on components and keeps it on native elements", async () => {
  expect(
    await findings(
      [
        "export const Panel = (props: { on: boolean; item: Component }) => (",
        "  <div classList={{ active: props.on }}>",
        '    <InlineGuidance class="a" classList={{ invisible: props.on }}>Text</InlineGuidance>',
        "    <Toolbar.Item classList={{ active: props.on }} />",
        "    <props.item classList={{ active: props.on }} />",
        '    <i class="ti ti-x" classList={{ "rotate-180": props.on }} />',
        "  </div>",
        ");",
      ].join("\n"),
    ),
  ).toEqual(["packages/demo/src/Panel.tsx:3", "packages/demo/src/Panel.tsx:4", "packages/demo/src/Panel.tsx:5"]);
});
