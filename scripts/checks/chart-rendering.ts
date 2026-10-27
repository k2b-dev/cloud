import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { charts } from "@k2b/stdlib";
import ts from "@typescript/typescript6";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const RENDERERS = new Set(["charts", ...Object.keys(charts)]);
const CHART_COMPONENTS = new Set(["Chart", "ChartExplorer", "ChartSnapshotView", "StatCell"]);
const LIBRARIES = new Set(["ui", "cloud", "ssr"]);
/** The browser entries @k2b/ssr discovers (`**\/*.{island,client}.tsx`). */
const BROWSER_ENTRY = /\.(?:island|client)\.tsx$/;
const ALLOWED_RENDERERS = new Map([
  ["packages/ui/src/content/Chart.tsx", "The shared Chart wrapper renders with inspect: true and attaches createChartInspection."],
  [
    "packages/ui/src/content/chart-bar.ts",
    "The shared bar renderer behind Chart; Chart calls it with inspect: true and attaches createChartInspection.",
  ],
  [
    "packages/assistant/src/artifacts/runtime/lib.ts",
    "Studio cloud.chart() runs in a sandbox whose frame prelude enhances SVG with inspectChart.",
  ],
  ["packages/cloud/src/ai/chart-block.ts", "Reads SVG marks for validation and tables; the SVG never reaches the DOM."],
]);

const skipped = (file: string): boolean =>
  isTestFile(file) || /\.browser-(?:harness|fixture|suite)\.tsx?$/.test(file) || /^packages\/[^/]+\/fixture\//.test(file);

const moduleName = (node: ts.Expression | undefined): string | undefined => (node && ts.isStringLiteral(node) ? node.text : undefined);

const valueImport = (clause: ts.ImportClause | undefined): boolean => {
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name || !clause.namedBindings || ts.isNamespaceImport(clause.namedBindings)) return true;
  return clause.namedBindings.elements.length === 0 || clause.namedBindings.elements.some((element) => !element.isTypeOnly);
};

const valueExport = (node: ts.ExportDeclaration): boolean =>
  !node.isTypeOnly &&
  (!node.exportClause ||
    !ts.isNamedExports(node.exportClause) ||
    node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly));

const unwrap = (node: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(node) || ts.isAwaitExpression(node)) node = node.expression;
  return node;
};

const dynamicModule = (node: ts.Node): string | undefined =>
  ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? moduleName(node.arguments[0]) : undefined;

const propertyName = (node: ts.Node): string | undefined => (ts.isIdentifier(node) || ts.isStringLiteral(node) ? node.text : undefined);

