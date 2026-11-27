import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "@typescript/typescript6";

// The inner parts of v2's primitives: the k2- classes that v2's components write only on elements nested inside an
// element of their own. A class is a root instead when it stands on what a component returns at its top (also without
// `data-k2-part`) or on an element with `data-k2-part`; the top of a module's own helper component (not exported, used
// only as a tag, and only inside an element) is nested where it is used. A primitive puts an inner part itself, inside
// its own element, and an app never writes a k2- class (scripts/checks/v2-part-classes.ts), so no island wrapper ever
// stands between an inner part and its parent, or holds one: the island transform needs no wrapper's way for them
// (v2-island-css.ts). A class this cannot tell stays a root, which only keeps a wrapper's way the sheet does not need.
// The type roles (`k2-t-*`) are left out: a page may write them as plain text styles.

const v2Source = resolve(import.meta.dir, "../src/v2");

/** The class tokens written in a JSX attribute's value, including the string parts of an expression. */
const classTokens = (initializer: ts.JsxAttributeValue): string[] => {
  const tokens: string[] = [];
  const collect = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node))
      tokens.push(...node.text.split(/\s+/).filter((token) => token.startsWith("k2-")));
    ts.forEachChild(node, collect);
  };
  collect(initializer);
  return tokens;
};

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith(".tsx") && !/\.(?:test|spec)\.tsx$/.test(entry.name) ? [path] : [];
  });

/** A component a module declares: whether it is exported, named other than as a tag, and where each tag stands. */
type Component = { exported: boolean; other: boolean; uses: boolean[] };

/** The component a declaration defines: `const Name = …` or `function Name(…)`. */
const declaredName = (node: ts.Node): ts.Identifier | undefined => {
  if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) return node.name;
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && /^[A-Z]/.test(node.name.text)) return node.name;
  return undefined;
};
const exportedStatement = (node: ts.Node) => {
  const statement = ts.isVariableDeclaration(node) ? node.parent.parent : node;
  return ts.canHaveModifiers(statement) && (ts.getModifiers(statement) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
};

/** The inner parts of the primitives in `dir` (v2's own sources by default). */
export const v2Parts = (dir = v2Source): ReadonlySet<string> => {
  const inner = new Set<string>();
  const roots = new Set<string>();
  for (const path of sources(dir)) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const components = new Map<string, Component>();
    const component = (name: string) => {
      const found = components.get(name) ?? { exported: false, other: false, uses: [] };
      components.set(name, found);
      return found;
    };
    // the classes on the top of each component, judged once all its uses are known
    const tops = new Map<string, Set<string>>();
    // `nested`: an HTML element of the same JSX encloses the node; `owner`: the component whose top this is
    const visit = (node: ts.Node, nested: boolean, owner: string | undefined): void => {
      const name = declaredName(node);
      if (name && !nested) {
        component(name.text).exported ||= exportedStatement(node);
        ts.forEachChild(node, (child) => visit(child, false, name.text));
        return;
      }
      if (ts.isExportSpecifier(node)) component((node.propertyName ?? node.name).getText(source)).exported = true;
      if (ts.isIdentifier(node) && /^[A-Z]/.test(node.text)) {
        const parent = node.parent;
        const tag =
          (ts.isJsxOpeningElement(parent) || ts.isJsxSelfClosingElement(parent) || ts.isJsxClosingElement(parent)) &&
          parent.tagName === node;
        if (!tag && declaredName(parent) !== node && !ts.isExportSpecifier(parent)) component(node.text).other = true;
      }
      const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
      if (opening) {
        const tagName = opening.tagName.getText(source);
        if (/^[A-Z]\w*$/.test(tagName)) component(tagName).uses.push(nested);
        const attributes = opening.attributes.properties.filter(ts.isJsxAttribute);
        const marked = attributes.some((attribute) => attribute.name.getText(source) === "data-k2-part");
        for (const attribute of attributes)
          if (/^class(Name|List)?$/.test(attribute.name.getText(source)) && attribute.initializer)
            for (const token of classTokens(attribute.initializer)) {
              if (marked) roots.add(token);
              else if (nested) inner.add(token);
              else if (owner) tops.set(owner, (tops.get(owner) ?? new Set<string>()).add(token));
              else roots.add(token);
            }
        // a lower-case tag is an HTML element: what stands inside it is nested, also in a callback (`<For>{(item) => …}`)
        const intrinsic = /^[a-z]/.test(tagName);
        ts.forEachChild(node, (child) => visit(child, nested || intrinsic, owner));
        return;
      }
      ts.forEachChild(node, (child) => visit(child, nested, owner));
    };
    visit(source, false, undefined);
    for (const [owner, top] of tops) {
      const used = components.get(owner);
      const own = used !== undefined && !used.exported && !used.other && used.uses.length > 0 && used.uses.every(Boolean);
      for (const token of top) (own ? inner : roots).add(token);
    }
  }
  return new Set([...inner].filter((token) => !roots.has(token) && !token.startsWith("k2-t-") && token !== "k2-ui"));
};
