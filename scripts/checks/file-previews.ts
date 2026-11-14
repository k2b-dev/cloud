import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { packageIds } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  "a file opens large only in `Lightbox` from @k2b/ui, never in an own dialog, panel dialog, or modal; move the dialog's buttons into the Lightbox's action pill (/en/ui/content/media).";

/** The standalone libraries own the viewers themselves; the rule is about applications showing files. */
const LIBRARIES = new Set(["ui", "ssr", "editor"]);

/**
 * Dialogs that show a document as one part of a working flow, such as generating or choosing it. Each entry names
 * the file, relative to the repository, and why the flow keeps its dialog. A pure "look at this file" dialog never
 * belongs here.
 */
export const ALLOWED: Readonly<Record<string, string>> = {
  "packages/grids/src/frontend/_components/documents/DocumentGenerateDialog.tsx":
    "Generating a Document: the PDF previews the record, file name and tags chosen in the same dialog before Generate issues it.",
  "packages/grids/src/frontend/_components/workflows/WorkflowScannerSurface.tsx":
    "The video is the live camera of the scanner, not a file; its dialogs ask about scanned codes.",
};

/*
 * The check reads one module at a time: a viewer counts when the same module also opens a dialog. That covers how apps
 * built their own previews, and errs on the strict side: a page that shows a PDF in place and also asks a question in
 * a dialog is reported too; such a module goes on ALLOWED with its reason. Pictures (`<img>`) are left to review, as a
 * pattern cannot tell an avatar or an icon in a dialog from a picture shown large.
 */
/** Something that opens a dialog or modal in this module. */
const opensDialog = /dialogCore\.open\s*\(|prompts\.dialog\s*[<(]|<PanelDialog[\s>]|<Dialog[\s>.]|<Modal[\s>]|\.showModal\s*\(/;
/** A file shown large: the PDF viewer, the file renderers, a video, or an audio file. */
const preview = /<(?:PdfViewer|FileView|VideoPlayer|video|audio)[\s>/]/g;

export const rule: Rule = {
  name: "file-previews",
  description: "Applications open files large only through Lightbox, not in their own dialogs",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const packages = packageIds(workspaceRoot);
    // The list stays honest: an entry whose file is gone no longer explains anything.
    for (const path of Object.keys(ALLOWED))
      if (packages.includes(path.split("/")[1] ?? "") && !existsSync(join(workspaceRoot, path)))
        findings.push({ file: join(workspaceRoot, path), message: "listed in ALLOWED but missing; remove the entry." });
    for (const name of packages) {
      if (LIBRARIES.has(name)) continue;
      for (const file of listFiles(join(workspaceRoot, "packages", name, "src"), /\.tsx$/)) {
        if (isTestFile(file) || /\.browser-harness\.tsx$/.test(file)) continue;
        if (relative(workspaceRoot, file) in ALLOWED) continue;
        const source = readFileSync(file, "utf8");
        if (!opensDialog.test(source)) continue;
        for (const match of source.matchAll(preview)) {
          findings.push({
            file,
            line: source.slice(0, match.index).split("\n").length,
            message: `${match[0].trim()} in a dialog: ${message}`,
          });
        }
      }
    }
    return findings;
  },
};
