import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "@typescript/typescript6";
import { isTestFile, listFiles, parseSource } from "./files";
import type { Finding, Rule } from "./rule";

/**
 * The toast contract of `@k2b/ui`: a title names the outcome in one to three words, the message under it is the
 * description, and the icon comes from the tone. 32 characters is what one semibold line holds beside the icon tile in
 * the narrowest toast (a 390 px phone: about 260 px of text at 14 px). A toast may skip its title only when the whole
 * message is that short; it then takes the title's type.
 */
export const TITLE_MAX_WORDS = 3;
export const TITLE_MAX_CHARACTERS = 32;
/** The glyphs `@k2b/ui` already shows for its four tones; passing one is either redundant or the wrong tone. */
const TONE_GLYPHS = new Set(["ti-info-circle", "ti-check", "ti-alert-triangle", "ti-alert-circle"]);
const TOAST_METHODS = new Set(["success", "error"]);
const BASELINE = "scripts/checks/toast-copy.baseline";

export type ToastCopyFinding = { file: string; line: number; key: string; message: string };
/** Message texts by key, per catalogue file: `en` and `de` entries of `i18n.define` catalogues. */
export type Catalogs = Map<string, Map<string, string[]>>;

const inScope = (file: string) =>
  /^packages\/[^/]+\/src\//.test(file) &&
  /\.(?:ts|tsx)$/.test(file) &&
  !isTestFile(file) &&
  !/\.browser-(?:harness|fixture|suite)\./.test(file) &&
  !/(?:^|\/)(?:dist|__tests__|test|tests|fixtures)\//.test(file) &&
  // The component itself, which defines the contract.
  file !== "packages/ui/src/feedback/toast.ts";

/** A template's text with each placeholder as one word. */
const templateText = (node: ts.TemplateExpression): string =>
  [node.head.text, ...node.templateSpans.map((span) => `X${span.literal.text}`)].join("");

/** The literal text of a catalogue value: a string, or an arrow function that returns one. */
const literalText = (node: ts.Expression): string | null => {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return templateText(node);
  if (ts.isParenthesizedExpression(node)) return literalText(node.expression);
  if (ts.isConditionalExpression(node)) return longest([literalText(node.whenTrue), literalText(node.whenFalse)]);
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return literalText(node.body);
  return null;
};

const longest = (texts: (string | null)[]): string | null => {
  let max = "";
  for (const text of texts) {
    if (text === null) return null;
    if (text.length > max.length) max = text;
  }
  return max;
};

export const readCatalog = (file: string, source: string): Map<string, string[]> => {
  const entries = new Map<string, string[]>();
  if (!source.includes("i18n.define")) return entries;
  const { sourceFile } = parseSource(file, source);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      (node.name.text === "en" || node.name.text === "de") &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue;
        const text = literalText(property.initializer);
        if (text === null) continue;
        entries.set(property.name.text, [...(entries.get(property.name.text) ?? []), text]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entries;
};

/** Relative imports of a file, as repository paths that may hold catalogues. */
const importedFiles = (file: string, sourceFile: ts.SourceFile): string[] =>
  sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return [];
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith(".")) return [];
    const base = join(dirname(file), specifier);
    return [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base];
  });

type Text = { kind: "text"; value: string } | { kind: "dynamic" };

/**
 * What a message expression shows: a literal, a catalogue entry (`t().key`, `t().key({ … })`, `messages.key`), or both
 * branches of a condition. Anything else, such as `error.message`, is dynamic.
 */
const resolveText = (node: ts.Expression, lookup: (key: string) => string[] | null): Text[] => {
  if (ts.isParenthesizedExpression(node)) return resolveText(node.expression, lookup);
  if (ts.isConditionalExpression(node)) return [...resolveText(node.whenTrue, lookup), ...resolveText(node.whenFalse, lookup)];
  const literal = literalText(node);
  if (literal !== null) return [{ kind: "text", value: literal }];
  const access = ts.isCallExpression(node) ? node.expression : node;
  if (ts.isPropertyAccessExpression(access)) {
    const texts = lookup(access.name.text);
    if (texts?.length) return texts.map((value) => ({ kind: "text", value }));
  }
  return [{ kind: "dynamic" }];
};

const words = (text: string): number => text.trim().split(/\s+/).filter(Boolean).length;
export const isShortLabel = (text: string): boolean => words(text) <= TITLE_MAX_WORDS && text.trim().length <= TITLE_MAX_CHARACTERS;

const toastCall = (node: ts.Node): node is ts.CallExpression => {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text === "toast";
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "toast" &&
    TOAST_METHODS.has(callee.name.text)
  );
};

const option = (call: ts.CallExpression, name: string): ts.Expression | null => {
  const options = call.arguments[1];
  if (!options || !ts.isObjectLiteralExpression(options)) return null;
  for (const property of options.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name) return property.initializer;
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) return property.name;
  }
  return null;
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

