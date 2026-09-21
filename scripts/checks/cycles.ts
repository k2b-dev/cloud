import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import ts from "typescript";
import { packageIds } from "../workspace";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

type PackageConfig = { name: string; srcRoot: string; aliasPrefix: string };

const extractRuntimeSpecifiers = (filePath: string, source: string): string[] => {
  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, scriptKind);
  const specifiers: string[] = [];

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue;
      if (ts.isStringLiteral(stmt.moduleSpecifier)) specifiers.push(stmt.moduleSpecifier.text);
      continue;
    }
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.isTypeOnly) continue;
      if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) specifiers.push(stmt.moduleSpecifier.text);
    }
  }

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) specifiers.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return specifiers;
};

const tryResolveFile = (baseNoExt: string): string | null => {
  const candidates = [
    baseNoExt,
    `${baseNoExt}.ts`,
    `${baseNoExt}.tsx`,
    `${baseNoExt}.d.ts`,
    join(baseNoExt, "index.ts"),
    join(baseNoExt, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return normalize(candidate);
  }
  return null;
};

const resolveLocalImport = (pkg: PackageConfig, fromFile: string, specifier: string): string | null => {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return tryResolveFile(resolve(dirname(fromFile), specifier));
  if (specifier.startsWith(pkg.aliasPrefix)) return tryResolveFile(resolve(pkg.srcRoot, specifier.slice(pkg.aliasPrefix.length)));
  return null;
};

const buildGraph = (pkg: PackageConfig): Map<string, Set<string>> => {
  const graph = new Map<string, Set<string>>();
  for (const file of listFiles(pkg.srcRoot, sourceFilePattern)) {
    const deps = new Set<string>();
    for (const specifier of extractRuntimeSpecifiers(file, readFileSync(file, "utf8"))) {
      const resolved = resolveLocalImport(pkg, file, specifier);
      if (resolved?.startsWith(pkg.srcRoot)) deps.add(resolved);
    }
    graph.set(normalize(file), deps);
  }
  return graph;
};

const detectCycles = (graph: Map<string, Set<string>>): string[][] => {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: string[] = [];

  const dfs = (node: string) => {
    visited.add(node);
    stack.add(node);
    path.push(node);
    for (const dep of graph.get(node) ?? []) {
      if (!graph.has(dep)) continue;
      if (!visited.has(dep)) {
        dfs(dep);
        continue;
      }
      if (stack.has(dep)) {
        const start = path.indexOf(dep);
        if (start !== -1) cycles.push([...path.slice(start), dep]);
      }
    }
    path.pop();
    stack.delete(node);
  };

  for (const node of graph.keys()) if (!visited.has(node)) dfs(node);

  const dedup = new Map<string, string[]>();
  for (const cycle of cycles) {
    const key = cycle.join(" -> ");
    if (!dedup.has(key)) dedup.set(key, cycle);
  }
  return [...dedup.values()];
};

export const rule: Rule = {
  name: "cycles",
  description: "Runtime import cycles inside packages/cloud (and every application with --apps)",
  run: async ({ workspaceRoot, flags }) => {
    const packagesRoot = join(workspaceRoot, "packages");
    // Each package uses `@/` only inside itself, so each one is its own boundary unit.
    const names = flags.has("--apps")
      ? ["cloud", ...packageIds(workspaceRoot).filter((name) => name !== "cloud" && existsSync(join(packagesRoot, name, "src")))]
      : ["cloud"];
    const findings: Finding[] = [];
    for (const name of names) {
      const pkg: PackageConfig = { name, srcRoot: join(packagesRoot, name, "src"), aliasPrefix: "@/" };
      for (const cycle of detectCycles(buildGraph(pkg)).slice(0, 20)) {
        findings.push({ message: `${name}: ${cycle.map((node) => relative(workspaceRoot, node)).join(" -> ")}` });
      }
    }
    return findings;
  },
};
