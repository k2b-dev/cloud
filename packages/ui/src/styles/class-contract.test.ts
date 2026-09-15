/**
 * Package-wide guard for the two class-name contracts that the Cloud extraction
 * broke silently and repeatedly.
 *
 * 1. `styles/entry.css` imports the package-owned source sheets. Those sources
 *    may `@reference "tailwindcss"` for compile-time symbols, but never import
 *    Tailwind's generated utilities, so the built stylesheet contains no generic
 *    utilities. A Cloud utility left in component markup (`flex`, `gap-2`,
 *    `text-zinc-600`, …) therefore styles nothing for a standalone consumer.
 *    This is exactly how the whole `src/content` group shipped structurally unstyled.
 * 2. The package may only own `k2b-`-prefixed class names inside the `.k2b-ui`
 *    scope. An unprefixed name (`.input`, `.paper`, `.segmented-control`, …)
 *    silently restyles a consumer's own markup.
 *
 * The check is static on purpose: it covers every component, including ones no
 * render test instantiates, and it needs no props. It resolves local variables,
 * accessors, arrays, conditionals and template expressions used by `class`
 * attributes, so dynamically composed package classes remain visible.
 *
 * Requires the built stylesheet — `bun run build` (the package `test` script
 * does that first).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";

const packageRoot = resolve(import.meta.dir, "../..");
const stylesPath = resolve(packageRoot, "dist/styles.css");
if (!existsSync(stylesPath)) throw new Error("dist/styles.css is missing — run `bun run build` before this test");
const styles = readFileSync(stylesPath, "utf8");

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
  });

const sources = walk(resolve(packageRoot, "src"));

/**
 * Class families the package renders but does not own the names of.
 * `ti`/`ti-*` come from the optional Tabler preset; `cd-*` are emitted by the
 * package's own code highlighter; `md-*` and `stdlib-chart-*` are emitted by
 * `@k2b/stdlib` and cannot be renamed without forking it.
 */
const isForeignContract = (token: string) =>
  token === "ti" || token.startsWith("ti-") || token.startsWith("cd-") || token.startsWith("md-") || token.startsWith("stdlib-");

/** Marker classes: CopyButton uses its base styles; Navigation styles its lists and rows. */
const HOOK_CLASSES = new Set(["k2b-copy-button", "k2b-navigation"]);

/**
 * `is-*` / `has-*` state modifiers are the package's own convention and are
 * always written compound with a `k2b-` class (`.k2b-pagination__page.is-current`),
 * so they cannot reach unrelated consumer markup on their own.
 */
const isStateModifier = (token: string) => /^(?:is|has)-[\w-]+$/.test(token);

const literalClassTokens = (source: string): string[] => {
  const sourceFile = ts.createSourceFile("component.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  type Definition = { node: ts.Node; scope: ts.Node };
  const definitions = new Map<string, Definition[]>();
  const lexicalScope = (node: ts.Node): ts.Node => {
    let current = node.parent;
    while (current && !ts.isBlock(current) && !ts.isSourceFile(current) && !ts.isFunctionLike(current)) {
      current = current.parent;
    }
    return current ?? sourceFile;
  };
  const rememberDefinitions = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      definitions.set(node.name.text, [...(definitions.get(node.name.text) ?? []), { node: node.initializer, scope: lexicalScope(node) }]);
    } else if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      definitions.set(node.name.text, [...(definitions.get(node.name.text) ?? []), { node: node.body, scope: lexicalScope(node) }]);
    }
    ts.forEachChild(node, rememberDefinitions);
  };
  rememberDefinitions(sourceFile);
  const definitionFor = (identifier: ts.Identifier): ts.Node | undefined => {
    const scopes: ts.Node[] = [];
    let current: ts.Node | undefined = identifier;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isFunctionLike(current)) scopes.push(current);
      current = current.parent;
    }
    return (definitions.get(identifier.text) ?? [])
      .filter((definition) => scopes.includes(definition.scope))
      .sort((left, right) => {
        const scopeDistance = scopes.indexOf(left.scope) - scopes.indexOf(right.scope);
        return scopeDistance || right.node.getStart(sourceFile) - left.node.getStart(sourceFile);
      })[0]?.node;
  };

  const tokens = new Set<string>();
  const addText = (value: string) => {
    for (const token of value.split(/\s+/)) if (token) tokens.add(token);
  };
  const seen = new Set<ts.Node>();
  const collectReturns = (body: ts.Block) => {
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) collect(node.expression);
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(body, visit);
  };
  const collect = (node: ts.Node | undefined): void => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    if (ts.isStringLiteralLike(node)) {
      addText(node.text);
    } else if (ts.isTemplateExpression(node)) {
      addText(node.head.text);
      for (const span of node.templateSpans) {
        collect(span.expression);
        addText(span.literal.text);
      }
    } else if (ts.isIdentifier(node)) {
      collect(definitionFor(node));
    } else if (ts.isConditionalExpression(node)) {
      collect(node.whenTrue);
      collect(node.whenFalse);
    } else if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) collect(node.right);
      else if (
        node.operatorToken.kind === ts.SyntaxKind.PlusToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      ) {
        collect(node.left);
        collect(node.right);
      }
    } else if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) collect(element);
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      collect(node.expression);
      for (const argument of node.arguments ?? []) collect(argument);
    } else if (ts.isPropertyAccessExpression(node)) {
      if (["concat", "filter", "flat", "join", "map"].includes(node.name.text)) collect(node.expression);
    } else if (ts.isElementAccessExpression(node)) {
      // A consumer-owned lookup (for example `styles[props.tone]`) cannot be
      // resolved statically without treating unrelated lookup keys as classes.
      // Render suites cover those external values.
    } else if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      if (ts.isBlock(node.body)) collectReturns(node.body);
      else collect(node.body);
    } else if (ts.isBlock(node)) {
      collectReturns(node);
    } else if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      collect(node.expression);
    }
  };

  const visitClasses = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && (node.name.text === "class" || node.name.text === "className")) {
      if (node.initializer && ts.isStringLiteral(node.initializer)) addText(node.initializer.text);
      else if (node.initializer && ts.isJsxExpression(node.initializer)) collect(node.initializer.expression);
    }
    ts.forEachChild(node, visitClasses);
  };
  visitClasses(sourceFile);
  return [...tokens];
};

