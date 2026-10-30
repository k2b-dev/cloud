import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isCloudCredentialCookie } from "@k2b/cloud/contracts/app-domains";
import ts from "@typescript/typescript6";
import { Glob } from "bun";

const root = new URL("../../../", import.meta.url).pathname;
// Cookie values here are preferences or display state; none conveys access.
const nonCredentials = new Map([
  ["theme", "Theme preference."],
  ["color-scheme", "Resolved appearance for the first server render."],
  ["cloud.locale", "Language preference."],
  ["cloud.timezone", "Time zone preference."],
  ["cloud_seen_hints", "Dismissed UI hint IDs."],
  ["pwa_ended", "Display marker telling the phone to discard local drafts."],
  ["pwa_last_address", "Last address label shown by the mobile app."],
  ["cloud_mail_workspace", "Mail layout and pinned mailbox preferences."],
  ["app-access-fixture", "Identifies in-memory state in the browser UI fixture."],
]);
const sources = new Map<string, ts.SourceFile>();
const sourceAt = (path: string): ts.SourceFile => {
  let source = sources.get(path);
  if (!source) {
    source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    sources.set(path, source);
  }
  return source;
};
const importedSource = (source: ts.SourceFile, name: string): { source: ts.SourceFile; name: string } | null => {
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    const entry = bindings.elements.find((entry) => entry.name.text === name);
    if (!entry) continue;
    const module = statement.moduleSpecifier.text;
    const base = module.startsWith(".") ? resolve(dirname(source.fileName), module) : null;
    if (!base) return null;
    const path = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find(existsSync);
    return path ? { source: sourceAt(path), name: entry.propertyName?.text ?? name } : null;
  }
  return null;
};
const declaration = (source: ts.SourceFile, name: string): ts.Expression | null => {
  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer)
      found.push(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found.length === 1 ? (found[0] ?? null) : null;
};
const resolveNames = (expression: ts.Expression, source: ts.SourceFile, raw = false, depth = 0): string[] | null => {
  if (depth > 12) return null;
  const recurse = (value: ts.Expression, nextSource = source, isRaw = raw) => resolveNames(value, nextSource, isRaw, depth + 1);
  if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) return recurse(expression.expression);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return [raw ? (expression.text.split("=", 1)[0] ?? "") : expression.text];
  if (ts.isConditionalExpression(expression)) {
    const left = recurse(expression.whenTrue),
      right = recurse(expression.whenFalse);
    return left && right ? [...left, ...right] : null;
  }
  if (ts.isIdentifier(expression)) {
    const local = declaration(source, expression.text);
    if (local) return recurse(local);
    const imported = importedSource(source, expression.text);
    const value = imported && declaration(imported.source, imported.name);
    return value && imported ? recurse(value, imported.source) : null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    // App-PWA's service exposes its generated name; inspect the actual generator.
    if (expression.getText(source) === "service.cookieName") {
      const generator = sourceAt(`${root}packages/cloud/src/app-pwa/service.ts`);
      const value = declaration(generator, "cookieName");
      return value ? recurse(value, generator) : null;
    }
    if (!ts.isIdentifier(expression.expression)) return null;
    const imported = importedSource(source, expression.expression.text);
    const owner = imported?.source ?? source;
    let value = declaration(owner, imported?.name ?? expression.expression.text);
    if (value && ts.isAsExpression(value)) value = value.expression;
    if (!value || !ts.isObjectLiteralExpression(value)) return null;
    const field = value.properties.find(
      (property) => ts.isPropertyAssignment(property) && property.name.getText(owner) === expression.name.text,
    );
    return field && ts.isPropertyAssignment(field) ? recurse(field.initializer, owner) : null;
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    const imported = importedSource(source, expression.expression.text);
    const owner = imported?.source ?? source;
    const value = declaration(owner, imported?.name ?? expression.expression.text);
    return value && ts.isArrowFunction(value) && !ts.isBlock(value.body) ? recurse(value.body, owner) : null;
  }
  if (ts.isTemplateExpression(expression)) {
    // A raw header's name precedes '='; the value need not be evaluated.
    if (raw) {
      if (expression.head.text.includes("=")) return [expression.head.text.split("=", 1)[0] ?? ""];
      const first = expression.templateSpans[0];
      if (!expression.head.text && first?.literal.text.startsWith("=")) return recurse(first.expression, source, false);
      return null;
    }
    // This is the known App-PWA name generator; all instances share its literal prefix.
    if (source.fileName.endsWith("/cloud/src/app-pwa/service.ts") && expression.head.text === "__Secure-cloud-app-pwa-")
      return [`${expression.head.text}example-0123456789abcdef`];
  }
  return null;
};

test("every package's server cookies are resolved and explicitly classified", async () => {
  const found = new Set<string>();
  const failures: string[] = [];
  const classify = (names: string[] | null, source: ts.SourceFile, node: ts.Node) => {
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const location = `${source.fileName.slice(root.length)}:${line}`;
    if (!names?.length) {
      failures.push(`${location}: cannot resolve cookie name; add its constant or known name function to this guard`);
      return;
    }
    for (const name of names) {
      found.add(name);
      if (!isCloudCredentialCookie(name) && !nonCredentials.has(name))
        failures.push(`${location}: classify ${name} as a Cloud credential or add a non-credential reason`);
    }
  };
  for await (const path of new Glob("packages/*/src/**/*.{ts,tsx,js,jsx}").scan({ cwd: root })) {
    if (/\.(?:test|spec)\.[^.]+$/.test(path)) continue;
    const text = readFileSync(`${root}${path}`, "utf8");
    if (!/setCookie|setSignedCookie|setWebCookie|set-cookie/i.test(text)) continue;
    const source = sourceAt(`${root}${path}`);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
        if (["setCookie", "setSignedCookie"].includes(name))
          classify(node.arguments[1] ? resolveNames(node.arguments[1], source) : null, source, node);
        if (name === "setWebCookie") {
          const owner = sourceAt(`${root}packages/cloud/src/services/session/index.ts`);
          // The wrapper's leaf setCookie call is scanned too; resolve its declared literal here.
          const leaves: string[] = [];
          const leaf = (part: ts.Node): void => {
            if (ts.isCallExpression(part) && ts.isIdentifier(part.expression) && part.expression.text === "setCookie" && part.arguments[1])
              leaves.push(...(resolveNames(part.arguments[1], owner) ?? []));
            ts.forEachChild(part, leaf);
          };
          leaf(owner);
          classify(leaves.length ? leaves : null, source, node);
        }
        const first = node.arguments[0];
        if (["header", "set", "append"].includes(name) && first && ts.isStringLiteral(first) && first.text.toLowerCase() === "set-cookie") {
          classify(node.arguments[1] ? resolveNames(node.arguments[1], source, true) : null, source, node);
        }
      }
      if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.toLowerCase() === "set-cookie")
        classify(resolveNames(node.initializer, source, true), source, node);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  expect(failures).toEqual([]);
  expect(found.has("session_token")).toBe(true);
  expect(found.has("pwa_device")).toBe(true);
  expect(found.has("mail_attachment_grant")).toBe(true);
  expect(found.has("filesv2-share-access")).toBe(true);
});
