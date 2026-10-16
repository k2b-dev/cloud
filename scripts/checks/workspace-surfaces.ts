import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { workspacePackages } from "../workspace";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

const FILL = new Set(["flex-1", "grow", "size-full", "inset-0"]);
const RADIUS = /^rounded-(?:lg|xl|2xl|3xl|\[var\(--(?:ui-radius-(?:surface|frame)|k2b-radius-(?:surface|dialog))\)\])$/;
const BORDER =
  /^border(?:-(?:2|4|8|\[(?:0|(?:\d*\.)?\d+(?:px|rem|em|ex|ch|cap|ic|lh|rlh|vw|vh|vi|vb|vmin|vmax|dvw|dvh|svw|svh|lvw|lvh|cqw|cqh|cqi|cqb|cqmin|cqmax|cm|mm|Q|in|pt|pc))\]))?$/;
const ADVICE =
  "fills its area with a second card: a view in AppWorkspace.Main uses the workspace's surface edge to edge; drop the radius and border, or inset a card with Main padding where the content needs another level.";

/** Variant separators inside arbitrary values or selectors belong to the value, not the prefix. */
const withoutVariants = (token: string): string => {
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    if (token[i] === "[") depth++;
    else if (token[i] === "]") depth--;
    else if (token[i] === ":" && depth === 0) start = i + 1;
  }
  return token.slice(start);
};

/** Inspect literal class parts, including templates and branches, on this element only. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      tokens.push(...node.text.split(/\s+/).filter(Boolean).map(withoutVariants));
    }
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

export const rule: Rule = {
  name: "workspace-surfaces",
  description: "Views that fill the workspace use Main's surface without a second card",
  run: async ({ workspaceRoot }) => {
    const roots = workspacePackages(workspaceRoot)
      .filter((entry) => /^(?:packages|pwas)\/[^/]+$/.test(entry))
      // UI owns standalone surface primitives, including AppOverview.EmptyState's paper panel.
      .filter((entry) => entry !== "packages/ui")
      .map((entry) => join(workspaceRoot, entry, "src"));
    const findings: Finding[] = [];
    for (const file of roots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file) || /\.browser-(?:harness|fixture)\.tsx?$/.test(file)) continue;
      const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node, surface?: "standalone" | "workspace"): void => {
        if (ts.isJsxElement(node)) {
          const tag = node.openingElement.tagName.getText();
          if (tag === "AppWorkspace.Main") surface = "workspace";
          // A native main outside a workspace owns a standalone page, rather than Main's surface.
          else if (tag === "main" && surface !== "workspace") surface = "standalone";
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const tokens = attributes
            .filter((attr) => ["class", "className"].includes(attr.name.getText()) && attr.initializer)
            .flatMap((attr) => (attr.initializer ? classTokens(attr.initializer) : []));
          const fill = tokens.filter((token) => FILL.has(token));
          if (tokens.includes("h-full") && tokens.includes("w-full")) fill.push("h-full", "w-full");
          const radius = tokens.find((token) => RADIUS.test(token));
          const border = tokens.find((token) => BORDER.test(token));
          const tag = node.tagName.getText();
          const literalProp = (name: string, value: string) =>
            attributes.some((attr) => {
              if (attr.name.getText() !== name || !attr.initializer) return false;
              const valueNode = ts.isJsxExpression(attr.initializer) ? attr.initializer.expression : attr.initializer;
              return valueNode !== undefined && ts.isStringLiteralLike(valueNode) && valueNode.text === value;
            });
          // A paper placeholder is a Paper; a panel fills a work area, so a paper surface around it is the same inset card.
          const paperPlaceholder = tag === "Placeholder" && literalProp("surface", "paper");
          const paper = tag === "Paper" || paperPlaceholder;
          const panelPaper = paperPlaceholder && literalProp("variant", "panel");
          if (surface !== "standalone" && ((fill.length > 0 && ((radius && border) || paper)) || panelPaper)) {
            const evidence = panelPaper
              ? 'Placeholder surface="paper" variant="panel"'
              : [...new Set(fill), ...(paper ? [paperPlaceholder ? 'Placeholder surface="paper"' : "Paper"] : [radius, border])].join(" ");
            findings.push({
              file,
              line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
              message: `${evidence} ${ADVICE}`,
            });
          }
        }
        ts.forEachChild(node, (child) => visit(child, surface));
      };
      visit(sourceFile);
    }
    return findings;
  },
};
