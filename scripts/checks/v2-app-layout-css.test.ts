import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutInV2Source, rule, v2InStylesheet } from "./v2-app-layout-css";

const lines = (hits: { line: number; message: string }[]) => hits.map((hit) => [hit.line, hit.message.split(";")[0]]);

test("red: layout CSS in a v2 screen, also in a slot prop and as a spread", () => {
  const source = [
    'import { Pane, Row, Canvas } from "@k2b/ui/v2";',
    'import "./mail.css";',
    "export const Inbox = () => (",
    '  <Pane head={<div class="flex gap-2">Inbox</div>}>',
    '    <div style={{ padding: "8px" }}>',
    '      <Row title="A" {...{ class: "pl-5" }} />',
    "    </div>",
    "    <style>{'.x { margin: 0 }'}</style>",
    '    <Canvas class="h-40" />',
    "  </Pane>",
    ");",
  ].join("\n");
  expect(lines(layoutInV2Source("Inbox.tsx", source))).toEqual([
    [2, "imports the stylesheet ./mail.css into a v2 screen"],
    [4, "class on <div> in a v2 screen"],
    [5, "style on <div> in a v2 screen"],
    [6, "class spread onto <Row> in a v2 screen"],
    [8, "<style> in a v2 screen"],
    [9, "class on <Canvas> in a v2 screen"],
  ]);
});

test("green: free drawing inside Canvas, also under an alias or a namespace import", () => {
  const named = [
    'import { Band, Canvas as Drawing } from "@k2b/ui/v2";',
    "export const Radar = () => (",
    "  <Band>",
    '    <Drawing label="Radar"><svg class="radar"><circle style={{ fill: "red" }} /></svg></Drawing>',
    "  </Band>",
    ");",
  ].join("\n");
  const namespace = [
    'import * as ui from "@k2b/ui/v2";',
    'export const Map = () => <ui.Canvas label="Map"><div class="pin" /></ui.Canvas>;',
  ].join("\n");
  expect(layoutInV2Source("Radar.tsx", named)).toEqual([]);
  expect(layoutInV2Source("Map.tsx", namespace)).toEqual([]);
});

test("green: a v1 screen is untouched until its first v2 import", () => {
  const v1 = [
    'import { Button } from "@k2b/ui";',
    'export const Old = () => <div class="flex gap-2 p-4"><Button>Save</Button></div>;',
  ].join("\n");
  expect(layoutInV2Source("Old.tsx", v1)).toEqual([]);
});

test("red: an app stylesheet that restyles v2; green: its own classes and the canvas scope", () => {
  const css = [
    ".mail-list { display: grid; }",
    "/* .k2-row in a comment is fine */",
    ".k2-ui .k2-row { padding: 0; }",
    '[data-k2-role="pane"] > div { gap: 4px; }',
    '[data-k2-canvas="radar"] circle { fill: red; }',
    ".mail { --k2-edge: 24px; }",
  ].join("\n");
  expect(lines(v2InStylesheet(css))).toEqual([
    [3, ".k2-ui .k2-row restyles the v2 class .k2-row"],
    [4, '[data-k2-role="pane"] > div restyles the v2 attribute data-k2-role'],
    [6, "sets the v2 token --k2-edge"],
  ]);
});

test("the rule scans applications only, not libraries", async () => {
  const root = await mkdtemp(join(tmpdir(), "v2-app-layout-css-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/mail", "packages/ui"] } }));
    await mkdir(join(root, "packages/mail/src"), { recursive: true });
    await mkdir(join(root, "packages/ui/src/v2"), { recursive: true });
    const screen = 'import { Pane } from "@k2b/ui/v2";\nexport const A = () => <Pane><p class="mt-2">x</p></Pane>;\n';
    await writeFile(join(root, "packages/mail/src/A.tsx"), screen);
    await writeFile(join(root, "packages/mail/src/A.test.tsx"), screen);
    await writeFile(join(root, "packages/ui/src/v2/Pane.tsx"), screen);
    await writeFile(join(root, "packages/mail/src/app.css"), ".k2-row { height: 44px; }\n");
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => [finding.file, finding.line])).toEqual([
      ["packages/mail/src/A.tsx", 2],
      ["packages/mail/src/app.css", 1],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
