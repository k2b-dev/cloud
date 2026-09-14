import { describe, expect, test } from "bun:test";
import { dirname, join, normalize, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../../..");
const sourceGlob = new Bun.Glob("packages/*/src/**/*.tsx");
const helpRegistration = /<Layout\.(?:HelpDocuments|HelpPage)(?:\s|>)/;

const withoutTsx = (path: string) => path.replace(/\.tsx$/, "");
const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const isHelpRegistration = (path: string, source: string) =>
  path.endsWith("/RegisteredHelpDocuments.island.tsx") || helpRegistration.test(withoutComments(source));
const loadSources = async () => {
  const sources = new Map<string, string>();
  for await (const path of sourceGlob.scan({ cwd: repoRoot })) {
    sources.set(normalize(path), await Bun.file(join(repoRoot, path)).text());
  }
  return sources;
};

const importedFiles = (path: string, source: string, sources: ReadonlyMap<string, string>) => {
  const imports: string[] = [];
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const resolved = normalize(join(dirname(path), specifier));
    const candidates = [`${resolved}.tsx`, join(resolved, "index.tsx")];
    const imported = candidates.find((candidate) => sources.has(candidate));
    if (imported) imports.push(imported);
  }
  return imports;
};

describe("Layout Help hydration boundaries", () => {
  test("interactive Help components are owned by exactly one island", async () => {
    const sources = await loadSources();

    const registrationFiles = [...sources]
      .filter(([path, source]) => path !== "packages/cloud/src/ssr/LayoutHelp.tsx" && isHelpRegistration(path, source))
      .map(([path]) => path);

    const importersOf = (target: string) => {
      const targetWithoutExtension = withoutTsx(target);
      const importers: string[] = [];

      for (const [path, source] of sources) {
        for (const match of source.matchAll(/from\s+["']([^"']+)["']/g)) {
          const specifier = match[1];
          if (!specifier?.startsWith(".")) continue;
          const importedPath = withoutTsx(normalize(join(dirname(path), specifier)));
          if (importedPath === targetWithoutExtension) importers.push(path);
        }
      }

      return importers;
    };
    const isOwnedByIsland = (path: string, visited = new Set<string>()): boolean => {
      if (visited.has(path)) return false;
      visited.add(path);
      const importers = importersOf(path);
      return (
        importers.length > 0 &&
        importers.every((importer) => importer.endsWith(".island.tsx") || isOwnedByIsland(importer, new Set(visited)))
      );
    };

    const invalid = registrationFiles.flatMap((path) => {
      const importers = importersOf(path);
      if (path.endsWith(".island.tsx")) {
        const nestedIslandImporters = importers.filter((importer) => importer.endsWith(".island.tsx"));
        return nestedIslandImporters.map((importer) => `${path} is nested inside ${importer}`);
      }

      return isOwnedByIsland(path) ? [] : [`${path} has a render path without an owning island`];
    });

    expect(registrationFiles.length).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
  }, 30_000);

  test("every app page with a Help collection can reach its registrar", async () => {
    const sources = await loadSources();
    const registrationFiles = new Set(
      [...sources]
        .filter(([path, source]) => path !== "packages/cloud/src/ssr/LayoutHelp.tsx" && isHelpRegistration(path, source))
        .map(([path]) => path),
    );
    const helpPackages = new Set<string>();
    const automaticHelpPackages = new Set<string>();
    for await (const path of new Bun.Glob("packages/*/src/help/index.ts").scan({ cwd: repoRoot })) {
      const packageName = path.split("/")[1];
      if (!packageName) continue;
      helpPackages.add(packageName);
      const source = await Bun.file(join(repoRoot, path)).text();
      if (/\bdefineHelp\s*\(/.test(source)) automaticHelpPackages.add(packageName);
    }
    for (const path of registrationFiles) {
      const packageName = path.split("/")[1];
      if (packageName) helpPackages.add(packageName);
    }

    const reachesRegistrar = (entry: string, visited = new Set<string>()): boolean => {
      if (registrationFiles.has(entry)) return true;
      if (visited.has(entry)) return false;
      visited.add(entry);
      const source = sources.get(entry);
      if (!source) return false;
      return importedFiles(entry, source, sources).some((path) => reachesRegistrar(path, visited));
    };

    const appPages = [...sources]
      .filter(([path, source]) => {
        const packageName = path.split("/")[1];
        return !!packageName && helpPackages.has(packageName) && /<(?:Admin)?Layout(?:\s|>)/.test(withoutComments(source));
      })
      .map(([path]) => path);
    const missing = appPages.filter((path) => {
      const packageName = path.split("/")[1];
      return !packageName || (!automaticHelpPackages.has(packageName) && !reachesRegistrar(path));
    });

    expect(appPages.length).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  }, 30_000);
});
