import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const extractSpecifiers = (source: string): Array<{ specifier: string; index: number }> => {
  const matches: Array<{ specifier: string; index: number }> = [];

  const importExportRe = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
  let match: RegExpExecArray | null = importExportRe.exec(source);
  while (match !== null) {
    matches.push({ specifier: match[1]!, index: match.index });
    match = importExportRe.exec(source);
  }

  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  match = dynamicImportRe.exec(source);
  while (match !== null) {
    matches.push({ specifier: match[1]!, index: match.index });
    match = dynamicImportRe.exec(source);
  }

  return matches;
};

const lineFromIndex = (source: string, index: number): number => source.slice(0, index).split("\n").length;

/**
 * An app may only import @k2b/cloud subpaths that the package actually
 * exports. Validating the first path segment is not enough: the tsconfig
 * `paths` aliases are broader than the exports map, so an import can resolve
 * in the monorepo and still throw ERR_PACKAGE_PATH_NOT_EXPORTED for an npm
 * consumer. Resolve against the real map instead.
 */
const cloudSubpathAllowed = (cloudExports: Record<string, unknown>, specifier: string): boolean => {
  const subpath = specifier === "@k2b/cloud" ? "." : `.${specifier.slice("@k2b/cloud".length)}`;
  if (subpath in cloudExports) return cloudExports[subpath] !== null;
  return Object.entries(cloudExports).some(([pattern, target]) => {
    if (target === null || !pattern.endsWith("/*")) return false;
    return subpath.startsWith(pattern.slice(0, -1));
  });
};

const checkAppsBoundaries = (workspaceRoot: string, appNames: string[]): Finding[] => {
  const findings: Finding[] = [];
  const cloudExports: Record<string, unknown> = JSON.parse(
    readFileSync(join(workspaceRoot, "packages", "cloud", "package.json"), "utf8"),
  ).exports;

  for (const appName of appNames) {
    for (const file of listFiles(join(workspaceRoot, "packages", appName, "src"), sourceFilePattern)) {
      const source = readFileSync(file, "utf8");
      for (const { specifier, index } of extractSpecifiers(source)) {
        const line = lineFromIndex(source, index);

        if (/^@k2b\/cloud-(apps|core|lib|contracts)(?:\/|$)/.test(specifier)) {
          findings.push({ file, line, message: `Use @k2b/cloud/<subpath> imports, not old hyphenated package names (${specifier}).` });
          continue;
        }

        if (specifier === "@config") {
          findings.push({ file, line, message: "Use @k2b/cloud/config instead of @config." });
          continue;
        }

        if (specifier.includes("../cloud/src") || specifier.includes("../../cloud/")) {
          findings.push({ file, line, message: `Do not import cloud package via filesystem paths from apps (${specifier}).` });
          continue;
        }

        // Each app is its own container: share via /integration contracts or HTTP, never direct imports.
        const otherAppMatch = specifier.match(/^@k2b\/cloud-app-([a-z0-9-]+)/);
        if (otherAppMatch && otherAppMatch[1] !== appName) {
          if (/^@k2b\/cloud-app-[a-z0-9-]+\/integration$/.test(specifier)) continue;
          if (appName === "cloud-cli" && /^@k2b\/cloud-app-[a-z0-9-]+\/cli$/.test(specifier)) continue;
          findings.push({
            file,
            line,
            message: `Cross-app imports are forbidden except side-effect-free /integration contracts. Use HTTP between app runtimes (${specifier}).`,
          });
          continue;
        }

        if (specifier.startsWith("@k2b/cloud") && !specifier.startsWith("@k2b/cloud-") && !cloudSubpathAllowed(cloudExports, specifier)) {
          findings.push({
            file,
            line,
            message: `Invalid @k2b/cloud subpath ${specifier}. Allowed: see the exports map in packages/cloud/package.json.`,
          });
        }
      }
    }
  }

  return findings;
};

