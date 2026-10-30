import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "../checks/files";

type Edit = { start: number; end: number; text: string };
const testSource = /(?:\.(?:test|spec|test-fixture)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|fixtures|bench)\/)/;

/** Rewrite one source file without reprinting its unrelated syntax or comments. */
export const migrateSource = (source: string, file: string, migratePools = !testSource.test(file)) => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const edits: Edit[] = [];
  const add = (node: ts.Node, text: string) => {
    const edit = { start: node.getStart(ast), end: node.end, text };
    edits.push(edit);
    return edit;
  };
  let replacedImport: Edit | undefined;
  const module =
    file.startsWith("packages/cloud/") && !file.startsWith("packages/cloud/examples/")
      ? (() => {
          const path = relative(dirname(file), "packages/cloud/src/runtime/clients").replaceAll("\\", "/");
          return path.startsWith(".") ? path : `./${path}`;
        })()
      : "@k2b/cloud";
  const imports: string[] = [];
  const bindings = new Map<string, string>();
  const namespaces = new Set(["Bun"]);
  const constructors = new Map<string, "SQL" | "RedisClient">();
  let pools = 0;
  const identifiers = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== module) continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    for (const item of clause.namedBindings.elements)
      if (!item.isTypeOnly) bindings.set(item.propertyName?.text ?? item.name.text, item.name.text);
  }
  const binding = (name: string) => {
    const existing = bindings.get(name);
    if (existing) return existing;
    let local = name;
    while (identifiers.has(local)) local = `platform${local[0]!.toUpperCase()}${local.slice(1)}`;
    identifiers.add(local);
    bindings.set(name, local);
    imports.push(local === name ? name : `${name} as ${local}`);
    return local;
  };
  // Establish local Bun names before visiting their uses.
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "bun") continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) continue;
    if (clause.name) namespaces.add(clause.name.text);
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text);
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const item of clause.namedBindings.elements) {
        const name = item.propertyName?.text ?? item.name.text;
        if (!item.isTypeOnly && (name === "SQL" || name === "RedisClient")) constructors.set(item.name.text, name);
        if (!item.isTypeOnly && (name === "sql" || name === "redis") && !bindings.has(name)) bindings.set(name, item.name.text);
      }
    }
  }
  const convertedConstructors = new Set<string>();
  const remainingValues = new Set<string>();
  const inType = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isTypeNode(parent)) return true;
      if (ts.isStatement(parent)) return false;
    }
    return false;
  };
  const rendered = (node: ts.Node): string => {
    let text = node.getText(ast);
    const start = node.getStart(ast);
    for (const edit of edits.filter((edit) => edit.start >= start && edit.end <= node.end).sort((a, b) => b.start - a.start))
      text = text.slice(0, edit.start - start) + edit.text + text.slice(edit.end - start);
    return text;
  };
  const replacePool = (node: ts.NewExpression, text: string) => {
    for (let index = edits.length - 1; index >= 0; index--)
      if (edits[index]!.start >= node.getStart(ast) && edits[index]!.end <= node.end) edits.splice(index, 1);
    add(node, text);
    pools++;
  };
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && migratePools) {
      const expression = node.expression;
      const kind = ts.isIdentifier(expression)
        ? constructors.get(expression.text)
        : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && namespaces.has(expression.expression.text)
          ? expression.name.text
          : undefined;
      if (kind === "SQL") {
        const args = node.arguments ?? [];
        for (const arg of args) visit(arg);
        const first = args[0];
        let options = first ? rendered(first) : "";
        if (first && !ts.isObjectLiteralExpression(first))
          options = `{ ${args[1] ? `...(${rendered(args[1])}), ` : ""}url: ${rendered(first)} }`;
        replacePool(node, `${binding("createSql")}(${options})`);
        if (ts.isIdentifier(expression)) convertedConstructors.add(expression.text);
        return;
      }
      if (kind === "RedisClient") {
        const args = node.arguments ?? [];
        const url = args[0]?.getText(ast);
        // Only the installation URL has the same meaning through createRedis.
        // Explicit alternate targets are reviewed by the owner, never discarded.
        if (!url || /^(?:env\.(?:REDIS_URL|VALKEY_URL)|connections\(\)\.valkey\.url)$/.test(url)) {
          for (const arg of args) visit(arg);
          replacePool(node, `${binding("createRedis")}(${args[1] ? rendered(args[1]) : ""})`);
          if (ts.isIdentifier(expression)) convertedConstructors.add(expression.text);
          return;
        }
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      if (node.name.text === "sql" || node.name.text === "redis") {
        add(node, binding(node.name.text));
        return;
      }
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
      const key = node.argumentExpression;
      if (ts.isStringLiteral(key) && (key.text === "sql" || key.text === "redis")) {
        add(node, binding(key.text));
        return;
      }
    }
    if (ts.isIdentifier(node) && constructors.has(node.text) && !inType(node) && !ts.isImportSpecifier(node.parent))
      remainingValues.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "bun") continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;
    const kept: string[] = [];
    let changed = false;
    for (const item of clause.namedBindings.elements) {
      const name = item.propertyName?.text ?? item.name.text;
      if (!item.isTypeOnly && (name === "sql" || name === "redis")) {
        const local = item.name.text;
        imports.push(local === name ? name : `${name} as ${local}`);
        changed = true;
      } else if (convertedConstructors.has(item.name.text) && !remainingValues.has(item.name.text)) {
        kept.push(`type ${item.getText(ast)}`);
        changed = true;
      } else kept.push(item.getText(ast));
    }
    if (changed) {
      const edit = add(
        node,
        kept.length
          ? `import ${clause.name ? `${clause.name.text}, ` : ""}{ ${kept.join(", ")} } from "bun";`
          : clause.name
            ? `import ${clause.name.text} from "bun";`
            : "",
      );
      if (!kept.length && !clause.name) replacedImport ??= edit;
    }
  }
  for (const node of ast.statements) {
    if (
      !ts.isExportDeclaration(node) ||
      node.isTypeOnly ||
      !node.moduleSpecifier ||
      !ts.isStringLiteral(node.moduleSpecifier) ||
      node.moduleSpecifier.text !== "bun" ||
      !node.exportClause ||
      !ts.isNamedExports(node.exportClause)
    )
      continue;
    const moved = node.exportClause.elements.filter(
      (item) => !item.isTypeOnly && ["sql", "redis"].includes(item.propertyName?.text ?? item.name.text),
    );
    if (!moved.length) continue;
    const kept = node.exportClause.elements.filter((item) => !moved.includes(item));
    add(
      node,
      `${kept.length ? `export { ${kept.map((item) => item.getText(ast)).join(", ")} } from "bun";\n` : ""}export { ${moved.map((item) => item.getText(ast)).join(", ")} } from ${JSON.stringify(module)};`,
    );
  }
  const platformImport = imports.length ? `import { ${[...new Set(imports)].join(", ")} } from ${JSON.stringify(module)};` : undefined;
  if (platformImport && replacedImport) replacedImport.text = platformImport;
  for (const edit of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  if (platformImport && !replacedImport) {
    const updated = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const existingImports = updated.statements.filter(ts.isImportDeclaration);
    const lastImport = existingImports.at(-1);
    const first = updated.statements[0];
    const declarationDoc =
      first && !ast.statements.some(ts.isImportDeclaration) ? ts.getJSDocCommentsAndTags(first).find(ts.isJSDoc) : undefined;
    const trailing = lastImport ? ts.getTrailingCommentRanges(source, lastImport.end)?.at(-1) : undefined;
    const offset = trailing?.end ?? lastImport?.end ?? declarationDoc?.getStart(updated) ?? first?.getStart(updated) ?? source.length;
    source = source.slice(0, offset) + `${offset && source[offset - 1] !== "\n" ? "\n" : ""}${platformImport}\n` + source.slice(offset);
  }
  return { source, pools };
};

