import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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

/**
 * Application frontends whose visible text comes only from message catalogs. Hard-coded prose there
 * fails the check; single words such as product names or protocol labels ("Mail", "Cc", "UID") stay allowed.
 */
const CATALOG_ONLY_FRONTENDS = ["packages/mail/src/frontend"];
const HUMAN_TEXT_ATTRIBUTES = new Set(["alt", "aria-label", "description", "label", "placeholder", "title"]);
const FEEDBACK_CALLEES = new Set(["prompts", "toast"]);
const LOGICAL_OPERATORS = new Set([ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken]);
/** Stands in for a template substitution so `Open ${name}` still reads as a word followed by another word. */
const SUBSTITUTION = "\uFFFC";
/** Two words, or a word next to a substitution: "Save changes", "Download .eml", `Open ${name}`; `${a} ${b}` alone is not prose. */
const PROSE = /\p{L}{2,}\s+\S*(?:\p{L}{2,}|\uFFFC)|\uFFFC\s+\S*\p{L}{2,}/u;

const isCatalogDefinition = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "i18n" &&
  node.expression.name.text === "define";

/** The fixed text an expression can show: string and template literals, including every branch of `?:`, `??`, `||`, and `&&`. */
const literalTexts = (node: ts.Node | undefined): string[] => {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [[node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(SUBSTITUTION)];
  if (ts.isJsxExpression(node) || ts.isParenthesizedExpression(node)) return literalTexts(node.expression);
  if (ts.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
  if (ts.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.operatorToken.kind))
    return [...literalTexts(node.left), ...literalTexts(node.right)];
  return [];
};

const isFeedbackCall = (node: ts.CallExpression): boolean => {
  const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.expression : node.expression;
  return ts.isIdentifier(callee) && FEEDBACK_CALLEES.has(callee.text);
};

/**
 * The hard-coded prose a node shows to people: JSX text or a JSX expression child, a human-text attribute or option
 * field, or a toast or prompt message.
 */
const hardCodedProse = (node: ts.Node): string | null => {
  let texts: string[] = [];
  if (ts.isJsxText(node)) texts = [node.text];
  else if (ts.isJsxExpression(node) && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) texts = literalTexts(node);
  else if (ts.isJsxAttribute(node) && HUMAN_TEXT_ATTRIBUTES.has(node.name.getText())) texts = literalTexts(node.initializer);
  else if (ts.isPropertyAssignment(node) && HUMAN_TEXT_ATTRIBUTES.has(propertyName(node.name) ?? ""))
    texts = literalTexts(node.initializer);
  else if (ts.isCallExpression(node) && isFeedbackCall(node)) texts = literalTexts(node.arguments[0]);
  const prose = texts.map((text) => text.replace(/\s+/g, " ").trim()).find((text) => PROSE.test(text));
  return prose ? prose.replaceAll(SUBSTITUTION, "…") : null;
};

/**
 * Every shipped `i18n.define()` catalog declares inline, key-complete EN and DE messages, and catalog-only
 * frontends show no hard-coded prose.
 */
export const rule: Rule = {
  name: "localization",
  description: "Shipped i18n catalogs declare complete inline EN/DE messages; catalog-only frontends hard-code no prose",
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
      const path = relative(workspaceRoot, file).split(sep).join("/");

      const findProse = (node: ts.Node): void => {
        if (isCatalogDefinition(node)) return;
        const prose = hardCodedProse(node);
        if (prose) {
          report(
            node,
            `Hard-coded UI text "${prose.length > 60 ? `${prose.slice(0, 57)}...` : prose}"; move it into the app's message catalog.`,
          );
        }
        ts.forEachChild(node, findProse);
      };
      if (CATALOG_ONLY_FRONTENDS.some((root) => path.startsWith(`${root}/`))) findProse(sourceFile);

      const visit = (node: ts.Node): void => {
        if (isCatalogDefinition(node)) {
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
