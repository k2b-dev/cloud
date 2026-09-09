import ts from "typescript";
import {
  documentedOnlyUiCatalogExports,
  hiddenUiCatalogExports,
  portableUiComponentCount,
  uiCatalogEntries,
  uiCatalogSections,
} from "../src/ui/catalog";
import {
  catalogContextFiles,
  catalogContexts,
  standaloneUiContextFiles,
} from "../src/ui/context";
import { catalogDemoRenderers } from "../src/ui/UiCatalogPage";
import { demoSectionLoaders } from "../src/ui/demo-sections";

const sorted = (values: Iterable<string>) => [...values].sort();
const difference = (left: readonly string[], right: readonly string[]) =>
  left.filter((value) => !right.includes(value));
const duplicateValues = (values: readonly string[]) =>
  values.filter((value, index) => values.indexOf(value) !== index);
const exactSetFailures = (label: string, expected: readonly string[], actual: readonly string[]) => [
  ...difference(expected, actual).map((value) => `${label} missing ${value}`),
  ...difference(actual, expected).map((value) => `${label} has unknown ${value}`),
];
const identifierPattern = (name: string) =>
  new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);

const catalogIds = sorted(uiCatalogEntries.map((entry) => entry.id));
const contextIds = sorted(Object.keys(catalogContexts));
const demoIds = sorted(
  (
    await Promise.all(
      Object.entries(demoSectionLoaders).map(async ([section, load]) =>
        Object.keys((await load()).default).map((slug) => `${section}/${slug}`),
      ),
    )
  ).flat(),
);
const catalogSectionIds = sorted(new Set(uiCatalogEntries.map((entry) => entry.section)));
const declaredSectionIds = sorted(uiCatalogSections.map((section) => section.id));
const demoSectionIds = sorted(Object.keys(demoSectionLoaders));
const rendererSectionIds = sorted(Object.keys(catalogDemoRenderers));

const registryFailures = [
  ...exactSetFailures("Context registry", catalogIds, contextIds),
  ...exactSetFailures("Demo-page registry", catalogIds, demoIds),
  ...exactSetFailures("Section metadata registry", catalogSectionIds, declaredSectionIds),
  ...exactSetFailures("Demo-loader registry", catalogSectionIds, demoSectionIds),
  ...exactSetFailures("SSR renderer registry", catalogSectionIds, rendererSectionIds),
];

const incompleteContext = uiCatalogEntries
  .filter(
    (entry) =>
      !entry.context.startsWith("# ") ||
      !entry.context.includes("## Use ") ||
      !entry.context.includes("## Import") ||
      !entry.context.includes("## Accessibility") ||
      !entry.context.includes("## Runtime") ||
      !entry.context.includes("## Example"),
  )
  .map((entry) => entry.id);
const agentOnlyHeadings = uiCatalogEntries
  .filter((entry) => entry.context.includes("## For agents"))
  .map((entry) => entry.id);
const fallbackContext = uiCatalogEntries
  .filter((entry) =>
    [
      "The preview below covers",
      "Each card contains the exact TSX",
      "The preview below uses the current repository source",
      "Loading repository examples",
    ].some((phrase) => entry.context.includes(phrase)),
  )
  .map((entry) => entry.id);
const portableBoundaryViolations = uiCatalogEntries
  .filter(
    (entry) =>
      entry.scope === "portable" &&
      (!entry.context.includes("@k2b/ui") ||
        entry.context.includes("@k2b/cloud/") ||
        entry.context.includes("@k2b/cloud")),
  )
  .map((entry) => entry.id);
const cloudBoundaryViolations = uiCatalogEntries
  .filter((entry) => entry.scope === "cloud" && !entry.context.includes("@k2b/cloud"))
  .map((entry) => entry.id);

const portableSectionIds = uiCatalogSections
  .filter((section) => section.scope === "portable")
  .map((section) => section.id);
const portableDemoFiles = [
  ...portableSectionIds.map((section) => `../src/ui/demo-sections/${section}.tsx`),
  "../src/ui/DemoCard.tsx",
];
const portableDemoSources = await Promise.all(
  portableDemoFiles.map(async (path) => ({
    path,
    source: await Bun.file(new URL(path, import.meta.url)).text(),
  })),
);
const portableDemoBoundaryViolations = portableDemoSources
  .filter(({ source }) => source.includes("@k2b/cloud") || source.includes("@k2b/cloud"))
  .map(({ path }) => path);

