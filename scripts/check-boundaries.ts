import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Violation = {
  file: string;
  line: number;
  specifier: string;
  message: string;
};

const workspaceRoot = join(import.meta.dir, "..");

const readFiles = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      readFiles(path, out);
      continue;
    }
    if (path.endsWith(".ts") || path.endsWith(".tsx")) out.push(path);
  }
  return out;
};

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
 * An app may only import @k2b/cloud subpaths that the package
 * actually exports. Validating the first path segment is not enough: the
 * tsconfig `paths` aliases are broader than the exports map, so an import can
 * resolve in the monorepo and still throw ERR_PACKAGE_PATH_NOT_EXPORTED for an
 * npm consumer. Resolve against the real map instead.
 */
const cloudExports: Record<string, unknown> = JSON.parse(
  readFileSync(join(workspaceRoot, "packages", "cloud", "package.json"), "utf8"),
).exports;

const allowedCloudSubpath = (specifier: string): boolean => {
  const subpath = specifier === "@k2b/cloud" ? "." : `.${specifier.slice("@k2b/cloud".length)}`;

  if (subpath in cloudExports) return cloudExports[subpath] !== null;

  return Object.entries(cloudExports).some(([pattern, target]) => {
    if (target === null || !pattern.endsWith("/*")) return false;
    return subpath.startsWith(pattern.slice(0, -1));
  });
};

const allowedSubpathList = "see the exports map in packages/cloud/package.json";

const APP_PACKAGE_NAMES = readdirSync(join(workspaceRoot, "packages")).filter(
  (name) => name !== "cloud" && name !== "ui" && existsSync(join(workspaceRoot, "packages", name, "src")),
);

const checkAppsBoundaries = (): Violation[] => {
  const violations: Violation[] = [];

  for (const appName of APP_PACKAGE_NAMES) {
    const srcRoot = join(workspaceRoot, "packages", appName, "src");
    const files = readFiles(srcRoot);

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const { specifier, index } of extractSpecifiers(source)) {
        const line = lineFromIndex(source, index);

        // Forbid old-style package imports
        if (/^@k2b\/cloud-(apps|core|lib|contracts)(?:\/|$)/.test(specifier)) {
          violations.push({
            file,
            line,
            specifier,
            message: "Use @k2b/cloud/<subpath> imports, not old hyphenated package names.",
          });
          continue;
        }

        // Forbid old aliased paths
        if (specifier === "@config") {
          violations.push({
            file,
            line,
            specifier,
            message: "Use @k2b/cloud/config instead of @config.",
          });
          continue;
        }

        // Forbid filesystem cross-package imports (siblings)
        if (specifier.includes("../cloud/src") || specifier.includes("../../cloud/")) {
          violations.push({
            file,
            line,
            specifier,
            message: "Do not import cloud package via filesystem paths from apps.",
          });
          continue;
        }

        // Forbid importing another app's @k2b/cloud-app-* package.
        // Each app is its own container — share via cloud-lib services, not direct imports.
        const otherAppMatch = specifier.match(/^@k2b\/cloud-app-([a-z0-9-]+)/);
        if (otherAppMatch && otherAppMatch[1] !== appName) {
          if (/^@k2b\/cloud-app-[a-z0-9-]+\/integration$/.test(specifier)) {
            continue;
          }
          if (appName === "cloud-cli" && /^@k2b\/cloud-app-[a-z0-9-]+\/cli$/.test(specifier)) {
            continue;
          }
          violations.push({
            file,
            line,
            specifier,
            message: "Cross-app imports are forbidden except side-effect-free /integration contracts. Use HTTP between app runtimes.",
          });
          continue;
        }

        // Validate @k2b/cloud subpaths
        if (
          specifier.startsWith("@k2b/cloud") &&
          !specifier.startsWith("@k2b/cloud-") &&
          !allowedCloudSubpath(specifier)
        ) {
          violations.push({
            file,
            line,
            specifier,
            message: `Invalid @k2b/cloud subpath. Allowed: ${allowedSubpathList}.`,
          });
        }
      }
    }
  }

  return violations;
};