const dynamicClassEvidence = new Map(
  [
    ["content/Pagination.tsx", "k2b-pagination__page--wide-only"],
    ["content/StructuredDataPreview.tsx", "k2b-content-structured-data"],
    ["surfaces/Avatar.tsx", "k2b-avatar"],
  ].map(([file, token]) => [resolve(packageRoot, "src", file!), token!]),
);

describe("@k2b/ui class extraction coverage", () => {
  test("sees package classes composed through local expressions", () => {
    for (const [file, token] of dynamicClassEvidence) {
      expect(literalClassTokens(readFileSync(file, "utf8")), relative(packageRoot, file)).toContain(token);
    }
  });

  test("resolves representative conditionals, arrays, accessors and templates", () => {
    const source = `
      const accessor = () => \`k2b-root \${active ? "is-active" : ""}\`;
      const joined = ["k2b-array", enabled && "has-value"].filter(Boolean).join(" ");
      <><div class={accessor()} /><div class={joined} /><div class={wide ? "" : "k2b-wide"} /></>;
    `;
    expect(literalClassTokens(source).sort()).toEqual(["has-value", "is-active", "k2b-array", "k2b-root", "k2b-wide"].sort());
  });
});

const hasRule = (token: string) => new RegExp(`\\.${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(styles);

describe("@k2b/ui package class contract", () => {
  test("renders no class the shipped stylesheet cannot style", () => {
    const unstyled = sources.flatMap((file) =>
      literalClassTokens(readFileSync(file, "utf8"))
        .filter((token) => !isForeignContract(token) && !HOOK_CLASSES.has(token) && !hasRule(token))
        .map((token) => `${relative(packageRoot, file)}: ${token}`),
    );

    expect(unstyled).toEqual([]);
  });

  test("renders only package-owned or externally-contracted class names", () => {
    const foreign = sources.flatMap((file) =>
      literalClassTokens(readFileSync(file, "utf8"))
        .filter((token) => !token.startsWith("k2b-") && !isForeignContract(token) && !isStateModifier(token))
        .map((token) => `${relative(packageRoot, file)}: ${token}`),
    );

    expect(foreign).toEqual([]);
  });

  test("claims no unprefixed class name inside the package scope", () => {
    const stylesDir = resolve(packageRoot, "src/styles");
    const owned = new Set<string>();

    for (const file of readdirSync(stylesDir).filter((name) => name.endsWith(".css") && name !== "entry.css")) {
      const css = readFileSync(join(stylesDir, file), "utf8");
      for (const rule of css.matchAll(/([^{}]+)\{/g)) {
        const selector = rule[1]!.replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (!selector || selector.startsWith("@")) continue;

        for (const part of selector.split(",").map((entry) => entry.trim())) {
          // Only the compound that a rule actually targets matters: a selector
          // headed by a `k2b-` ancestor cannot reach unrelated consumer markup.
          for (const compound of part.split(/\s+|>|~|\+/).filter(Boolean)) {
            const classes = [...compound.matchAll(/\.([\w-]+)/g)].map((match) => match[1]!);
            const unprefixed = classes.filter((name) => name !== "k2b-ui" && name !== "dark" && !name.startsWith("k2b-"));
            if (!unprefixed.length) continue;
            if (classes.some((name) => name.startsWith("k2b-") && name !== "k2b-ui")) continue;
            for (const name of unprefixed) if (!isForeignContract(name)) owned.add(`${file}: .${name}`);
          }
        }
      }
    }

    expect([...owned].sort()).toEqual([]);
  });
});
