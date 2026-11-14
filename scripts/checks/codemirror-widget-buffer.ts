import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const message =
  'CodeMirror puts hidden `<img class="cm-widgetBuffer">` elements next to inline widgets (mostly in WebKit), so a bare `img` inside `.cm-content` can match a buffer that never becomes visible; target the widget\'s image, e.g. `.cm-image-widget img`.';

/** A selector string that reaches an `img` inside `.cm-content` without naming the widget or excluding the buffer. */
const bareContentImage = /\.cm-content\b[^"'`\n]*?(?<![\w-])img\b(?![\w-]*:not\(\.cm-widgetBuffer\))/g;

export const findBareContentImages = (file: string, source: string): Finding[] => {
  const findings: Finding[] = [];
  for (const string of source.matchAll(/(["'`])((?:(?!\1)[^\\\n]|\\.)*)\1/g)) {
    const text = string[2] ?? "";
    for (const match of text.matchAll(bareContentImage)) {
      if (/\.cm-[\w-]+-widget\b[^"'`]*\bimg\b/.test(match[0])) continue;
      findings.push({ file, line: source.slice(0, string.index).split("\n").length, message: `${match[0]}: ${message}` });
    }
  }
  return findings;
};

export const rule: Rule = {
  name: "codemirror-widget-buffer",
  description: "Browser tests never wait for a bare img inside CodeMirror content",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const area of ["packages", "pwas", "docs-site"])
      for (const file of listFiles(join(workspaceRoot, area), /\.browser\.test\.tsx?$/))
        findings.push(...findBareContentImages(file, readFileSync(file, "utf8")));
    return findings;
  },
};
