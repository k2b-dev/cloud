import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

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

/** Every shipped `i18n.define()` catalog declares inline, key-complete EN and DE messages. */
export const rule: Rule = {
  name: "localization",
  description: "Shipped i18n catalogs declare complete inline EN/DE messages",
  run: async ({ workspaceRoot }) => {
    const sourceRoots = [join(workspaceRoot, "packages"), join(workspaceRoot, "pwas"), join(workspaceRoot, "docs-site", "src")];
    const findings: Finding[] = [];

    for (const file of sourceRoots.flatMap((root) => listFiles(root, sourceFilePattern)).sort()) {
      if (isTestFile(file)) continue;
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const report = (node: ts.Node, message: string) => {
        findings.push({ file, line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1, message });
      };

      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "i18n" &&
          node.expression.name.text === "define"
        ) {
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
          if (!hasEnglishBase) report(definition, 'Shipped catalogs must declare the stable baseLocale "en".');

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

    return findings;
  },
};
