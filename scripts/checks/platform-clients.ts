import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";


const delivered = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "VALKEY_URL",
  "NATS_SERVERS",
  "SYNC_NAMESPACE",
  "SYNC_REPLICAS",
  "NATS_CREDS_FILE",
  "NATS_TLS_CA_FILE",
  "NATS_IGNORE_CLUSTER_UPDATES",
  "APP_SECRET",
]);
// Test targets and native mock objects intentionally need constructors and env.
// Client value imports still go through the platform in these files.
const fixtureFiles = new Set(["packages/cloud/scripts/platform-start.test-fixture.ts", "scripts/scale-acceptance.ts"]);
const fixture = (file: string) =>
  /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
  /^(?:scripts\/fixtures\/|tests\/|packages\/[^/]+\/(?:test|bench)\/)/.test(file) ||
  fixtureFiles.has(file);
const resolver = "packages/cloud/src/runtime/resolve-connections.ts";
// These operator tools consume only HTTP or NATS; starting database/cache clients
// would add unrelated infrastructure prerequisites. No native clients are allowed.
const connectionOnlyTools = new Map([
  ["scripts/prod-upgrade-preflight.ts", new Set(["SYNC_NAMESPACE"])],
  ["packages/cloud/scripts/sync-recovery-smoke.ts", new Set(["NATS_SERVERS", "SYNC_REPLICAS"])],
]);

