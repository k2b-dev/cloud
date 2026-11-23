import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { appIds } from "../workspace";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * In @k2b/ui v2 the primitives own spacing, lines and type; an application brings data and order, never layout CSS
 * (concept rule 2, decided 22.11.: "layout CSS in an app fails the build"). The rule starts with an app's first v2
 * import, so the v1 screens of today are untouched:
 *
 * - A source file that imports `@k2b/ui/v2` writes no `class`, `className`, `classList` or `style` attribute, no
 *   `<style>` element and imports no stylesheet. The one exception is the inside of `Canvas`, the drawing surface
 *   where an app may draw freely.
 * - No stylesheet of an app restyles v2: no selector names a `k2-` class or a `data-k2-` attribute (other than the
 *   `data-k2-canvas` scope of a drawing), and no rule sets a `--k2-` token.
 */
const V2 = /^@k2b\/ui\/v2(?:\/|$)/;
const LAYOUT_ATTRIBUTES = new Set(["class", "className", "classList", "style"]);
const replacement = "a v2 primitive owns spacing, lines and type; draw freely only inside <Canvas>";

type Hit = { line: number; message: string };

/** The local names that stand for `Canvas` from `@k2b/ui/v2` (also through a namespace import), or null when the file does not use v2. */
const v2Bindings = (sourceFile: ts.SourceFile): { canvas: Set<string>; namespaces: Set<string> } | null => {
  const canvas = new Set<string>();
  const namespaces = new Set<string>();
  let usesV2 = false;
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !V2.test(statement.moduleSpecifier.text))
      continue;
    usesV2 = true;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) if ((element.propertyName ?? element.name).text === "Canvas") canvas.add(element.name.text);
  }
  return usesV2 ? { canvas, namespaces } : null;
};

/** Layout CSS in one TSX/TS source that imports `@k2b/ui/v2`; an empty list for any other source. */
export const layoutInV2Source = (file: string, source: string): Hit[] => {
  if (!source.includes("@k2b/ui/v2")) return [];
  const { sourceFile, findings } = parseSource(file, source);
  if (findings.length) return findings.map((finding) => ({ line: finding.line ?? 1, message: finding.message }));
  const v2 = v2Bindings(sourceFile);
  if (!v2) return [];
  const hits: Hit[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const isCanvas = (tag: ts.JsxTagNameExpression) =>
    (ts.isIdentifier(tag) && v2.canvas.has(tag.text)) ||
    (ts.isPropertyAccessExpression(tag) &&
      ts.isIdentifier(tag.expression) &&
      v2.namespaces.has(tag.expression.text) &&
      tag.name.text === "Canvas");
  const tagText = (tag: ts.JsxTagNameExpression) => tag.getText(sourceFile);
  const checkAttributes = (tag: ts.JsxTagNameExpression, attributes: ts.JsxAttributes) => {
    if (tagText(tag) === "style") hits.push({ line: lineOf(tag), message: `<style> in a v2 screen; ${replacement}` });
    for (const attribute of attributes.properties) {
      if (ts.isJsxAttribute(attribute)) {
        const name = attribute.name.getText(sourceFile);
        if (LAYOUT_ATTRIBUTES.has(name))
          hits.push({ line: lineOf(attribute), message: `${name} on <${tagText(tag)}> in a v2 screen; ${replacement}` });
        continue;
      }
      // `{...{ class: "…" }}` is the same attribute written as a spread.
      if (ts.isObjectLiteralExpression(attribute.expression))
        for (const property of attribute.expression.properties) {
          const name =
            property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
          if (name && LAYOUT_ATTRIBUTES.has(name))
            hits.push({ line: lineOf(property), message: `${name} spread onto <${tagText(tag)}> in a v2 screen; ${replacement}` });
        }
    }
  };
  const visit = (node: ts.Node, inCanvas: boolean) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /\.css(?:\?|$)/.test(node.moduleSpecifier.text))
      hits.push({ line: lineOf(node), message: `imports the stylesheet ${node.moduleSpecifier.text} into a v2 screen; ${replacement}` });
    if (ts.isJsxElement(node)) {
      const tag = node.openingElement.tagName;
      if (!inCanvas) checkAttributes(tag, node.openingElement.attributes);
      // Slot props such as head={<Bar … />} hold JSX too; they stand where the element stands, not inside it.
      ts.forEachChild(node.openingElement.attributes, (child) => visit(child, inCanvas));
      for (const child of node.children) visit(child, inCanvas || isCanvas(tag));
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      if (!inCanvas) checkAttributes(node.tagName, node.attributes);
      ts.forEachChild(node.attributes, (child) => visit(child, inCanvas));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, inCanvas));
  };
  visit(sourceFile, false);
  return hits;
};

const CANVAS_SCOPE = "data-k2-canvas";

/** Rules of one app stylesheet that restyle v2: a `k2-` class or `data-k2-` attribute in a selector, or a `--k2-` token set. */
export const v2InStylesheet = (source: string): Hit[] => {
  // Blank comments and keep every line number.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const lineAt = (index: number) => text.slice(0, index).split("\n").length;
  const hits: Hit[] = [];
  for (const match of text.matchAll(/(?:^|(?<=[{};]))(\s*)([^{};]+?)\s*\{/g)) {
    const prelude = match[2]!.trim();
    if (prelude.startsWith("@")) continue;
    const at = lineAt(match.index! + match[1]!.length);
    // Name the class the rule targets: the last one in the selector.
    const k2Class = [...prelude.matchAll(/\.k2-[\w-]+/g)].at(-1);
    const k2Attribute = [...prelude.matchAll(/\[\s*(data-k2-[\w-]+)/g)]
      .map((attribute) => attribute[1]!)
      .find((name) => name !== CANVAS_SCOPE);
    if (k2Class) hits.push({ line: at, message: `${prelude} restyles the v2 class ${k2Class[0]}; ${replacement}` });
    else if (k2Attribute) hits.push({ line: at, message: `${prelude} restyles the v2 attribute ${k2Attribute}; ${replacement}` });
  }
  for (const match of text.matchAll(/(--k2-[\w-]+)\s*:/g))
    hits.push({ line: lineAt(match.index!), message: `sets the v2 token ${match[1]}; tokens belong to @k2b/ui/v2` });
  return hits;
};

export const rule: Rule = {
  name: "v2-app-layout-css",
  description: "An app's v2 screens carry no layout CSS (class, style, stylesheets) outside Canvas, and no app stylesheet restyles v2",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const app of appIds(workspaceRoot)) {
      const root = join(workspaceRoot, "packages", app);
      for (const path of listFiles(root, /\.(?:ts|tsx)$/)) {
        if (isTestFile(path)) continue;
        for (const hit of layoutInV2Source(path, readFileSync(path, "utf8")))
          findings.push({ file: relative(workspaceRoot, path), ...hit });
      }
      for (const path of listFiles(root, /\.css$/))
        for (const hit of v2InStylesheet(readFileSync(path, "utf8"))) findings.push({ file: relative(workspaceRoot, path), ...hit });
    }
    return findings;
  },
};
