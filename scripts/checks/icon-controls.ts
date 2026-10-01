import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/** Shared buttons that would render an icon without its label as accessible name and tooltip. */
const SHARED_BUTTONS = new Map([
  ["Button", "IconButton"],
  ["ButtonLink", "IconButtonLink"],
]);
/** Native controls and Tooltip.Trigger: an icon child carries no name, so the element needs one. */
const NATIVE_CONTROLS = new Set(["button", "a", "Tooltip.Trigger"]);
const NAME_ATTRIBUTES = new Set(["aria-label", "aria-labelledby"]);

const isIcon = (child: ts.JsxChild): boolean => {
  if (ts.isJsxText(child)) return child.containsOnlyTriviaWhiteSpaces;
  if (ts.isJsxSelfClosingElement(child)) return child.tagName.getText() === "i";
  if (ts.isJsxElement(child)) return child.openingElement.tagName.getText() === "i" && child.children.every(isIcon);
  return false;
};

const attributeNames = (attributes: ts.JsxAttributes): { names: Set<string>; spread: boolean } => {
  const names = new Set<string>();
  let spread = false;
  for (const property of attributes.properties) {
    if (ts.isJsxSpreadAttribute(property)) spread = true;
    else names.add(property.name.getText());
  }
  return { names, spread };
};

/**
 * Icon-only controls carry their label as accessible name, and the shared
 * IconButton family also shows it as a tooltip. A shared Button with only an
 * icon skips that tooltip, and a native control with only an icon has no name.
 */
export const rule: Rule = {
  name: "icon-controls",
  description: "icon-only controls use IconButton or IconButtonLink, and native ones carry an accessible name",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

      const visit = (node: ts.Node): void => {
        if (ts.isJsxElement(node) && node.children.length > 0 && node.children.every(isIcon) && !node.children.every(ts.isJsxText)) {
          const tag = node.openingElement.tagName.getText();
          const { names, spread } = attributeNames(node.openingElement.attributes);
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          const replacement = SHARED_BUTTONS.get(tag);
          if (replacement && !names.has("aria-labelledby")) {
            findings.push({
              file,
              line,
              message: `Icon-only <${tag}>: use <${replacement} label=...> so the label is its accessible name and tooltip.`,
            });
          } else if (NATIVE_CONTROLS.has(tag) && !spread && ![...NAME_ATTRIBUTES].some((name) => names.has(name))) {
            findings.push({
              file,
              line,
              message: `Icon-only <${tag}> has no accessible name; add aria-label (and a tooltip for actions).`,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