const checkUiPackageBoundaries = (): Violation[] => {
  const violations: Violation[] = [];
  const roots = [join(workspaceRoot, "packages", "ui", "src"), join(workspaceRoot, "fixtures", "ui-ssr", "src")];

  for (const root of roots) {
    for (const file of readFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const { specifier, index } of extractSpecifiers(source)) {
        if (
          specifier.startsWith("@k2b/cloud") ||
          specifier.startsWith("@k2b/cloud-app-") ||
          specifier.includes("../cloud/") ||
          specifier.includes("../../cloud/")
        ) {
          violations.push({
            file,
            line: lineFromIndex(source, index),
            specifier,
            message: "@k2b/ui and its standalone fixture must not depend on Cloud packages.",
          });
        }
      }
    }
  }

  return violations;
};

const violations = [...checkAppsBoundaries(), ...checkUiPackageBoundaries()];

// Check contracts/shared doesn't have app-domain symbols
const checkContractsSharedDrift = (): Violation[] => {
  const sharedFile = join(workspaceRoot, "packages", "cloud", "src", "contracts", "shared.ts");
  if (!existsSync(sharedFile)) return [];

  const source = readFileSync(sharedFile, "utf8");
  const lines = source.split("\n");
  const forbiddenPrefixes = ["Space", "File", "OAuth", "ProxyAuth", "Faq", "Terms", "Log"];
  const violations: Violation[] = [];

  const exportNameRe = /^export\s+(?:const|type)\s+([A-Za-z0-9_]+)/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const match = line.match(exportNameRe);
    if (!match) continue;

    const symbol = match[1]!;
    if (!forbiddenPrefixes.some((prefix) => symbol.startsWith(prefix))) continue;

    violations.push({
      file: sharedFile,
      line: i + 1,
      specifier: symbol,
      message: "contracts/shared must stay app-agnostic. Move app-domain symbols to owning app contracts.ts.",
    });
  }

  return violations;
};

violations.push(...checkContractsSharedDrift());

/**
 * A CLI command that branches on `output === "json"` but never mentions
 * "jsonl" silently prints a text table under `--jsonl`, which is a wrong
 * answer rather than an error for anything consuming the output.
 *
 * Use `printRows` / `printStructured` from `@k2b/cloud/cli`. A local
 * helper is still fine as long as it covers all three modes.
 */
const checkCliOutputModes = (): Violation[] => {
  const violations: Violation[] = [];

  for (const appName of APP_PACKAGE_NAMES) {
    for (const file of readFiles(join(workspaceRoot, "packages", appName, "src"))) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      if (!source.includes('options.output === "json"')) continue;
      if (source.includes('options.output === "jsonl"')) continue;
      if (source.includes("printStructured") || source.includes("printRows")) continue;

      const line = source.split("\n").findIndex((l) => l.includes('options.output === "json"')) + 1;
      violations.push({
        file,
        line,
        specifier: 'options.output === "json"',
        message: "CLI output branches on json but never handles jsonl. Use printRows/printStructured from @k2b/cloud/cli.",
      });
    }
  }

  return violations;
};

violations.push(...checkCliOutputModes());

/**
 * `c.get("user")` is the pre-service-account path. It is typed `User` but is
 * `undefined` for a resource-bound principal, so a check written against it
 * compiles, passes review, and silently excludes API keys and OAuth service
 * tokens — or dereferences undefined in production.
 *
 * Apps read `c.get("actor")` and `c.get("accessSubject")` instead. When a
 * feature genuinely needs the user — roles, display name — derive it from the
 * actor with `expectUserBackedActor` / `userFromActor`.
 */
const checkActorUsage = (): Violation[] => {
  const violations: Violation[] = [];

  for (const appName of APP_PACKAGE_NAMES) {
    // core owns the auth surface and the personal /me pages — it is the
    // compatibility layer this rule exists to keep everyone else out of.
    if (appName === "core") continue;

    for (const file of readFiles(join(workspaceRoot, "packages", appName, "src"))) {
      if (file.endsWith(".test.ts") || file.endsWith(".test.tsx")) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes('get("user")')) return;
        violations.push({
          file,
          line: index + 1,
          specifier: 'c.get("user")',
          message:
            "Apps authorize through actor/accessSubject. For the acting user use expectUserBackedActor from @k2b/cloud/server.",
        });
      });
    }
  }

  return violations;
};

violations.push(...checkActorUsage());

if (violations.length > 0) {
  console.error("Boundary check failed:\n");
  for (const violation of violations) {
    console.error(`- ${relative(workspaceRoot, violation.file)}:${violation.line} ${violation.message} (${violation.specifier})`);
  }
  process.exit(1);
}

console.log("Boundary check passed.");