export const migratePackage = (workspaceRoot: string, packagePath: string, dryRun = false) => {
  const root = realpathSync(workspaceRoot);
  const target = realpathSync(resolve(root, packagePath));
  const name = relative(resolve(root, "packages"), target);
  if (name.startsWith(".") || isAbsolute(name) || name.includes("/") || !name || !Bun.file(resolve(target, "package.json")).size)
    throw new Error("Expected exactly one package directory under packages/");
  let files = 0,
    pools = 0;
  for (const file of listFiles(target, sourceFilePattern)) {
    const actual = realpathSync(file);
    const inside = relative(target, actual);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`Refusing file outside selected package: ${file}`);
    const path = relative(root, actual).replaceAll("\\", "/");
    if (path.startsWith("packages/cloud/src/runtime/")) continue;
    const original = readFileSync(file, "utf8");
    const result = migrateSource(original, path);
    if (result.source === original) continue;
    if (!dryRun) writeFileSync(file, result.source);
    files++;
    pools += result.pools;
  }
  return { package: name, files, pools, dryRun };
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(
      "Usage: bun scripts/codemods/platform-clients.ts packages/<package> [--dry-run]\nMigrates Bun sql/redis values and owned SQL pools in exactly one package. Review explicit Redis URLs, test constructor spies, and standalone/subprocess startup manually. Native constructors in tests/fixtures remain test-owned. Idempotent; symlinks cannot escape the selected package.",
    );
  } else {
    const paths = args.filter((arg) => !arg.startsWith("--"));
    if (paths.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--dry-run")) throw new Error("Use --help for usage");
    console.log(JSON.stringify(migratePackage(resolve(import.meta.dir, "../.."), paths[0]!, args.includes("--dry-run"))));
  }
}