const liveRuntimeImports = new Set<string>();
const unsupportedUiImports: string[] = [];
for (const { path, source } of portableDemoSources) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@k2b/ui" ||
      !statement.importClause ||
      statement.importClause.isTypeOnly
    ) {
      continue;
    }

    if (statement.importClause.name) {
      unsupportedUiImports.push(`${path}: default import`);
    }
    const bindings = statement.importClause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      unsupportedUiImports.push(`${path}: namespace import`);
      continue;
    }
    if (!bindings) continue;
    for (const element of bindings.elements) {
      if (!element.isTypeOnly) {
        liveRuntimeImports.add((element.propertyName ?? element.name).text);
      }
    }
  }
}

const runtimeExports = sorted(Object.keys(await import("@k2b/ui")));
const runtimeComponentExports = runtimeExports.filter((name) => /^[A-Z][a-z]/.test(name));
const liveExports = sorted(liveRuntimeImports);
const hiddenExports = sorted(Object.keys(hiddenUiCatalogExports));
const documentedOnlyExports = sorted(Object.keys(documentedOnlyUiCatalogExports));
const explicitExceptions = sorted([...hiddenExports, ...documentedOnlyExports]);
const exceptionCollisions = hiddenExports.filter((name) => documentedOnlyExports.includes(name));
const liveExceptionCollisions = liveExports.filter((name) => explicitExceptions.includes(name));
const staleHiddenExports = difference(hiddenExports, runtimeExports);
const staleDocumentedOnlyExports = difference(documentedOnlyExports, runtimeExports);
const unknownLiveImports = difference(liveExports, runtimeExports);
const undocumentedRuntimeExports = runtimeExports.filter(
  (name) => !liveRuntimeImports.has(name) && !explicitExceptions.includes(name),
);
const emptyExceptionReasons = [
  ...Object.entries(hiddenUiCatalogExports),
  ...Object.entries(documentedOnlyUiCatalogExports),
]
  .filter(([, reason]) => reason.trim().length < 12)
  .map(([name]) => name);
const portableContextCorpus = uiCatalogEntries
  .filter((entry) => entry.scope === "portable")
  .map((entry) => entry.context)
  .join("\n");
const documentedOnlyWithoutContext = documentedOnlyExports.filter(
  (name) => !identifierPattern(name).test(portableContextCorpus),
);

const contextDirectory = new URL("../src/ui/context/", import.meta.url);
const discoveredContextFiles = sorted(
  new Bun.Glob("**/*.md").scanSync({ cwd: contextDirectory.pathname }),
);
const registeredContextFiles = sorted(Object.values(catalogContextFiles));
const standaloneContextFiles = sorted(Object.keys(standaloneUiContextFiles));
const expectedContextFiles = sorted([...registeredContextFiles, ...standaloneContextFiles]);
const contextFileFailures = exactSetFailures(
  "Context filesystem",
  expectedContextFiles,
  discoveredContextFiles,
);
const duplicateContextFiles = duplicateValues(registeredContextFiles);
const emptyStandaloneReasons = Object.entries(standaloneUiContextFiles)
  .filter(([, reason]) => reason.trim().length < 12)
  .map(([file]) => file);

const overviewContext = await Bun.file(
  new URL("../src/ui/context/overview.md", import.meta.url),
).text();
const overviewCloudMatches =
  overviewContext.split("## Cloud components")[1]?.matchAll(/^-\s+\*\*(.+?)\*\*/gm) ?? [];
const overviewCloudTitles = Array.from(overviewCloudMatches, (match) => match[1]).sort();
const catalogCloudTitles = uiCatalogEntries
  .filter((entry) => entry.scope === "cloud")
  .map((entry) => entry.page.title)
  .sort();
const overviewCloudFailures = exactSetFailures(
  "Cloud overview",
  catalogCloudTitles,
  overviewCloudTitles,
);

