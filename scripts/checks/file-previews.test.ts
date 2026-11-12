import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { rule } from "./file-previews";

test("finds files shown large in an application's own dialog, not in the Lightbox or on the page", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-file-previews-rule-"));
  try {
    const files = {
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/demo", "packages/ui"] } }),
      // An attachment preview in an own dialog: the PDF and the video are found.
      "packages/demo/src/AttachmentDialog.tsx": [
        "export const open = () => dialogCore.open((close) => (",
        "  <PanelDialog>",
        '    <PdfViewer data={blob} title="Invoice" />',
        '    <video src="/clip.mp4" controls />',
        '    <audio src="/memo.m4a" controls />',
        "  </PanelDialog>",
        "));",
      ].join("\n"),
      // The same viewer on the page, and the Lightbox in a module that also opens a confirmation, are fine.
      "packages/demo/src/Report.tsx": '<section><PdfViewer data={blob} title="Report" /></section>',
      "packages/demo/src/Gallery.tsx": [
        "const confirm = () => prompts.dialog((close) => <p>Delete?</p>);",
        "<Lightbox items={items} index={index()} onIndexChange={setIndex} onClose={close} />",
      ].join("\n"),
      "packages/demo/src/Preview.test.tsx": "dialogCore.open(() => <PdfViewer data={blob} title='x' />)",
      // The library owns its viewers.
      "packages/ui/src/content/Viewer.tsx": "<Dialog><FileView file={file} load={load} /></Dialog>",
    };
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    const findings = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    expect(findings.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line}`).sort()).toEqual([
      "packages/demo/src/AttachmentDialog.tsx:3",
      "packages/demo/src/AttachmentDialog.tsx:4",
      "packages/demo/src/AttachmentDialog.tsx:5",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