export const checkSource = (file: string, source: string): Finding[] => {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: Finding[] = [];
  const namespaces = new Set(["Bun"]);
  const constructors = new Set(["SQL", "RedisClient"]);
  const importedConstructors = new Set<string>();
  const sqlConstructors = new Set<string>();
  const environments = new Set(["env"]);
  const report = (node: ts.Node, message: string) =>
    findings.push({ file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, message });
  const clientMessage = "import sql/redis from @k2b/cloud (Cloud internals use runtime/clients); Bun globals bypass platform start";
  const poolMessage = "use createSql(options) / createRedis(options) from @k2b/cloud; preserve owned pool limits and lifecycle";
  const envMessage = "read delivered connection values through connections() from @k2b/cloud, not env";
  for (const node of ast.statements) {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    const clause = node.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const names = clause.namedBindings;
    if (node.moduleSpecifier.text === "bun") {
      if (clause.name) namespaces.add(clause.name.text);
      if (names && ts.isNamespaceImport(names)) namespaces.add(names.name.text);
      if (names && ts.isNamedImports(names))
        for (const item of names.elements) {
          if (item.isTypeOnly) continue;
          const name = item.propertyName?.text ?? item.name.text;
          if (name === "sql" || name === "redis") report(item, clientMessage);
          if (name === "SQL" || name === "RedisClient") {
            constructors.add(item.name.text);
            importedConstructors.add(item.name.text);
            if (name === "SQL") sqlConstructors.add(item.name.text);
          }
        }
    }
    if (names && ts.isNamedImports(names))
      for (const item of names.elements) if ((item.propertyName?.text ?? item.name.text) === "env") environments.add(item.name.text);
  }
  const staticKey = (node: ts.Node): string | undefined => {
    if (ts.isComputedPropertyName(node)) return staticKey(node.expression);
    if (ts.isParenthesizedExpression(node)) return staticKey(node.expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  };
  const bindingKey = (node: ts.BindingElement) => {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) ? key.text : staticKey(key);
  };
  const member = (node: ts.Node): { object: ts.Expression; name: string } | undefined => {
    if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
    if (ts.isElementAccessExpression(node)) {
      const name = staticKey(node.argumentExpression);
      if (name !== undefined) return { object: node.expression, name };
    }
  };
  const isEnv = (node: ts.Expression): boolean => {
    if (ts.isIdentifier(node)) return environments.has(node.text);
    const property = member(node);
    return !!property && property.name === "env" && ts.isIdentifier(property.object) && ["process", "Bun"].includes(property.object.text);
  };
  const isWrite = (node: ts.Node) =>
    ts.isDeleteExpression(node.parent) ||
    (ts.isBinaryExpression(node.parent) && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
  const isBun = (node: ts.Expression): boolean => {
    if (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) return isBun(node.expression);
    if (ts.isIdentifier(node)) return namespaces.has(node.text);
    const property = member(node);
    if (property && property.name === "Bun" && ts.isIdentifier(property.object) && property.object.text === "globalThis") return true;
    return (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === "bun"
    );
  };
  // Only track direct module assignments; this remains a syntactic regression guard.
  const collectAliases = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isBun(node.initializer))
      namespaces.add(node.name.text);
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      isBun(node.right)
    )
      namespaces.add(node.left.text);
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(ast);
  const isTypeUse = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      // A class extends expression executes; interface extends and implements do not.
      if (
        ts.isExpressionWithTypeArguments(parent) &&
        ts.isHeritageClause(parent.parent) &&
        parent.parent.token === ts.SyntaxKind.ExtendsKeyword &&
        (ts.isClassDeclaration(parent.parent.parent) || ts.isClassExpression(parent.parent.parent))
      )
        continue;
      if (ts.isTypeNode(parent)) return true;
      if (ts.isStatement(parent)) break;
    }
    return false;
  };
  const isConstructorValue = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    if (isTypeUse(node) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)) return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (
      ts.isPropertyAccessExpression(parent) &&
      parent.expression === node &&
      sqlConstructors.has(node.text) &&
      parent.name.text === "PostgresError"
    )
      return false;
    if (ts.isExportSpecifier(parent))
      return node === (parent.propertyName ?? parent.name) && !parent.isTypeOnly && !parent.parent.parent.isTypeOnly;
    return ts.isShorthandPropertyAssignment(parent) || !("name" in parent && parent.name === node);
  };
  const nativeAllowed = fixture(file) || file.startsWith("packages/cloud/src/runtime/");
  const envAllowed = (key: string) => fixture(file) || file === resolver || connectionOnlyTools.get(file)?.has(key);
  const visit = (node: ts.Node) => {
    const property = member(node);
    if (property && isBun(property.object) && ["sql", "redis"].includes(property.name)) report(node, clientMessage);
    if (!nativeAllowed && property && isBun(property.object) && ["SQL", "RedisClient"].includes(property.name) && !isTypeUse(node))
      report(node, poolMessage);
    if (
      !nativeAllowed &&
      ts.isIdentifier(node) &&
      importedConstructors.has(node.text) &&
      isConstructorValue(node) &&
      !(ts.isNewExpression(node.parent) && node.parent.expression === node)
    )
      report(node, poolMessage);
    if (ts.isNewExpression(node) && !nativeAllowed) {
      const expression = node.expression;
      if (ts.isIdentifier(expression) && constructors.has(expression.text)) report(node, poolMessage);
    }
    if (property && !envAllowed(property.name) && delivered.has(property.name) && isEnv(property.object) && !isWrite(node))
      report(node, envMessage);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectBindingPattern(node.name)) {
      if (isEnv(node.initializer))
        for (const item of node.name.elements) {
          const name = bindingKey(item);
          if (name && delivered.has(name) && !envAllowed(name)) report(item, envMessage);
        }
      if (isBun(node.initializer))
        for (const item of node.name.elements) {
          const name = bindingKey(item);
          if (name && ["sql", "redis"].includes(name)) report(item, clientMessage);
          if (!nativeAllowed && name && ["SQL", "RedisClient"].includes(name)) report(item, poolMessage);
        }
    }
    if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === "bun" &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    )
      for (const item of node.exportClause.elements) {
        if (item.isTypeOnly) continue;
        const name = item.propertyName?.text ?? item.name.text;
        if (["sql", "redis"].includes(name)) report(item, clientMessage);
        if (!nativeAllowed && ["SQL", "RedisClient"].includes(name)) report(item, poolMessage);
      }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return findings;
};

export const rule: Rule = {
  name: "platform-clients",
  description: "database/cache clients and delivered connections belong to the platform startup snapshot",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    // pwas/* are standalone services outside a Cloud installation. They own their
    // connections; platform start would add Valkey as an unrelated prerequisite.
    for (const file of ["packages", "scripts", "tests", "docs-site/examples"]
      .flatMap((root) => listFiles(join(workspaceRoot, root), sourceFilePattern))
      .sort()) {
      const path = relative(workspaceRoot, file).replaceAll("\\", "/");
      findings.push(...checkSource(path, readFileSync(file, "utf8")).map((finding) => ({ ...finding, file })));
    }
    return findings;
  },
};
