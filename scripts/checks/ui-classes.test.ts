import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./ui-classes";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ui-classes-"));
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

test("reports k2b classes that no stylesheet defines and accepts defined ones", async () => {
  expect(
    await findings({
      "packages/ui/src/styles/index.css": ".k2b-ui .k2b-text-link { color: inherit; }",
      "packages/ui/src/Own.tsx": 'export const Own = () => <span class="k2b-hook" />;',
      "packages/demo/src/History.tsx": [
        "export const History = (props: { wide: boolean }) => (",
        "  <p>",
        '    <a class="k2b-link" href="/a">Run</a>',
        '    <a class="k2b-text-link" href="/b">Code</a>',
        '    <span class={`font-medium ${props.wide ? "k2b-missing" : ""}`}>x</span>',
        "  </p>",
        ");",
      ].join("\n"),
    }),
  ).toEqual(["packages/demo/src/History.tsx:3", "packages/demo/src/History.tsx:5"]);
});
