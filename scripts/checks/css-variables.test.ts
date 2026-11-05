import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./css-variables";

const tokens = ":root {\n  --k2b-danger-text: #b91c1c;\n  --ui-canvas: #fafafa;\n}\n";

const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-css-variables-"));
  try {
    for (const [file, source] of Object.entries({ "packages/ui/src/styles/index.css": tokens, ...files })) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), source);
    }
    return (await rule.run({ workspaceRoot: root, fix: false, flags: new Set() })).map(
      (finding) => `${relative(root, finding.file ?? "")}:${finding.line} ${finding.message.split(" is not")[0]}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports a removed token in a class, a style object and a stylesheet", async () => {
  expect(
    await findings({
      "packages/cloud/src/Row.tsx": `export const a = <b class="text-[var(--k2b-danger)]" />;\nexport const b = { color: "var(--ui-accent)" };\n`,
      "packages/spaces/src/styles/app.css": ".row {\n  background: var(--ui-bg);\n}\n",
    }),
  ).toEqual([
    "packages/cloud/src/Row.tsx:1 --k2b-danger",
    "packages/cloud/src/Row.tsx:2 --ui-accent",
    "packages/spaces/src/styles/app.css:2 --ui-bg",
  ]);
});

test("accepts defined tokens, fallbacks, runtime-set properties, template names, and tests", async () => {
  expect(
    await findings({
      "packages/cloud/src/Row.tsx": [
        `export const a = <b class="text-[var(--k2b-danger-text)] bg-[var(--ui-canvas)]" />;`,
        `export const b = { color: "var(--k2b-maybe, red)" };`,
        `export const c = <i style={{ "--k2b-lane": "2", width: "var(--k2b-lane)" }} />;`,
        "export const d = (unit: string) => `var(--k2b-timeline-${unit})`;",
      ].join("\n"),
      "packages/app/src/styles/app.css": ".row { --k2b-row-gap: 4px; gap: var(--k2b-row-gap); }\n",
      "packages/ui/src/styles/hygiene.test.ts": `expect(css).not.toContain("var(--k2b-danger)");\n`,
    }),
  ).toEqual([]);
});
