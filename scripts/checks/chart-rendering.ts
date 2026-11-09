import { readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import ts from "@typescript/typescript6";
import { charts } from "../../packages/ui/src/charts/core/svg";
import { packageIds } from "../workspace";
import { isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const RENDERERS = new Set([
  "charts",
  ...Object.keys(charts),
  "renderChartSvg",
  "renderBarChartSvg",
  "renderStateTimelineSvg",
  "layout",
  "toSvg",
]);
const UPSTREAM_CHART_EXPORTS = new Set([
  ...RENDERERS,
  "ChartKind",
  "ChartDatum",
  "Point",
  "Series",
  "MarkerShape",
  "LineStyle",
  "MapPoint",
  "MapSeries",
  "MapViewport",
  "MapOptions",
  "BarItem",
  "SliceItem",
  "AxisOptions",
  "Padding",
  "ChartOptions",
  "ReferenceLine",
  "chartDatumSvg",
  "svgRoot",
  "escapeXml",
  "normalizePadding",
  "computeDomain",
  "niceStep",
  "extendDomainToNice",
  "mapRange",
  "mapLog",
  "niceLogTicks",
  "linearRegression",
  "computeBoxStats",
  "autoBin",
  "linePathD",
  "smoothPathD",
  "arcPathD",
  "markerPath",
  "stepPathD",
]);
const upstreamChartModule = (name: string | undefined): boolean => name === "@k2b/stdlib" || name === "@k2b/stdlib/charts";
// Temporary B3b boundary: #3010 deletes Studio and moves Code to chat-code/runtime.
const frozenStudioPath = (path: string): boolean =>
  path.startsWith("packages/assistant/src/artifacts/") ||
  path === "packages/assistant/src/frontend/AssistantWorkspace.island.tsx" ||
  path === "packages/assistant/src/styles/app.css";
const rawChartModule = (name: string | undefined): boolean => name === "@k2b/ui/charts/core" || name === "@k2b/ui/charts";
const CHART_COMPONENTS = new Set(["Chart", "ChartExplorer", "ChartSnapshotView", "StatCell"]);
const LIBRARIES = new Set(["ui", "cloud", "ssr", "editor"]);
/** The browser entries @k2b/ssr discovers (`**\/*.{island,client}.tsx`). */
const BROWSER_ENTRY = /\.(?:island|client)\.tsx$/;
const ALLOWED_RENDERERS = new Map([
  ["packages/ui/src/charts/core/registry.ts", "Pure renderer registry; Chart adds shared inspection and snapshots retain inert metadata."],
  ["packages/ui/src/content/Chart.tsx", "The shared Chart wrapper renders with inspect: true and attaches createChartInspection."],
  [
    "packages/ui/src/content/chart-bar.ts",
    "The shared bar renderer behind Chart; Chart calls it with inspect: true and attaches createChartInspection.",
  ],
  [
    "packages/assistant/src/chat-code/runtime/lib.ts",
    "Studio cloud.chart() runs in a sandbox whose frame prelude enhances SVG with inspectChart.",
  ],
  [
    "packages/assistant/src/chat-code/runtime/chart-renderers-rare.ts",
    "Offline cloud.chart() drawings use inspect: true; the frame attaches inspectChart after loading. Script/PDF output stays inert.",
  ],
  ["packages/editor/src/charts.ts", "Reads SVG marks for validation and tables; the SVG never reaches the DOM."],
]);

// These raw parts share the dispatcher's inspection contract: cloud.chart()
// passes inspect: true and the frame enhances SVG; scripts/PDFs stay inert.
const APP_CHART_KIND = /^packages\/assistant\/src\/chat-code\/runtime\/chart-kind-[a-z][a-zA-Z0-9-]*\.ts$/;

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

const rawRenderers = (source: ts.SourceFile, report: (node: ts.Node, name: string) => void, upstreamOnly = false): void => {
  const moduleMatches = upstreamOnly ? upstreamChartModule : rawChartModule;
  const names = upstreamOnly ? UPSTREAM_CHART_EXPORTS : RENDERERS;
  const namespaces = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      moduleMatches(moduleName(node.moduleSpecifier)) &&
      (upstreamOnly || !node.importClause?.isTypeOnly)
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const name = (element.propertyName ?? element.name).text;
          if ((upstreamOnly || !element.isTypeOnly) && names.has(name)) report(element, name);
        }
      }
    }
    if (ts.isExportDeclaration(node) && moduleMatches(moduleName(node.moduleSpecifier)) && (upstreamOnly || !node.isTypeOnly)) {
      if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const name = (element.propertyName ?? element.name).text;
          if ((upstreamOnly || !element.isTypeOnly) && names.has(name)) report(element, name);
        }
      } else report(node, "charts");
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (moduleMatches(dynamicModule(unwrap(node.initializer)))) namespaces.add(node.name.text);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const isNamespace = (expression: ts.Expression): boolean => {
    const node = unwrap(expression);
    return (ts.isIdentifier(node) && namespaces.has(node.text)) || moduleMatches(dynamicModule(node));
  };
  const destructured = (pattern: ts.BindingName): void => {
    if (!ts.isObjectBindingPattern(pattern)) return;
    for (const element of pattern.elements) {
      const name = propertyName(element.propertyName ?? element.name);
      if (!element.dotDotDotToken && name && names.has(name)) report(element, name);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      upstreamOnly &&
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal) &&
      moduleMatches(node.argument.literal.text) &&
      node.qualifier
    ) {
      const name = ts.isIdentifier(node.qualifier) ? node.qualifier.text : node.qualifier.left.getText(source);
      if (names.has(name)) report(node, name);
    }
    if (
      upstreamOnly &&
      ts.isQualifiedName(node) &&
      ts.isIdentifier(node.left) &&
      namespaces.has(node.left.text) &&
      names.has(node.right.text)
    )
      report(node, node.right.text);
    if (ts.isPropertyAccessExpression(node) && isNamespace(node.expression) && names.has(node.name.text)) {
      report(node, node.name.text);
    }
    if (ts.isElementAccessExpression(node) && isNamespace(node.expression) && ts.isStringLiteral(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (names.has(name)) report(node, name);
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isNamespace(node.initializer)) destructured(node.name);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "then" &&
      moduleMatches(dynamicModule(unwrap(node.expression.expression)))
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
    if (
      !ts.isImportDeclaration(node) ||
      !["@k2b/ui", "@k2b/ui/charts"].includes(moduleName(node.moduleSpecifier) ?? "") ||
      node.importClause?.isTypeOnly
    )
      continue;
    const bindings = node.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && CHART_COMPONENTS.has(name)) components.set(element.name.text, name);
      }
    }
  }
  const chartName = (tag: ts.Node): string | undefined => {
    if (ts.isIdentifier(tag)) return components.get(tag.text);
    if (!ts.isPropertyAccessExpression(tag)) return;
    if (ts.isIdentifier(tag.expression) && namespaces.has(tag.expression.text)) return tag.name.text;
    // Chart.Line and aliased/nested namespace members retain the tracked component's island requirement.
    return chartName(tag.expression);
  };
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
      const name = chartName(tag);
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
      ...listFiles(join(workspaceRoot, "docs-site"), sourceFilePattern),
      ...listFiles(join(workspaceRoot, "pwas"), sourceFilePattern),
      ...listFiles(join(workspaceRoot, "scripts"), sourceFilePattern),
    ].sort();
    for (const file of files) {
      const path = relative(workspaceRoot, file).split(sep).join("/");
      const pkg = /^packages\/([^/]+)\/src\//.exec(path)?.[1];
      const text = readFileSync(file, "utf8");
      // Upstream chart drawing is forbidden even in tests, scripts and otherwise allowed core adapters.
      // String fixtures in this rule's tests are data; the AST reports only real imports and accesses.
      if (!frozenStudioPath(path) && text.includes("@k2b/stdlib")) {
        const source = parse(file, text);
        rawRenderers(
          source,
          (node, name) =>
            findings.push({
              file,
              line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
              message: `Raw chart renderer \`${name}\` from stdlib is retired: import chart contracts and drawing from @k2b/ui/charts/core.`,
            }),
          true,
        );
      }
      if (skipped(path) || (!pkg && !path.startsWith("docs-site/src/"))) continue;
      if (pkg) apps.get(pkg)?.set(file, text);
      if (ALLOWED_RENDERERS.has(path) || APP_CHART_KIND.test(path) || !text.includes("@k2b/ui/charts")) continue;
      const source = parse(file, text);
      rawRenderers(source, (node, name) => {
        findings.push({
          file,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
          message: `Raw chart renderer \`${name}\`: render charts with @k2b/ui Chart, ChartExplorer or ChartSnapshotView, or enhance raw SVG with inspectChart and add this file to the chart-rendering allow-list with a reason.`,
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
