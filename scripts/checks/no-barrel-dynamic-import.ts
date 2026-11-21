import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

// Test harnesses and fixtures load whole packages on purpose; they never ship in an island.
const isTestSupport = (path: string) => isTestFile(path) || /(?:suite|harness|fixture)\.tsx?$/.test(path);
const reExport = /^export\s*(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["']([^"']+)["'];?$/;
const loaders = { ".js": "js", ".mjs": "js", ".jsx": "jsx", ".ts": "ts", ".mts": "ts", ".tsx": "tsx" } as const;
// Bun's transpiler rejects a shebang; blanking it keeps the line numbers.
const withoutShebang = (source: string) => source.replace(/^#!.*/, "");
const loaderFor = (path: string) => loaders[extname(path) as keyof typeof loaders];

/** The number of modules a file re-exports when it consists of nothing else, otherwise 0. */
const reExportedModules = (path: string): number => {
  const loader = loaderFor(path);
  if (!loader) return 0;
  const code = new Bun.Transpiler({ loader }).transformSync(withoutShebang(readFileSync(path, "utf8")));
  const targets = new Set<string>();
  for (const statement of code.split("\n").map((line) => line.trim())) {
    if (!statement) continue;
    const target = reExport.exec(statement)?.[1];
    if (!target) return 0;
    targets.add(target);
  }
  return targets.size;
};

/**
 * An `import()` of a package entry that only re-exports other modules needs the whole namespace. When other browser
 * code imports the same entry statically, Bun then keeps every re-export, and code splitting puts modules that islands
 * never use into their static chunks (#3504). `@k2b/ssr` only warns, so third-party builds keep working; inside this
 * repository the rule makes it an error.
 */
export const rule: Rule = {
  name: "no-barrel-dynamic-import",
  description: "Code never loads a package entry that only re-exports other modules on demand when other code imports it statically",
  run: async ({ workspaceRoot }) => {
    const packagesDir = join(workspaceRoot, "packages");
    const files = (isDirectory(packagesDir) ? readdirSync(packagesDir) : [])
      .flatMap((name) => listFiles(join(packagesDir, name, "src"), sourceFilePattern))
      .filter((file) => !isTestSupport(file))
      .sort();
    const staticSpecifiers = new Set<string>();
    const dynamic: { file: string; line: number; specifier: string }[] = [];
    for (const file of files) {
      const source = withoutShebang(readFileSync(file, "utf8"));
      for (const { kind, path } of new Bun.Transpiler({ loader: loaderFor(file) ?? "tsx" }).scanImports(source)) {
        if (kind === "import-statement") staticSpecifiers.add(path);
        else if (kind === "dynamic-import" && !/^[./]/.test(path)) {
          const at = source.search(new RegExp(`import\\(\\s*["']${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}["']`));
          dynamic.push({ file, line: at < 0 ? 1 : source.slice(0, at).split("\n").length, specifier: path });
        }
      }
    }
    const findings: Finding[] = [];
    for (const { file, line, specifier } of dynamic) {
      if (!staticSpecifiers.has(specifier)) continue;
      let target: string;
      try {
        target = Bun.resolveSync(specifier, dirname(file));
      } catch {
        findings.push({ file, line, message: `cannot resolve ${specifier}, so the rule cannot check this on-demand import` });
        continue;
      }
      // A single re-exported module, such as a narrow package subpath, has nothing to narrow.
      if (reExportedModules(target) < 2) continue;
      findings.push({
        file,
        line,
        message: `import("${specifier}") loads an entry that only re-exports other modules and that other code imports statically, so islands keep unused modules in their first JavaScript (#3504). Import a small local module on demand that re-exports only the names it needs, for example \`export { toast } from "@k2b/ui";\`.`,
      });
    }
    return findings;
  },
};
