import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./ai-color";

const tokens = ":root {\n  --k2b-ai-accent: #8e1b6f;\n}\n.dark {\n  --k2b-ai-accent: #f0abdc;\n}\n";
const PALETTE = "packages/cloud/src/ssr/app-icon-style.ts";
const palette = (...tones: string[]) =>
  `const appIconPalette: readonly Entry[] = [\n${tones.map((tone) => `  { from: "${tone}" },\n`).join("")}];\n`;

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-ai-color-"));
  try {
    for (const [file, source] of Object.entries({
      "packages/ui/src/styles/index.css": tokens,
      [PALETTE]: palette("#2563eb", "#c2410c"),
      ...files,
    })) {
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

test("reports a plum, violet or grey fallback icon tone with its line", async () => {
  expect(await findings({ [PALETTE]: palette("#2563eb", "#c026d3", "#7c3aed", "#52525b", "#e11d48") })).toEqual([
    `${PALETTE}:3 A fallback icon color #c026d3`,
    `${PALETTE}:3 The fallback icon tone #c026d3`,
    `${PALETTE}:4 The fallback icon tone #7c3aed`,
    `${PALETTE}:5 The fallback icon tone #52525b is grey (OKLCH chroma 0.015 below 0.08); a grey icon reads as black and lifeless.`,
  ]);
});

test("reports a missing fallback palette instead of passing silently", async () => {
  expect(await findings({ [PALETTE]: "export const tone = () => undefined;\n" })).toEqual([
    `${PALETTE}:1 No appIconPalette found; the ai-color rule must guard the fallback icon tones.`,
  ]);
});

test("accepts the named machine-written surface and reports plum mixed into the bubble grey elsewhere", async () => {
  const named =
    ":root {\n  --k2b-ai-accent: #8e1b6f;\n  --k2b-chat-machine-surface: color-mix(in srgb, var(--k2b-ai-accent) 8%, var(--k2b-surface-muted));\n}\n" +
    ".dark {\n  --k2b-ai-accent: #f0abdc;\n  --k2b-chat-machine-surface: color-mix(in srgb, var(--k2b-ai-accent) 10%, var(--k2b-surface-muted));\n}\n";
  expect(
    await findings({
      "packages/ui/src/styles/index.css": named,
      "packages/ui/src/styles/chat.css": ".bubble { background: var(--k2b-chat-machine-surface); }\n",
      "packages/assistant/src/styles/app.css":
        ".hover { background: color-mix(in srgb, var(--k2b-ai-accent) 14%, var(--k2b-surface)); }\n" +
        ".bubble { background: color-mix(in srgb, var(--k2b-ai-accent) 8%, var(--k2b-surface-muted)); }\n",
      "packages/chat/src/frontend/Row.tsx":
        'const style = { background: "color-mix(in srgb, var(--k2b-surface-muted), var(--k2b-ai-accent) 9%)" };\n',
    }),
  ).toEqual([
    "packages/assistant/src/styles/app.css:2 Plum mixed into the bubble grey is the named machine-written case; use var(--k2b-chat-machine-surface) instead of mixing it here.",
    "packages/chat/src/frontend/Row.tsx:1 Plum mixed into the bubble grey is the named machine-written case; use var(--k2b-chat-machine-surface) instead of mixing it here.",
  ]);
});

test("reports a machine-written surface that is stronger or not derived from the AI accent", async () => {
  expect(
    await findings({
      "packages/ui/src/styles/index.css":
        ":root {\n  --k2b-ai-accent: #8e1b6f;\n  --k2b-chat-machine-surface: color-mix(in srgb, var(--k2b-ai-accent) 20%, var(--k2b-surface-muted));\n}\n" +
        ".dark {\n  --k2b-ai-accent: #f0abdc;\n  --k2b-chat-machine-surface: #3a0f2e;\n}\n",
    }),
  ).toEqual([
    "packages/ui/src/styles/index.css:3 --k2b-chat-machine-surface must mix var(--k2b-ai-accent) at most 10% into var(--k2b-surface-muted); it is the one named machine-written plum.",
    "packages/ui/src/styles/index.css:7 --k2b-chat-machine-surface must mix var(--k2b-ai-accent) at most 10% into var(--k2b-surface-muted); it is the one named machine-written plum.",
  ]);
});
