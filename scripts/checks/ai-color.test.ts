import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./ai-color";

const tokens = ":root {\n  --k2b-ai-accent: #8e1b6f;\n}\n.dark {\n  --k2b-ai-accent: #f0abdc;\n}\n";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ai-color-"));
  try {
    for (const [file, source] of Object.entries({ "packages/ui/src/styles/index.css": tokens, ...files })) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map(
      (finding) => `${relative(root, finding.file ?? "")}:${finding.line} ${finding.message.split(" sits")[0]}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const config = (appearance: string) => `export const app = {\n  id: "demo",\n  appearance: ${appearance},\n  color: "#c026d3",\n};\n`;

test("reports plum accents and gradient stops with their line", async () => {
  expect(
    await findings({
      "packages/hosts/src/config.ts": config(`{\n    accent: "#a21caf",\n    background: { from: "#0891b2", to: "#ec4899" },\n  }`),
    }),
  ).toEqual(["packages/hosts/src/config.ts:4 The hosts app color #a21caf", "packages/hosts/src/config.ts:5 The hosts app color #ec4899"]);
});

test("accepts distinct hues, near-gray colors, colors outside appearance, and the Assistant", async () => {
  expect(
    await findings({
      "packages/hosts/src/config.ts": config(`{ accent: "#0891b2", background: { from: "#57534e", to: "#7e22ce" } }`),
      "packages/assistant/src/config.ts": config(`{ accent: "#8e1b6f" }`),
    }),
  ).toEqual([]);
});

test("reports a plum launchpad fallback color", async () => {
  expect(
    await findings({
      "packages/cloud/src/ssr/AppLaunchpadPanel.tsx": `const appIconPalette: readonly Entry[] = [\n  { from: "#2563eb" },\n  { from: "#c026d3" },\n];\n`,
    }),
  ).toEqual(["packages/cloud/src/ssr/AppLaunchpadPanel.tsx:3 A launchpad fallback color #c026d3"]);
});
