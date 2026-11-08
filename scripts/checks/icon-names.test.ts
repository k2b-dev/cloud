import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { rule, shippedIconNames } from "./icon-names";

const preset = ['@import "./font.css";', '.ti-star-filled::before { --k2b-ti-glyph: url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E"); }'].join(
  "\n",
);

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-icon-names-"));
  try {
    const all = {
      "packages/ui/src/icons/tabler.css": preset,
      "packages/ui/src/icons/font.css": '.ti{font-family:"tabler-icons"}.ti-folder:before{content:"\\eaad"}',
      ...files,
    };
    for (const [path, source] of Object.entries(all)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line} ${finding.message.split(" ")[1]}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports literal icon names the preset does not ship, in source and Markdown", async () => {
  expect(
    await findings({
      "packages/demo/src/Panel.tsx": [
        'export const folder = <i class="ti ti-folder" aria-hidden="true" />;',
        'export const star = { icon: "ti ti-star-filled" };',
        'export const gone = <i class="ti ti-star-off-filled text-sm" />;',
        'export const draft = { icon: "ti ti-mail-pencil" };',
      ].join("\n"),
      "packages/demo/src/help/documents/en/read.help.md": "---\nid: read\nicon: ti ti-cloud-sun\n---\n",
      "docs-site/src/ui/demo.tsx": 'export const icon = "ti ti-folder";',
    }),
  ).toEqual([
    'packages/demo/src/Panel.tsx:3 "ti-star-off-filled"',
    'packages/demo/src/Panel.tsx:4 "ti-mail-pencil"',
    'packages/demo/src/help/documents/en/read.help.md:3 "ti-cloud-sun"',
  ]);
});

test("skips names built at runtime and tests that name a missing icon on purpose", async () => {
  expect(
    await findings({
      "packages/demo/src/kinds.ts": "export const icon = (kind: string) => `ti ti-file-${kind}`;",
      "packages/demo/src/Panel.test.tsx": 'expect(row.querySelector(".ti-star")).toBeNull(); const icon = "ti ti-not-real";',
    }),
  ).toEqual([]);
});

test("the shipped preset contains the Tabler font and the filled glyphs it adds", () => {
  const shipped = shippedIconNames(resolve(import.meta.dir, "../.."));
  expect(shipped.size).toBeGreaterThan(5000);
  for (const name of [
    "folder",
    "star",
    "circle-filled",
    "cloud-filled",
    "pin-filled",
    "player-play-filled",
    "point-filled",
    "star-filled",
  ]) {
    expect(shipped.has(name)).toBe(true);
  }
});