const rawRenderers = (source: ts.SourceFile, report: (node: ts.Node, name: string) => void): void => {
  const namespaces = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && moduleName(node.moduleSpecifier) === "@k2b/stdlib" && !node.importClause?.isTypeOnly) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && RENDERERS.has(name)) report(element, name);
        }
      }
    }
    if (ts.isExportDeclaration(node) && moduleName(node.moduleSpecifier) === "@k2b/stdlib" && !node.isTypeOnly) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          if (!element.isTypeOnly && RENDERERS.has(name)) report(element, name);
        }
      } else report(node, "charts");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (dynamicModule(unwrap(node.initializer)) === "@k2b/stdlib") namespaces.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const isNamespace = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    return (ts.isIdentifier(node) && namespaces.has(node.text)) || dynamicModule(node) === "@k2b/stdlib";
  };
  const destructured = (pattern: ts.BindingName): void => {
    if (!ts.isObjectBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      const name = propertyName(element.propertyName ?? element.name);
      if (!element.dotDotDotToken && name && RENDERERS.has(name)) report(element, name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression) && RENDERERS.has(node.name.text)) {
      report(node, node.name.text);
    }
    if (ts.isElementAccessExpression(node) && isNamespace(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (RENDERERS.has(name)) report(node, name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isNamespace(node.initializer)) destructured(node.name);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then" &&
      dynamicModule(unwrap(node.expression.expression)) === "@k2b/stdlib"
    ) {
      const callback = node.arguments[0];
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters[0]) {
        destructured(callback.parameters[0].name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

/**
 * `named` marks an import that can reach more than a module's default export.
 * @k2b/ssr wraps only the default import of an island or client module in its
 * browser entry; a named import renders on the server only.
 */
type ModuleImport = { specifier: string; named: boolean };
type ChartModule = { imports: ModuleImport[]; chart?: { line: number; tag: string } };

const importsNamed = (clause: ts.ImportClause | undefined): boolean => {
  const bindings = clause?.namedBindings;
  if (!bindings) return false;
  return ts.isNamespaceImport(bindings) || bindings.elements.some((element) => !element.isTypeOnly);
};

const chartModule = (source: ts.SourceFile): ChartModule => {
  const components = new Map<string, string>();
  const namespaces = new Set<string>();
  const result: ChartModule = { imports: [] };
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) || moduleName(node.moduleSpecifier) !== "@k2b/ui" || node.importClause?.isTypeOnly) continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && CHART_COMPONENTS.has(name)) components.set(element.name.text, name);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && valueImport(node.importClause)) {
      const specifier = moduleName(node.moduleSpecifier);
      if (specifier) result.imports.push({ specifier, named: importsNamed(node.importClause) });
    }
    if (ts.isExportDeclaration(node) && valueExport(node)) {
      const specifier = moduleName(node.moduleSpecifier);
      if (specifier) result.imports.push({ specifier, named: true });
    }
    const dynamic = dynamicModule(node);
    if (dynamic) result.imports.push({ specifier: dynamic, named: true });
    if (!result.chart && (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))) {
      const tag = node.tagName;
      const name = ts.isIdentifier(tag)
        ? components.get(tag.text)
        : ts.isPropertyAccessExpression(tag) && ts.isIdentifier(tag.expression) && namespaces.has(tag.expression.text)
          ? tag.name.text
          : undefined;
      if (
        name &&
        CHART_COMPONENTS.has(name) &&
        (name !== "StatCell" || node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "trend"))
      ) {
        result.chart = { line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, tag: tag.getText(source) };
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
};

const resolveModule = (file: string, specifier: string, src: string, texts: Map<string, string>): string | undefined => {
  const relativeSpecifier = specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  if (!relativeSpecifier && !specifier.startsWith("@/")) return;
  const target = resolve(
    specifier.startsWith("@/") ? src : dirname(file),
    specifier.startsWith("@/") ? specifier.slice(2) : specifier,
  ).replace(/\.jsx?$/, "");
  if (!target.startsWith(`${src}${sep}`)) return;
  return [target, `${target}.ts`, `${target}.tsx`, join(target, "index.ts"), join(target, "index.tsx")].find((path) => texts.has(path));
};

// Without parent links and JSDoc the parse takes about half as long; every
// `getText` call therefore passes its source file.
const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, { languageVersion: ts.ScriptTarget.Latest, jsDocParsingMode: ts.JSDocParsingMode.ParseNone }, false);

/**
 * Parsing every module of every app is most of the cost, so the graph is
 * built upward from chart modules only. A module can import `Panel.tsx` only
 * through a specifier that contains `Panel`; an `index` module can be imported
 * through its directory name or `.`, so its importers are searched in full.
 */
