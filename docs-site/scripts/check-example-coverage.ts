import { readdir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const importPattern = /(?:from\s+|import\s*\()\s*["'](@k2b\/[^"']+)["']/g;

export const packageSpecifiers = (source: string): Set<string> => new Set([...source.matchAll(importPattern)].map((match) => match[1]));

export type RecipeFixture = {
  page: string;
  fixtures: string[];
};

export const recipeFixtures: RecipeFixture[] = [
  {
    page: "identity/authentication.md",
    fixtures: ["identity-access.ts"],
  },
  {
    page: "identity/authorization.md",
    fixtures: ["identity-access.ts"],
  },
  {
    page: "identity/resource-api-keys.md",
    fixtures: ["identity-resource-api-keys.tsx"],
  },
  {
    page: "server/http.md",
    fixtures: ["server-api.ts"],
  },
  {
    page: "server/middleware.md",
    fixtures: ["server-api.ts"],
  },
  {
    page: "platform/notifications.md",
    fixtures: ["platform-services.ts", "platform-notifications.ts"],
  },
  {
    page: "platform/capabilities.md",
    fixtures: ["platform-capabilities.ts", "platform-capabilities-app.ts"],
  },
  {
    page: "platform/search.md",
    fixtures: ["platform-capabilities.ts", "platform-capabilities-app.ts"],
  },
  {
    page: "automation/author-and-publish-workflows.md",
    fixtures: ["automation.ts"],
  },
  {
    page: "ai/chat-interface.md",
    fixtures: ["ai-ui.tsx"],
  },
  {
    page: "frontend/ssr-pages-and-routing.md",
    fixtures: ["frontend-server.tsx"],
  },
  {
    page: "frontend/server-backed-island-state.md",
    fixtures: ["frontend-browser.ts"],
  },
];

export const missingExampleImports = (documented: Iterable<string>, examples: Iterable<string>): string[] => {
  const covered = new Set(examples);
  return [...new Set(documented)]
    .filter((specifier) => !specifier.includes("/src/"))
    .filter((specifier) => !covered.has(specifier))
    .sort();
};

export const recipeFixtureErrors = (
  recipes: RecipeFixture[],
  pages: ReadonlyMap<string, string>,
  fixtures: ReadonlyMap<string, string>,
): string[] => {
  const errors: string[] = [];

  for (const recipe of recipes) {
    const page = pages.get(recipe.page);
    if (page === undefined) {
      errors.push(`${recipe.page}: recipe page does not exist`);
      continue;
    }

    const missingFixtures = recipe.fixtures.filter((fixture) => !fixtures.has(fixture));
    for (const fixture of missingFixtures) {
      errors.push(`${recipe.page}: compile fixture does not exist: ${fixture}`);
    }
    if (missingFixtures.length > 0) continue;

    const documented = packageSpecifiers(page);
    const covered = new Set(recipe.fixtures.flatMap((fixture) => [...packageSpecifiers(fixtures.get(fixture) ?? "")]));
    const missingImports = missingExampleImports(documented, covered);
    for (const specifier of missingImports) {
      errors.push(`${recipe.page}: documented import is not covered by its compile fixture: ${specifier}`);
    }
  }

  return errors;
};

const listFiles = async (directory: string, extensions: Set<string>): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path, extensions)));
      continue;
    }

    const extension = entry.name.slice(entry.name.lastIndexOf("."));
    if (entry.isFile() && extensions.has(extension)) files.push(path);
  }

  return files.sort();
};

if (import.meta.main) {
  const docsRoot = resolve(import.meta.dir, "../docs/en");
  const examplesRoot = resolve(import.meta.dir, "../examples/cloud-docs");
  const docs = await listFiles(docsRoot, new Set([".md"]));
  const examples = await listFiles(examplesRoot, new Set([".ts", ".tsx"]));

  const pageSources = new Map<string, string>();
  const documented = new Set<string>();
  for (const path of docs) {
    const source = await Bun.file(path).text();
    pageSources.set(relative(docsRoot, path).replaceAll(sep, "/"), source);
    for (const specifier of packageSpecifiers(source)) {
      documented.add(specifier);
    }
  }

  const fixtureSources = new Map<string, string>();
  const covered = new Set<string>();
  for (const path of examples) {
    const source = await Bun.file(path).text();
    fixtureSources.set(relative(examplesRoot, path).replaceAll(sep, "/"), source);
    for (const specifier of packageSpecifiers(source)) {
      covered.add(specifier);
    }
  }

  const missing = missingExampleImports(documented, covered);
  if (missing.length) {
    throw new Error(`Documented package imports without a compile fixture:\n${missing.map((specifier) => `- ${specifier}`).join("\n")}`);
  }

  const recipeErrors = recipeFixtureErrors(recipeFixtures, pageSources, fixtureSources);
  if (recipeErrors.length) {
    throw new Error(`Canonical recipes without matching compile fixtures:\n${recipeErrors.map((error) => `- ${error}`).join("\n")}`);
  }

  console.log(
    `Documentation example coverage is current (${documented.size} documented package imports, ${examples.length} fixture files, ${recipeFixtures.length} canonical recipes).`,
  );
}