export const checkToastCopySource = (file: string, source: string, catalogs: Catalogs): ToastCopyFinding[] => {
  if (!inScope(file) || !/\btoast\b/.test(source)) return [];
  const { sourceFile, findings: unparsed } = parseSource(file, source);
  const findings: ToastCopyFinding[] = unparsed.map(({ line = 1, message }) => ({
    file,
    line,
    key: `${file} | parse | ${message}`,
    message,
  }));
  const packageRoot = file.split("/").slice(0, 3).join("/");
  const imported = importedFiles(file, sourceFile).filter((path) => catalogs.has(path));
  const lookup = (key: string): string[] | null => {
    for (const path of [...imported, file]) {
      const texts = catalogs.get(path)?.get(key);
      if (texts) return texts;
    }
    const all = [...catalogs].filter(([path]) => path.startsWith(`${packageRoot}/`)).flatMap(([, entries]) => entries.get(key) ?? []);
    return all.length ? all : null;
  };
  const add = (node: ts.Node, kind: string, message: string) =>
    findings.push({
      file,
      line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
      key: `${file} | ${kind} | ${normalize(node.getText(sourceFile))}`,
      message,
    });
  const visit = (node: ts.Node): void => {
    if (toastCall(node)) {
      const message = node.arguments[0];
      const title = option(node, "title");
      const icon = option(node, "iconClass");
      if (title) {
        const long = resolveText(title, lookup).find((text) => text.kind === "text" && !isShortLabel(text.value));
        if (long?.kind === "text")
          add(
            title,
            "title",
            `Toast title “${long.value}” is longer than ${TITLE_MAX_WORDS} words or ${TITLE_MAX_CHARACTERS} characters; name the outcome and move the rest into the message.`,
          );
      } else if (message) {
        const texts = resolveText(message, lookup);
        const prose = texts.find((text) => text.kind === "dynamic" || !isShortLabel(text.value));
        if (prose)
          add(
            message,
            "untitled",
            prose.kind === "text"
              ? `Toast message “${prose.value}” has no title; give it a short title for the outcome and keep this as the description.`
              : "Toast message is not a known short label and has no title; give it a short title for the outcome.",
          );
      }
      if (icon && ts.isStringLiteralLike(icon)) {
        const glyph = icon.text.split(/\s+/).find((token) => TONE_GLYPHS.has(token));
        if (glyph) add(icon, "tone-icon", `${glyph} is a tone glyph; pick the variant instead and leave the icon to it.`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
};

export const readCatalogs = (workspaceRoot: string, files: string[]): Catalogs => {
  const catalogs: Catalogs = new Map();
  for (const file of files) {
    const entries = readCatalog(file, readFileSync(join(workspaceRoot, file), "utf8"));
    if (entries.size) catalogs.set(file, entries);
  }
  return catalogs;
};

export const collectToastCopyFindings = (workspaceRoot: string): ToastCopyFinding[] => {
  const files = listFiles(join(workspaceRoot, "packages"), /\.(?:ts|tsx)$/)
    .map((path) => relative(workspaceRoot, path))
    .filter((file) => /^packages\/[^/]+\/src\//.test(file) && !isTestFile(file))
    .sort();
  const catalogs = readCatalogs(workspaceRoot, files);
  return files.flatMap((file) => checkToastCopySource(file, readFileSync(join(workspaceRoot, file), "utf8"), catalogs));
};

const HEADER = [
  "# Toasts that do not follow the @k2b/ui toast contract yet: short title, the message as description, the icon from the tone.",
  "# One occurrence per line: <file> | <title|untitled|tone-icon> | <expression>.",
  "# The rule never adds lines; `bun scripts/check.ts toast-copy --fix` removes resolved findings. This list only shrinks.",
];
export const formatBaseline = (keys: readonly string[]): string => `${[...HEADER, ...[...keys].sort()].join("\n")}\n`;

export const rule: Rule = {
  name: "toast-copy",
  description: "Toasts use a short title, the message as description, and the icon of their tone",
  run: async ({ workspaceRoot, fix, flags }) => {
    const baselinePath = join(workspaceRoot, BASELINE);
    const lines = existsSync(baselinePath) ? readFileSync(baselinePath, "utf8").split("\n") : [];
    const remaining = new Map<string, number>();
    for (const line of lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))) {
      remaining.set(line, (remaining.get(line) ?? 0) + 1);
    }
    const known: ToastCopyFinding[] = [];
    const failures: Finding[] = [];
    for (const finding of collectToastCopyFindings(workspaceRoot)) {
      const count = remaining.get(finding.key) ?? 0;
      if (count > 0) {
        remaining.set(finding.key, count - 1);
        known.push(finding);
      } else failures.push({ file: join(workspaceRoot, finding.file), line: finding.line, message: finding.message });
    }
    const stale = [...remaining].flatMap(([key, count]) => Array<string>(count).fill(key));
    if (stale.length > 0 && fix) writeFileSync(baselinePath, formatBaseline(known.map((finding) => finding.key)));
    else
      for (const key of stale) {
        failures.push({ file: baselinePath, message: `Fixed: remove “${key}” from the baseline (bun scripts/check.ts toast-copy --fix).` });
      }
    if (known.length > 0) {
      console.warn(`warn  toast-copy: ${known.length} known finding(s) in ${BASELINE}; list them with --warnings`);
      if (flags.has("--warnings")) for (const finding of known) console.warn(`  - ${finding.file}:${finding.line} ${finding.message}`);
    }
    return failures;
  },
};
