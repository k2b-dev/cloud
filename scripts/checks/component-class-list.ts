import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * A component that spreads its rest props and then sets `class` hands Solid a
 * `classList` before the `class` it builds; the later `className` write erases
 * the toggled classes on the first render. Components therefore get one
 * computed `class`; `classList` stays on native elements.
 */
export const rule: Rule = {
  name: "component-class-list",
  description: "components receive a computed class, never classList",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, /\.tsx$/)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes("classList")) continue;
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText();
          // Only a plain lowercase name is a native element; `Foo`, `Foo.Bar` and `props.item` are components.
          const native = ts.isIdentifier(node.tagName) && /^[a-z]/.test(tag);
          if (!native) {
            for (const property of node.attributes.properties) {
              if (ts.isJsxAttribute(property) && property.name.getText() === "classList") {
                findings.push({
                  file,
                  line: sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line + 1,
                  message: `<${tag} classList>: pass one computed class instead; a component that spreads its props loses classList on the first render.`,
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
    return findings;
  },
};
