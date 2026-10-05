import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Controls inside a notice may keep their icons; anywhere else an icon is decoration. */
const CONTROLS = new Set(["Button", "ButtonLink", "IconButton", "IconButtonLink", "button", "a"]);
/** Own text sizes, faded text, and palette colours, with any variant prefix such as `dark:` or `hover:`. */
const OVERRIDE =
  /^(?:[\w-]+:)*(?:text-(?:xs|sm|base|lg|\[[^\]]*\])|opacity-\S+|(?:bg|text|border)-(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\S+)$/;

const tagName = (node: ts.Node): string | undefined => {
  if (ts.isJsxElement(node)) return node.openingElement.tagName.getText();
  if (ts.isJsxSelfClosingElement(node)) return node.tagName.getText();
  return undefined;
};

/** Class tokens written in a `class` or `bodyClass` value, including string parts of expressions. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokens.push(...node.text.split(/\s+/).filter(Boolean));
    }
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

/**
 * Every NoticeCard has one calm look: a tone tint, the title in primary ink,
 * and the rest in secondary ink at the reading size. A call site that adds a
 * decorative icon, its own text size, faded text, or palette colours inside a
 * notice brings back a second look.
 */
export const rule: Rule = {
  name: "notice-cards",
  description: "NoticeCard content adds no decorative icon, text size, opacity, or palette colour",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("<NoticeCard")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;

      const visit = (node: ts.Node, inNotice: boolean, inControl: boolean): void => {
        const tag = tagName(node);
        const notice = inNotice || tag === "NoticeCard";
        const control = inControl || (tag !== undefined && CONTROLS.has(tag));
        if (notice && tag === "i" && !control) {
          findings.push({
            file,
            line: lineOf(node),
            message: "Decorative icon in a NoticeCard: notices have no icon; let the words carry the meaning.",
          });
        }
        if (notice && ts.isJsxAttribute(node) && node.initializer && ["class", "bodyClass"].includes(node.name.getText())) {
          const overrides = classTokens(node.initializer).filter((token) => OVERRIDE.test(token));
          if (overrides.length > 0) {
            findings.push({
              file,
              line: lineOf(node),
              message: `${overrides.join(" ")} inside a NoticeCard: notice content keeps the shared size and ink; use title, detail, or text-primary/text-dimmed.`,
            });
          }
        }
        ts.forEachChild(node, (child) => visit(child, notice, control));
      };
      visit(sourceFile, false, false);
    }
    return findings;
  },
};