const failures = [
  [
    "Stale portable component count",
    portableUiComponentCount === runtimeComponentExports.length
      ? []
      : [`expected ${runtimeComponentExports.length}, received ${portableUiComponentCount}`],
  ],
  ["Duplicate catalog pages", duplicateValues(catalogIds)],
  ["Duplicate section metadata", duplicateValues(declaredSectionIds)],
  ["Catalog registry key-set mismatches", registryFailures],
  ["Pages with incomplete Markdown context", incompleteContext],
  ["Pages with agent-only headings", agentOnlyHeadings],
  ["Pages using generated fallback copy", fallbackContext],
  ["Portable pages crossing the Cloud package boundary", portableBoundaryViolations],
  ["Portable demos crossing the Cloud package boundary", portableDemoBoundaryViolations],
  ["Unsupported @k2b/ui import forms in demos", unsupportedUiImports],
  ["Live demo imports that are not runtime exports", unknownLiveImports],
  ["@k2b/ui runtime exports without live or explicit coverage", undocumentedRuntimeExports],
  ["Hidden exports that are no longer public", staleHiddenExports],
  ["Documented-only exports that are no longer public", staleDocumentedOnlyExports],
  ["Exports classified as both hidden and documented-only", exceptionCollisions],
  ["Live imports also classified as exceptions", liveExceptionCollisions],
  ["Export exceptions without a specific reason", emptyExceptionReasons],
  ["Documented-only exports absent from portable context", documentedOnlyWithoutContext],
  ["Cloud pages without an explicit Cloud dependency", cloudBoundaryViolations],
  ["UI context filesystem mismatches", contextFileFailures],
  ["Context files registered more than once", duplicateContextFiles],
  ["Standalone context files without a reason", emptyStandaloneReasons],
  ["Cloud overview does not match the exact Cloud catalog", overviewCloudFailures],
] as const;

const failed = failures.filter(([, values]) => values.length > 0);
if (failed.length > 0) {
  console.error("UI catalog coverage check failed.");
  for (const [label, values] of failed) {
    console.error(`\n${label}:`);
    for (const value of values) console.error(`- ${value}`);
  }
  process.exit(1);
}

const requireHttp = Bun.argv.includes("--require-http");
const smokeBaseUrl = process.env.CLOUD_UI_CATALOG_URL?.replace(/\/$/, "");
if (requireHttp && !smokeBaseUrl) {
  console.error(
    "UI catalog HTTP smoke is required but CLOUD_UI_CATALOG_URL is not configured.",
  );
  process.exit(1);
}

if (smokeBaseUrl) {
  const smokeFailures: string[] = [];
  const queue = [...uiCatalogEntries];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) return;

      const pageUrl = `${smokeBaseUrl}/en/ui/${entry.id}`;
      try {
        const pageResponse = await fetch(pageUrl);
        const html = await pageResponse.text();
        const island = html.match(/<solid-island\b[^>]*>([\s\S]*?)<\/solid-island>/);
        if (!pageResponse.ok) {
          smokeFailures.push(`${entry.id}: page returned ${pageResponse.status}`);
        } else if (!island || island[1].trim().length === 0) {
          smokeFailures.push(`${entry.id}: empty initial island HTML`);
        } else if (
          !island[1].includes("ui-demo-card") ||
          island[1].includes("No live example is registered")
        ) {
          smokeFailures.push(`${entry.id}: expected live demo card was not rendered`);
        } else if (html.includes("<solid-client")) {
          smokeFailures.push(`${entry.id}: client-only demo wrapper`);
        }

        const rawResponse = await fetch(`${pageUrl}.md`);
        const markdown = await rawResponse.text();
        if (!rawResponse.ok) {
          smokeFailures.push(`${entry.id}: raw Markdown returned ${rawResponse.status}`);
        } else if (markdown.trim() !== entry.context.trim()) {
          smokeFailures.push(`${entry.id}: raw Markdown differs from canonical context`);
        }
      } catch (error) {
        smokeFailures.push(
          `${entry.id}: request failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  });
  await Promise.all(workers);

  if (smokeFailures.length > 0) {
    console.error("UI catalog HTTP smoke failed.");
    for (const failure of smokeFailures) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log(
    `UI catalog HTTP smoke passed (${uiCatalogEntries.length} SSR pages and raw Markdown routes).`,
  );
}

console.log(
  `UI catalog coverage check passed (${catalogIds.length} pages, ${runtimeExports.length} runtime exports, ${liveExports.length} live imports, ${documentedOnlyExports.length} documented-only, ${hiddenExports.length} hidden, ${catalogSectionIds.length} sections).`,
);
process.exit(0);
