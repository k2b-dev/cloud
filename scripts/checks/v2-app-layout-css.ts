import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { appIds } from "../workspace";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * In @k2b/ui v2 the primitives own spacing, lines and type; an application brings data and order, never layout CSS
 * (concept rule 2, decided 22.11.: layout CSS in an app fails `bun run check` and the gate). The rule starts with an
 * app file's first v2 value import, so the v1 screens of today are untouched.
 *
 * A file uses v2 when it imports a value from `@k2b/ui/v2` (also `await import(…)`), or from a local module that
 * re-exports `@k2b/ui/v2` (one level: a barrel such as `./ui.ts`). A type-only import does not count. Outside `Canvas`
 * such a file writes:
 *
 * - no `class`, `className`, `classList` or `style` attribute, also as `attr:`/`prop:` or in an object spread;
 * - no spread of anything else onto a plain element (`<div {...extra}>`), which can carry the same attributes;
 * - no `ref` callback that sets `style`, `classList`, `className` or a `style`/`class` attribute;
 * - no `innerHTML` on a plain element (markup brings its own classes and styles; reading text belongs in `Prose`);
 * - no `<style>` element and no stylesheet import.
 *
 * `Canvas` is the drawing surface: everything inside it is free. It takes its size from the primitive around it, so it
 * stands directly in a v2 primitive of the same JSX (through fragments and Solid's control flow such as `<Show>`),
 * never as the root of a component and never inside a plain element. A screen therefore cannot wrap itself in Canvas;
 * a drawing component returns its drawing and the screen places it: `<Band><Canvas><Radar /></Canvas></Band>`.
 *
 * No stylesheet of an app restyles v2: no selector names a `k2-` class or a `data-k2-` attribute (other than the
 * `data-k2-canvas` scope of a drawing), and no rule sets a `--k2-` token.
 *
 * Limits: the rule reads one file and the local modules it imports directly. Layout written in a file without a v2
 * import, imperative styling outside a `ref` callback, and CSS that a v1 component brings along are not seen.
 */
const V2 = /^@k2b\/ui\/v2(?:\/|$)/;
const LAYOUT_ATTRIBUTES = new Set(["class", "className", "classList", "style"]);
const CONTROL_FLOW = new Set(["Show", "For", "Index", "Switch", "Match", "Suspense", "ErrorBoundary"]);
const replacement = "a v2 primitive owns spacing, lines and type; draw freely only inside <Canvas>";

type Hit = { line: number; message: string };

/** What a module offers from v2: exported name → v2 name; `star` when it re-exports all of v2. */
type V2Exports = { names: Map<string, string>; star: boolean };

const isV2Specifier = (node: ts.Node | undefined): node is ts.StringLiteral => !!node && ts.isStringLiteral(node) && V2.test(node.text);

/** The value bindings a module imports from v2: local name → v2 name; `*` for a namespace. */
const v2ValueImports = (sourceFile: ts.SourceFile): Map<string, string> => {
  const locals = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !isV2Specifier(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) locals.set(clause.name.text, "default");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) locals.set(bindings.name.text, "*");
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) if (!element.isTypeOnly) locals.set(element.name.text, (element.propertyName ?? element.name).text);
  }
  return locals;
};

/** What a local module re-exports from v2, or null when it re-exports nothing of it. */
const v2ReExports = (sourceFile: ts.SourceFile): V2Exports | null => {
  const locals = v2ValueImports(sourceFile);
  const names = new Map<string, string>();
  let star = false;
  const exported = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (isV2Specifier(statement.moduleSpecifier)) {
        if (!clause) star = true;
        else if (ts.isNamespaceExport(clause)) names.set(clause.name.text, "*");
        else for (const element of clause.elements) if (!element.isTypeOnly) names.set(element.name.text, (element.propertyName ?? element.name).text);
      } else if (!statement.moduleSpecifier && clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const v2Name = locals.get((element.propertyName ?? element.name).text);
          if (v2Name && !element.isTypeOnly) names.set(element.name.text, v2Name);
        }
      }
    }
    if (ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)) {
      const v2Name = locals.get(statement.expression.text);
      if (v2Name) names.set("default", v2Name);
    }
    if (ts.isVariableStatement(statement) && exported(statement))
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer && ts.isIdentifier(declaration.initializer)) {
          const v2Name = locals.get(declaration.initializer.text);
          if (v2Name) names.set(declaration.name.text, v2Name);
        }
  }
  return star || names.size ? { names, star } : null;
};

/** The file a relative specifier names, as a bundler resolves it, or null. */
const resolveLocal = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier.replace(/\.[cm]?js$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")])
    if (existsSync(candidate) && candidate.match(/\.tsx?$/)) return candidate;
  return null;
};

