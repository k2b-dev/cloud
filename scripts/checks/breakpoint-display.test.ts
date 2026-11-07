import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./breakpoint-display";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-breakpoint-display-"));
  try {
    for (const [path, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports a plain display next to a breakpoint display in shared UI", async () => {
  expect(
    await findings({
      "packages/cloud/src/Row.tsx": [
        "export const Row = (props: { wide: boolean }) => (",
        '  <span class="contents max-sm:hidden">',
        '    <span class="max-sm:hidden sm:contents" />',
        '    <span class={props.wide ? "grid gap-2 sm:flex" : "flex"} />',
        '    <span class={`hidden ${props.wide ? "a" : "b"} @md:block`} />',
        '    <span class="flex items-center md:gap-2 group-hover:hidden dark:hidden" />',
        "  </span>",
        ");",
      ].join("\n"),
      "packages/ui/src/bar.ts": 'export const bar = "hidden lg:flex";\n',
      "packages/ui/src/bar.test.ts": 'export const fixture = "hidden lg:flex";\n',
      "packages/mail/src/App.tsx": 'export const App = () => <div class="hidden md:flex" />;\n',
    }),
  ).toEqual(["packages/cloud/src/Row.tsx:2", "packages/cloud/src/Row.tsx:4", "packages/cloud/src/Row.tsx:5", "packages/ui/src/bar.ts:1"]);
});