const hydration = (texts: Map<string, string>, src: string, module: (file: string) => ChartModule) => {
  const importerCache = new Map<string, { file: string; named: boolean }[]>();
  const importers = (target: string): { file: string; named: boolean }[] => {
    const cached = importerCache.get(target);
    if (cached) return cached;
    const stem = basename(target).replace(/\.tsx?$/, "");
    const found: { file: string; named: boolean }[] = [];
    for (const [file, text] of texts) {
      if (file === target || (stem !== "index" && !text.includes(stem))) continue;
      const edges = module(file).imports.filter(({ specifier }) => resolveModule(file, specifier, src, texts) === target);
      if (edges.length > 0) found.push({ file, named: edges.some((edge) => edge.named) });
    }
    importerCache.set(target, found);
    return found;
  };
  // Island and client entries are hydrated through their default export, so
  // only importers of their other exports must be hydrated themselves.
  const relevantImporters = (target: string): string[] => {
    const entry = BROWSER_ENTRY.test(target);
    return importers(target)
      .filter((edge) => !entry || edge.named)
      .map((edge) => edge.file);
  };
  const memo = new Map<string, boolean>();
  const isHydrated = (file: string): boolean => {
    const visiting = new Set<string>();
    const visit = (path: string): boolean => {
      const cached = memo.get(path);
      if (cached !== undefined) return cached;
      if (visiting.has(path)) return true;
      visiting.add(path);
      const parents = relevantImporters(path);
      const hydrated = BROWSER_ENTRY.test(path) ? parents.every(visit) : parents.length > 0 && parents.every(visit);
      if (!hydrated) memo.set(path, false);
      return hydrated;
    };
    const hydrated = visit(file);
    // Cache a successful cycle only after checking all its incoming paths;
    // an in-progress success could still lead to a server-only importer.
    if (hydrated) for (const path of visiting) memo.set(path, true);
    return hydrated;
  };
  /** After `isHydrated(file)` returned false: the direct importers known to run on the server only. */
  const serverImporters = (file: string): string[] => relevantImporters(file).filter((path) => memo.get(path) === false);
  return { isHydrated, serverImporters };
};

// Cheap text filters that skip parsing; the AST decides every finding.
const mayRenderChart = (text: string): boolean =>
  text.includes("@k2b/ui") && /\b(?:Chart|ChartExplorer|ChartSnapshotView|StatCell)\b/.test(text);

export const rule: Rule = {
  name: "chart-rendering",
  description: "charts use shared inspection and render inside islands",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const apps = new Map(
      packageIds(workspaceRoot)
        .filter((id) => !LIBRARIES.has(id))
        .map((id) => [id, new Map<string, string>()]),
    );
    const files = [
      ...listFiles(join(workspaceRoot, "packages"), sourceFilePattern),
      ...listFiles(join(workspaceRoot, "docs-site/src"), sourceFilePattern),
    ].sort();
    for (const file of files) {
      const path = relative(workspaceRoot, file).split(sep).join("/");
      const pkg = /^packages\/([^/]+)\/src\//.exec(path)?.[1];
      if (skipped(path) || (!pkg && !path.startsWith("docs-site/src/"))) continue;
      const text = readFileSync(file, "utf8");
      if (pkg) apps.get(pkg)?.set(file, text);
      if (ALLOWED_RENDERERS.has(path) || !text.includes("@k2b/stdlib")) continue;
      const source = parse(file, text);
      rawRenderers(source, (node, name) => {
        findings.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          message: `Raw stdlib chart renderer \`${name}\`: render charts with @k2b/ui Chart, ChartExplorer or ChartSnapshotView, or enhance stdlib SVG with inspectChart and add this file to the chart-rendering allow-list with a reason.`,
        });
      });
    }
    for (const [id, texts] of apps) {
      const src = join(workspaceRoot, "packages", id, "src");
      const modules = new Map<string, ChartModule>();
      const module = (file: string): ChartModule => {
        let parsed = modules.get(file);
        if (!parsed) {
          parsed = chartModule(parse(file, texts.get(file) ?? ""));
          modules.set(file, parsed);
        }
        return parsed;
      };
      const { isHydrated, serverImporters } = hydration(texts, src, module);
      for (const [file, text] of texts) {
        if (!mayRenderChart(text)) continue;
        const { chart } = module(file);
        if (!chart || isHydrated(file)) continue;
        const server = serverImporters(file).map((path) => relative(dirname(file), path).split(sep).join("/"));
        const reason = server.length > 0 ? `${server.join(", ")} imports it outside an island` : "no island imports it";
        findings.push({
          file,
          line: chart.line,
          message: `<${chart.tag}> renders outside an island (${reason}): charts need an island for tooltips and keyboard inspection. Render it from a .island.tsx module, or from a module that only islands import.`,
        });
      }
    }
    return findings;
  },
};