/** The v2 names a file can use: local name → v2 name (`*` for a namespace whose members map through `members`). */
type Bindings = { names: Map<string, string>; members: Map<string, V2Exports>; control: Set<string>; usesV2: boolean };

const bindingsOf = (file: string, sourceFile: ts.SourceFile, readModule: (path: string) => string | null): Bindings => {
  const names = new Map<string, string>();
  const members = new Map<string, V2Exports>();
  const control = new Set<string>();
  let usesV2 = false;
  const all: V2Exports = { names: new Map(), star: true };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (specifier === "solid-js" || specifier === "solid-js/web") {
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) if (CONTROL_FLOW.has((element.propertyName ?? element.name).text)) control.add(element.name.text);
      continue;
    }
    let offered: V2Exports | null = null;
    if (V2.test(specifier)) {
      // A side-effect import loads v2 as well; a type-only import does not.
      if (!clause) usesV2 = true;
      offered = all;
    } else if (specifier.startsWith(".")) {
      const target = resolveLocal(file, specifier);
      const text = target ? readModule(target) : null;
      offered = text && target ? v2ReExports(parseSource(target, text).sourceFile) : null;
    }
    if (!offered || !clause || clause.isTypeOnly) continue;
    const take = (local: string, imported: string) => {
      const v2Name = offered.star ? imported : offered.names.get(imported);
      if (!v2Name) return;
      usesV2 = true;
      if (v2Name === "*") members.set(local, all);
      else names.set(local, v2Name);
    };
    if (clause.name) take(clause.name.text, "default");
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      usesV2 = true;
      members.set(bindings.name.text, offered);
    }
    if (bindings && ts.isNamedImports(bindings))
      for (const element of bindings.elements) if (!element.isTypeOnly) take(element.name.text, (element.propertyName ?? element.name).text);
  }
  // await import("@k2b/ui/v2"), also destructured: const { Canvas } = await import(…)
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && isV2Specifier(node.arguments[0])) usesV2 = true;
    if (ts.isVariableDeclaration(node) && node.initializer) {
      let value: ts.Expression = node.initializer;
      while (ts.isAwaitExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isCallExpression(value) && value.expression.kind === ts.SyntaxKind.ImportKeyword && isV2Specifier(value.arguments[0])) {
        if (ts.isIdentifier(node.name)) members.set(node.name.text, all);
        if (ts.isObjectBindingPattern(node.name))
          for (const element of node.name.elements)
            if (ts.isIdentifier(element.name))
              names.set(element.name.text, (element.propertyName && ts.isIdentifier(element.propertyName) ? element.propertyName : element.name).text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { names, members, control, usesV2 };
};

const readText = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Writes to an element's look inside a `ref` callback. */
const styling = /\.style\b|\.classList\b|\.className\b|\.cssText\b|setAttribute\(\s*["'`](?:style|class)["'`]/;

type Context = "v2" | "other" | "root";

/** Layout CSS in one TSX/TS source that uses `@k2b/ui/v2`; an empty list for any other source. */
export const layoutInV2Source = (file: string, source: string, readModule: (path: string) => string | null = readText): Hit[] => {
  // Cheap first: only a file that names v2, or imports a local module that does, needs a parse.
  const mentions = (text: string | null) => !!text?.includes("@k2b/ui/v2");
  if (!mentions(source)) {
    const locals = [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)].map((match) => match[1]!);
    if (!locals.some((specifier) => mentions(((target) => (target ? readModule(target) : null))(resolveLocal(file, specifier))))) return [];
  }
  const { sourceFile, findings } = parseSource(file, source);
  if (findings.length) return findings.map((finding) => ({ line: finding.line ?? 1, message: finding.message }));
  const v2 = bindingsOf(file, sourceFile, readModule);
  if (!v2.usesV2) return [];
  const hits: Hit[] = [];
  const lineOf = (node: ts.Node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const v2Name = (tag: ts.JsxTagNameExpression): string | undefined => {
    if (ts.isIdentifier(tag)) return v2.names.get(tag.text);
    if (ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression)) {
      const offered = v2.members.get(tag.expression.text);
      if (!offered) return undefined;
      return offered.star ? tag.name.text : offered.names.get(tag.name.text);
    }
    return undefined;
  };
  const tagText = (tag: ts.JsxTagNameExpression) => tag.getText(sourceFile);
  const plain = (tag: ts.JsxTagNameExpression) => ts.isIdentifier(tag) && /^[a-z]/.test(tag.text);
  const attributeName = (name: ts.JsxAttributeName) => (ts.isJsxNamespacedName(name) ? name.name.text : name.text);
  const checkAttributes = (tag: ts.JsxTagNameExpression, attributes: ts.JsxAttributes) => {
    const at = `<${tagText(tag)}>`;
    if (tagText(tag) === "style") hits.push({ line: lineOf(tag), message: `<style> in a v2 screen; ${replacement}` });
    for (const attribute of attributes.properties) {
      if (ts.isJsxAttribute(attribute)) {
        const name = attributeName(attribute.name);
        const written = attribute.name.getText(sourceFile);
        if (LAYOUT_ATTRIBUTES.has(name)) hits.push({ line: lineOf(attribute), message: `${written} on ${at} in a v2 screen; ${replacement}` });
        if (name === "innerHTML" && plain(tag))
          hits.push({ line: lineOf(attribute), message: `${written} on ${at} in a v2 screen brings its own markup and styles; use Prose` });
        if (name === "ref" && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
          const callback = attribute.initializer.expression;
          if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && styling.test(callback.body.getText(sourceFile)))
            hits.push({ line: lineOf(attribute), message: `the ref of ${at} styles the element in a v2 screen; ${replacement}` });
        }
        continue;
      }
      if (ts.isObjectLiteralExpression(attribute.expression)) {
        // `{...{ class: "…" }}` is the same attribute written as a spread.
        for (const property of attribute.expression.properties) {
          const name = property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) ? property.name.text : undefined;
          if (name && LAYOUT_ATTRIBUTES.has(name)) hits.push({ line: lineOf(property), message: `${name} spread onto ${at} in a v2 screen; ${replacement}` });
        }
      } else if (plain(tag)) {
        hits.push({ line: lineOf(attribute), message: `a spread onto ${at} in a v2 screen can carry class or style; ${replacement}` });
      }
    }
  };
  const visit = (node: ts.Node, context: Context, inCanvas: boolean) => {
    if (!inCanvas && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /\.css(?:\?|$)/.test(node.moduleSpecifier.text))
      hits.push({ line: lineOf(node), message: `imports the stylesheet ${node.moduleSpecifier.text} into a v2 screen; ${replacement}` });
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName;
      const name = v2Name(tag);
      const transparent = ts.isIdentifier(tag) && v2.control.has(tag.text);
      const canvas = name === "Canvas";
      if (!inCanvas) {
        checkAttributes(tag, opening.attributes);
        if (canvas && context !== "v2")
          hits.push({
            line: lineOf(tag),
            message: `<${tagText(tag)}> stands ${context === "root" ? "as the root of a component" : "outside a v2 primitive"}; Canvas takes its size from the primitive around it, so place it directly in one, such as <Band><Canvas>…</Canvas></Band>`,
          });
      }
      const own: Context = transparent ? context : name ? "v2" : "other";
      // Slot props such as head={<Bar … />} stand where the element stands: in it, for placement.
      ts.forEachChild(opening.attributes, (child) => visit(child, own, inCanvas));
      if (ts.isJsxElement(node)) for (const child of node.children) visit(child, own, inCanvas || canvas);
      return;
    }
    // A fragment is transparent; any other node passes its context on.
    ts.forEachChild(node, (child) => visit(child, context, inCanvas));
  };
  visit(sourceFile, "root", false);
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
    const k2Attribute = [...prelude.matchAll(/\[\s*(data-k2-[\w-]+)/g)].map((attribute) => attribute[1]!).find((name) => name !== CANVAS_SCOPE);
    if (k2Class) hits.push({ line: at, message: `${prelude} restyles the v2 class ${k2Class[0]}; ${replacement}` });
    else if (k2Attribute) hits.push({ line: at, message: `${prelude} restyles the v2 attribute ${k2Attribute}; ${replacement}` });
  }
  for (const match of text.matchAll(/(--k2-[\w-]+)\s*:/g))
    hits.push({ line: lineAt(match.index!), message: `sets the v2 token ${match[1]}; tokens belong to @k2b/ui/v2` });
  return hits;
};

export const rule: Rule = {
  name: "v2-app-layout-css",
  description: "An app's v2 screens carry no layout CSS (class, style, spreads, stylesheets) outside Canvas, and no app stylesheet restyles v2",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const texts = new Map<string, string | null>();
    const cached = (path: string) => {
      if (!texts.has(path)) texts.set(path, readText(path));
      return texts.get(path) ?? null;
    };
    for (const app of appIds(workspaceRoot)) {
      const root = join(workspaceRoot, "packages", app);
      for (const path of listFiles(root, /\.(?:ts|tsx)$/)) {
        if (isTestFile(path) || path.endsWith(".d.ts")) continue;
        for (const hit of layoutInV2Source(path, cached(path) ?? "", cached)) findings.push({ file: relative(workspaceRoot, path), ...hit });
      }
      for (const path of listFiles(root, /\.css$/))
        for (const hit of v2InStylesheet(readFileSync(path, "utf8"))) findings.push({ file: relative(workspaceRoot, path), ...hit });
    }
    return findings;
  },
};
