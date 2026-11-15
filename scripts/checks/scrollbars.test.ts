import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./scrollbars";

test("allows only hidden scrollbars and the shared rule; every own width, colour, or ::-webkit-scrollbar look is a finding", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-scrollbars-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      "packages/demo/src/app.css": [
        ".strip { overflow-x: auto; scrollbar-width: none; }",
        ".strip::-webkit-scrollbar { display: none; }",
        ".table::-webkit-scrollbar { width: 0; height: 0; }",
        "/* .comment { scrollbar-width: thin; } */",
        ".list { scrollbar-gutter: stable; overflow-y: scroll; }",
        ".list { scrollbar-width: thin; }",
        ".list { scrollbar-color: red transparent !important; }",
        ".list::-webkit-scrollbar { width: 12px; }",
        ".list::-webkit-scrollbar-thumb { background: red; }",
        "@utility no-scrollbar {\n  ::-webkit-scrollbar {\n    display: none;\n  }\n\n  scrollbar-width: none;\n}",
        "/* scrollbars: allow the mirror layer keeps the gutter without a thumb */",
        ".mirror::-webkit-scrollbar-thumb,",
        ".other::-webkit-scrollbar-thumb {\n  background: transparent;\n}",
        ".mirror {\n  /* scrollbars: allow the mirror layer keeps the gutter without a thumb */\n  scrollbar-color: transparent transparent;\n}",
        ".fixed { scrollbar-width: auto; }",
        ".nested::-webkit-scrollbar { @media (hover: hover) { width: 12px; } }",
        ".nested::-webkit-scrollbar-thumb { &:hover { background: red; } }",
        ".nested::-webkit-scrollbar { @media (hover: hover) { display: none; } }",
        "@supports selector(::-webkit-scrollbar) { .track { overflow-y: scroll; } }",
      ].join("\n"),
      "packages/demo/src/page.tsx": [
        '<div class="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" />',
        '<div style={{ "scrollbar-width": "none" }} />',
        '<div class="[scrollbar-width:thin]" />',
        "<div style={{ scrollbarColor: 'red transparent' }} />",
        '<div class="[&::-webkit-scrollbar]:w-2" />',
        "// scrollbar-width: thin explains a choice here",
      ].join("\n"),
      "packages/demo/src/page.test.tsx": '<div class="[scrollbar-width:thin]" />',
      "packages/ui/src/styles/index.css": [
        "/* scrollbars: central rule begin */",
        ":where(.k2b-ui *)::-webkit-scrollbar { width: 0.5rem; }",
        ":where(.k2b-ui *) { scrollbar-width: thin; scrollbar-color: gray transparent; }",
        "/* scrollbars: central rule end */",
        ".k2b-ui .x { scrollbar-width: thin; }",
      ].join("\n"),
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/app.css:26",
      "packages/demo/src/app.css:27",
      "packages/demo/src/app.css:28",
      "packages/demo/src/app.css:6",
      "packages/demo/src/app.css:7",
      "packages/demo/src/app.css:8",
      "packages/demo/src/app.css:9",
      "packages/demo/src/page.tsx:3",
      "packages/demo/src/page.tsx:4",
      "packages/demo/src/page.tsx:5",
      "packages/ui/src/styles/index.css:5",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
