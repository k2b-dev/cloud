import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./ai-color";

const tokens = ":root {\n  --k2b-ai-accent: #0891b2;\n}\n.dark {\n  --k2b-ai-accent: #22d3ee;\n}\n";

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

const config = (appearance: string) => `export const app = {\n  id: "demo",\n  appearance: ${appearance},\n  color: "#0891b2",\n};\n`;

test("reports cyan accents and gradient stops with their line", async () => {
  expect(
    await findings({
      "packages/hosts/src/config.ts": config(`{\n    accent: "#0e7490",\n    background: { from: "#a21caf", to: "#38bdf8" },\n  }`),
    }),
  ).toEqual(["packages/hosts/src/config.ts:4 The hosts app color #0e7490", "packages/hosts/src/config.ts:5 The hosts app color #38bdf8"]);
});

test("accepts distinct hues, near-gray colors, colors outside appearance, and the Assistant", async () => {
  expect(
    await findings({
      "packages/hosts/src/config.ts": config(`{ accent: "#a21caf", background: { from: "#57534e", to: "#0f766e" } }`),
      "packages/assistant/src/config.ts": config(`{ accent: "#0891b2" }`),
    }),
  ).toEqual([]);
});

test("reports a cyan launchpad fallback color", async () => {
  expect(
    await findings({
      "packages/cloud/src/ssr/AppLaunchpadPanel.tsx": `const appIconPalette: readonly Entry[] = [\n  { from: "#2563eb" },\n  { from: "#06b6d4" },\n];\n`,
    }),
  ).toEqual(["packages/cloud/src/ssr/AppLaunchpadPanel.tsx:3 A launchpad fallback color #06b6d4"]);
});
