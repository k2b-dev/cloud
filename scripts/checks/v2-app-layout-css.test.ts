import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { layoutInV2Source, rule, v2InStylesheet } from "./v2-app-layout-css";

const lines = (hits: { line: number; message: string }[]) => hits.map((hit) => [hit.line, hit.message.split(";")[0]]);
const screen = (...source: string[]) => lines(layoutInV2Source("Screen.tsx", source.join("\n")));

test("red: layout CSS in a v2 screen, also in a slot prop and as a spread", () => {
  expect(
    screen(
      'import { Pane, Row, Band, Canvas } from "@k2b/ui/v2";',
      'import "./mail.css";',
      "export const Inbox = () => (",
      '  <Pane head={<div class="flex gap-2">Inbox</div>}>',
      '    <div style={{ padding: "8px" }}>',
      '      <Row title="A" {...{ class: "pl-5" }} />',
      "    </div>",
      "    <style>{'.x { margin: 0 }'}</style>",
      '    <Band><Canvas class="h-40" /></Band>',
      "  </Pane>",
      ");",
    ),
  ).toEqual([
    [2, "imports the stylesheet ./mail.css into a v2 screen"],
    [4, "class on <div> in a v2 screen"],
    [5, "style on <div> in a v2 screen"],
    [6, "class spread onto <Row> in a v2 screen"],
    [8, "<style> in a v2 screen"],
    [9, "class on <Canvas> in a v2 screen"],
  ]);
});

test("red: attr: and prop: forms, spreads onto plain elements, styling refs and innerHTML", () => {
  expect(
    screen(
      'import { Pane, Row } from "@k2b/ui/v2";',
      "export const Inbox = (props: { extra: object; html: string }) => (",
      "  <Pane>",
      '    <p attr:style="margin: 0">a</p>',
      '    <p attr:class="mt-2">b</p>',
      '    <p prop:className="mt-2">c</p>',
      "    <p {...props.extra}>d</p>",
      "    <p ref={(el) => { el.style.marginTop = '4px'; }}>e</p>",
      "    <p ref={(el) => el.classList.add('pl-5')}>f</p>",
      "    <div innerHTML={props.html} />",
      "  </Pane>",
      ");",
    ),
  ).toEqual([
    [4, "attr:style on <p> in a v2 screen"],
    [5, "attr:class on <p> in a v2 screen"],
    [6, "prop:className on <p> in a v2 screen"],
    [7, "a spread onto <p> in a v2 screen can carry class or style"],
    [8, "the ref of <p> styles the element in a v2 screen"],
    [9, "the ref of <p> styles the element in a v2 screen"],
    [10, "innerHTML on <div> in a v2 screen brings its own markup and styles"],
  ]);
});

test("green: a spread onto a primitive, a ref that does not style, everything inside Canvas", () => {
  expect(
    screen(
      'import { Band, Canvas, Row } from "@k2b/ui/v2";',
      "export const Radar = (props: { row: object }) => {",
      "  let focus: HTMLElement | undefined;",
      "  return (",
      "    <Band>",
      "      <Row {...props.row} />",
      "      <Canvas label=\"Radar\"><svg class=\"radar\" ref={(el) => { el.style.opacity = '1'; }}><circle style={{ fill: 'red' }} /></svg></Canvas>",
      "      <p ref={focus}>text</p>",
      "    </Band>",
      "  );",
      "};",
    ),
  ).toEqual([]);
});

test("red: a Canvas around the whole screen or inside a plain element; green: in a primitive, a slot or Solid's control flow", () => {
  expect(
    screen(
      'import { Show } from "solid-js";',
      'import { Band, Canvas, Pane } from "@k2b/ui/v2";',
      'export const Whole = () => <Canvas label="Screen"><div class="free">everything</div></Canvas>;',
      'export const Inside = () => <Pane><section><Canvas label="Map" /></section></Pane>;',
      "export const Fine = (props: { on: boolean }) => (",
      '  <Pane head={<Canvas label="Spark" />}>',
      '    <Band><Show when={props.on}><><Canvas label="Radar" /></></Show></Band>',
      "  </Pane>",
      ");",
    ),
  ).toEqual([
    [3, "<Canvas> stands as the root of a component"],
    [4, "<Canvas> stands outside a v2 primitive"],
  ]);
});

test("green: a v1 screen is untouched, also with a type-only import from v2", () => {
  expect(screen('import { Button } from "@k2b/ui";', 'export const Old = () => <div class="flex gap-2 p-4"><Button>Save</Button></div>;')).toEqual([]);
  expect(
    screen(
      'import type { TypeRole } from "@k2b/ui/v2";',
      'import { type typeRoles } from "@k2b/ui/v2";',
      'export const Old = (props: { role: TypeRole }) => <div class="flex gap-2">{props.role}</div>;',
    ),
  ).toEqual([]);
});

test("red: a dynamic import makes a v2 screen, and its Canvas counts", () => {
  expect(
    screen(
      "export const Lazy = async () => {",
      '  const { Band, Canvas: Drawing } = await import("@k2b/ui/v2");',
      '  return <Band><Drawing label="x"><svg class="free" /></Drawing><p class="mt-2">x</p></Band>;',
      "};",
    ),
  ).toEqual([[3, "class on <p> in a v2 screen"]]);
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

const tree = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "v2-app-layout-css-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/mail", "packages/ui"] } }));
    for (const [name, source] of Object.entries(files)) {
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), source);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    // Directory order differs between file systems.
    return findings.map((finding) => [finding.file, finding.line, finding.message.split(";")[0]]).sort();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("the rule scans applications only, not libraries", async () => {
  const screenSource = 'import { Pane } from "@k2b/ui/v2";\nexport const A = () => <Pane><p class="mt-2">x</p></Pane>;\n';
  expect(
    await tree({
      "packages/mail/src/A.tsx": screenSource,
      "packages/mail/src/A.test.tsx": screenSource,
      "packages/ui/src/v2/Pane.tsx": screenSource,
      "packages/mail/src/app.css": ".k2-row { height: 44px; }\n",
    }),
  ).toEqual([
    ["packages/mail/src/A.tsx", 2, "class on <p> in a v2 screen"],
    ["packages/mail/src/app.css", 1, ".k2-row restyles the v2 class .k2-row"],
  ]);
});

test("red: a local barrel that re-exports v2 makes a v2 screen; green: a module that only uses v2 inside", async () => {
  expect(
    await tree({
      "packages/mail/src/ui.ts": 'export { Band, Canvas as Drawing } from "@k2b/ui/v2";\n',
      "packages/mail/src/all.ts": 'export * from "@k2b/ui/v2";\n',
      "packages/mail/src/Row.tsx": 'import { Row } from "@k2b/ui/v2";\nexport const MailRow = () => <Row title="x" />;\n',
      "packages/mail/src/A.tsx": [
        'import { Band, Drawing } from "./ui";',
        'export const A = () => <Band><Drawing label="x"><svg class="free" /></Drawing><p class="mt-2">x</p></Band>;',
      ].join("\n"),
      "packages/mail/src/B.tsx": 'import * as ui from "./all";\nexport const B = () => <ui.Band><ui.Canvas label="y"><i class="free" /></ui.Canvas><b class="m-1" /></ui.Band>;\n',
      "packages/mail/src/C.tsx": 'import { MailRow } from "./Row";\nexport const C = () => <div class="flex"><MailRow /></div>;\n',
    }),
  ).toEqual([
    ["packages/mail/src/A.tsx", 2, "class on <p> in a v2 screen"],
    ["packages/mail/src/B.tsx", 2, "class on <b> in a v2 screen"],
  ]);
});