const checkUiPackageBoundaries = (workspaceRoot: string): Finding[] => {
  const findings: Finding[] = [];
  const roots = [join(workspaceRoot, "packages", "ui", "src"), join(workspaceRoot, "fixtures", "ui-ssr", "src")];

  for (const root of roots) {
    for (const file of listFiles(root, sourceFilePattern)) {
      const source = readFileSync(file, "utf8");
      for (const { specifier, index } of extractSpecifiers(source)) {
        if (
          specifier.startsWith("@k2b/cloud") ||
          specifier.startsWith("@k2b/cloud-app-") ||
          specifier.includes("../cloud/") ||
          specifier.includes("../../cloud/")
        ) {
          findings.push({
            file,
            line: lineFromIndex(source, index),
            message: `@k2b/ui and its standalone fixture must not depend on Cloud packages (${specifier}).`,
          });
        }
      }
    }
  }

  return findings;
};

/** contracts/shared must stay app-agnostic. */
const checkContractsSharedDrift = (workspaceRoot: string): Finding[] => {
  const sharedFile = join(workspaceRoot, "packages", "cloud", "src", "contracts", "shared.ts");
  if (!existsSync(sharedFile)) return [];

  const lines = readFileSync(sharedFile, "utf8").split("\n");
  const forbiddenPrefixes = ["Space", "File", "OAuth", "ProxyAuth", "Faq", "Terms", "Log"];
  const findings: Finding[] = [];
  const exportNameRe = /^export\s+(?:const|type)\s+([A-Za-z0-9_]+)/;

  for (const [index, line] of lines.entries()) {
    const match = line.match(exportNameRe);
    if (!match) continue;
    const symbol = match[1]!;
    if (!forbiddenPrefixes.some((prefix) => symbol.startsWith(prefix))) continue;
    findings.push({
      file: sharedFile,
      line: index + 1,
      message: `contracts/shared must stay app-agnostic. Move ${symbol} to the owning app's contracts.ts.`,
    });
  }

  return findings;
};

/**
 * A CLI command that branches on `output === "json"` but never mentions
 * "jsonl" silently prints a text table under `--jsonl`. Use `printRows` /
 * `printStructured` from `@k2b/cloud/cli`, or cover all three modes locally.
 */
const checkCliOutputModes = (workspaceRoot: string, appNames: string[]): Finding[] => {
  const findings: Finding[] = [];

  for (const appName of appNames) {
    for (const file of listFiles(join(workspaceRoot, "packages", appName, "src"), sourceFilePattern)) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes('options.output === "json"')) continue;
      if (source.includes('options.output === "jsonl"')) continue;
      if (source.includes("printStructured") || source.includes("printRows")) continue;

      const line = source.split("\n").findIndex((l) => l.includes('options.output === "json"')) + 1;
      findings.push({
        file,
        line,
        message: "CLI output branches on json but never handles jsonl. Use printRows/printStructured from @k2b/cloud/cli.",
      });
    }
  }

  return findings;
};

/**
 * `c.get("user")` is the pre-service-account path: typed `User` but
 * `undefined` for a resource-bound principal. Apps read `c.get("actor")` and
 * `c.get("accessSubject")`; derive the user with `expectUserBackedActor`.
 * Core owns the auth surface and stays exempt.
 */
const checkActorUsage = (workspaceRoot: string, appNames: string[]): Finding[] => {
  const findings: Finding[] = [];

  for (const appName of appNames) {
    if (appName === "core") continue;
    for (const file of listFiles(join(workspaceRoot, "packages", appName, "src"), sourceFilePattern)) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes('get("user")')) return;
        findings.push({
          file,
          line: index + 1,
          message: "Apps authorize through actor/accessSubject. For the acting user use expectUserBackedActor from @k2b/cloud/server.",
        });
      });
    }
  }

  return findings;
};

export const rule: Rule = {
  name: "boundaries",
  description: "Package import boundaries, contracts/shared drift, CLI output modes, and actor usage",
  run: async ({ workspaceRoot }) => {
    const appNames = packageIds(workspaceRoot).filter(
      (name) => name !== "cloud" && name !== "ui" && existsSync(join(workspaceRoot, "packages", name, "src")),
    );
    return [
      ...checkAppsBoundaries(workspaceRoot, appNames),
      ...checkUiPackageBoundaries(workspaceRoot),
      ...checkContractsSharedDrift(workspaceRoot),
      ...checkCliOutputModes(workspaceRoot, appNames),
      ...checkActorUsage(workspaceRoot, appNames),
    ];
  },
};
