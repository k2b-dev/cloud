import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

type Violation = { file: string; line: number; message: string };

const workspaceRoot = join(import.meta.dir, "..");
const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "docs-site", "src")];

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });

const propertyName = (node: ts.PropertyName): string | null => {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
};

const objectProperty = (object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | null => {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) return property;
  }
  return null;
};

const directKeys = (object: ts.ObjectLiteralExpression): Set<string> =>
  new Set(
    object.properties.flatMap((property) => {
      if (!ts.isPropertyAssignment(property) && !ts.isMethodDeclaration(property)) return [];
      const name = propertyName(property.name);
      return name === null ? [] : [name];
    }),
  );

const violations: Violation[] = [];
let catalogCount = 0;

for (const file of sourceRoots.flatMap(sourceFiles).sort()) {
  const source = readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const report = (node: ts.Node, message: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    violations.push({ file: relative(workspaceRoot, file), line, message });
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "i18n" &&
      node.expression.name.text === "define"
    ) {
      catalogCount += 1;
      const definition = node.arguments[0];
      if (!definition || !ts.isObjectLiteralExpression(definition)) {
        report(node, "i18n.define() must use an inline object so locale completeness stays auditable.");
        ts.forEachChild(node, visit);
        return;
      }

      const baseLocale = objectProperty(definition, "baseLocale");
      const hasEnglishBase =
        baseLocale &&
        ((ts.isStringLiteral(baseLocale.initializer) && baseLocale.initializer.text === "en") ||
          (ts.isIdentifier(baseLocale.initializer) && baseLocale.initializer.text === "DEFAULT_LOCALE"));
      if (!hasEnglishBase) {
        report(definition, 'Shipped catalogs must declare the stable baseLocale "en".');
      }

      const messages = objectProperty(definition, "messages");
      if (!messages || !ts.isObjectLiteralExpression(messages.initializer)) {
        report(definition, "Shipped catalogs must declare inline EN and DE messages.");
        ts.forEachChild(node, visit);
        return;
      }

      const english = objectProperty(messages.initializer, "en");
      const german = objectProperty(messages.initializer, "de");
      if (!english || !ts.isObjectLiteralExpression(english.initializer))
        report(messages, "Catalog is missing an inline English message object.");
      if (!german || !ts.isObjectLiteralExpression(german.initializer))
        report(messages, "Catalog is missing an inline German message object.");

      if (english && german && ts.isObjectLiteralExpression(english.initializer) && ts.isObjectLiteralExpression(german.initializer)) {
        if (german.initializer.properties.some(ts.isSpreadAssignment)) {
          report(german, "German messages must not inherit English presentation through an object spread.");
        }
        const englishKeys = directKeys(english.initializer);
        const germanKeys = directKeys(german.initializer);
        for (const key of englishKeys) if (!germanKeys.has(key)) report(german, `German catalog is missing message key "${key}".`);
        for (const key of germanKeys) if (!englishKeys.has(key)) report(german, `German catalog has unknown message key "${key}".`);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

if (violations.length > 0) {
  for (const violation of violations) console.error(`${violation.file}:${violation.line}: ${violation.message}`);
  console.error(`Localization check failed with ${violations.length} violation(s) across ${catalogCount} shipped catalog(s).`);
  process.exit(1);
}

console.log(`Localization check passed for ${catalogCount} shipped EN/DE catalog(s).`);
