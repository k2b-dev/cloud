import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

type Violation = {
  file: string;
  message: string;
};

const workspaceRoot = join(import.meta.dir, "..");
const packagesRoot = join(workspaceRoot, "packages");
const rootPackage = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")) as {
  workspaces?: { packages?: string[] };
};
const workspacePackageNames = new Set((rootPackage.workspaces?.packages ?? []).map((workspace) => workspace.replace(/^packages\//, "")));

const isDirectory = (path: string): boolean => existsSync(path) && statSync(path).isDirectory();

const listProductionTypeScriptFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listProductionTypeScriptFiles(path);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name) || /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) return [];
    return [path];
  });

// Each app lives at packages/<app>/src/ now (shared libraries are excluded).
const nonAppPackages = new Set(["cloud", "ui"]);
const appDirs = readdirSync(packagesRoot)
  .filter((name) => !nonAppPackages.has(name) && workspacePackageNames.has(name) && isDirectory(join(packagesRoot, name, "src")))
  .map((name) => join(packagesRoot, name, "src"))
  .sort();

const violations: Violation[] = [];

const firstIndex = (source: string, patterns: RegExp[]): number => {
  let out = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match || match.index === undefined) continue;
    if (out === -1 || match.index < out) out = match.index;
  }
  return out;
};

const hasMatch = (source: string, pattern: RegExp): boolean => pattern.test(source);

const extractSpecifiers = (source: string): string[] => {
  const out: string[] = [];
  const importExportRe = /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;

  let match: RegExpExecArray | null = importExportRe.exec(source);
  while (match !== null) {
    out.push(match[1]!);
    match = importExportRe.exec(source);
  }

  const dynamicImportRe = /import\(\s*["']([^"']+)["']\s*\)/g;
  match = dynamicImportRe.exec(source);
  while (match !== null) {
    out.push(match[1]!);
    match = dynamicImportRe.exec(source);
  }

  return out;
};

const importsNamed = (source: string, specifier: string, name: string): boolean => {
  const re = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${specifier}["']`);
  return re.test(source);
};

// Apps with special lifecycle patterns that don't follow standard conventions
const specialApps = new Set(["gateway", "core", "cloud-cli"]);

for (const appDir of appDirs) {
  // appDir is now packages/<app>/src — the app name is the parent folder.
  const appName = appDir.split("/").at(-2)!;
  const indexPath = join(appDir, "index.ts");
  const serviceIndexPath = join(appDir, "service", "index.ts");

  // API can be either api.ts (legacy) or api/index.ts (new)
  const apiDirPath = join(appDir, "api", "index.ts");
  const apiLegacyPath = join(appDir, "api.ts");
  const apiPath = existsSync(apiDirPath) ? apiDirPath : existsSync(apiLegacyPath) ? apiLegacyPath : null;

  if (!existsSync(indexPath)) {
    violations.push({ file: indexPath, message: "Missing app index.ts facade file." });
    continue;
  }

  const indexSource = readFileSync(indexPath, "utf8");
  const capabilitiesPath = join(appDir, "capabilities.ts");
  const capabilityDefinitionFiles = listProductionTypeScriptFiles(appDir).filter((path) =>
    /\bdefineCapabilities\s*\(/.test(readFileSync(path, "utf8")),
  );
  const wiresCapabilities = /\bcapabilities\s*:/.test(indexSource);

  for (const definitionPath of capabilityDefinitionFiles) {
    if (definitionPath !== capabilitiesPath) {
      violations.push({
        file: definitionPath,
        message: "Capability declarations must live in src/capabilities.ts.",
      });
    }
  }

  if (wiresCapabilities || capabilityDefinitionFiles.length > 0) {
    if (!existsSync(capabilitiesPath)) {
      violations.push({
        file: indexPath,
        message: "Apps that publish capabilities must declare them in src/capabilities.ts.",
      });
    } else if (!extractSpecifiers(indexSource).includes("./capabilities")) {
      violations.push({
        file: indexPath,
        message: "App facade must import its capability declaration from ./capabilities.",
      });
    }

    if (!wiresCapabilities) {
      violations.push({
        file: indexPath,
        message: "App facade must pass its capability declaration to app.start({ capabilities }).",
      });
    }
  }

  // Skip structural checks for special apps (gateway, core)
  if (!specialApps.has(appName)) {
    if (!/export\s+default\s+/.test(indexSource)) {
      violations.push({
        file: indexPath,
        message: "App facade must export a default runtime value.",
      });
    }

    // Apps with their own service folder must re-export it as 'service'.
    // Apps that consume only cloud-lib services (rule: domain-shared logic in
    // cloud-lib) don't need a service export — there's nothing to forward.
    if (existsSync(serviceIndexPath) && !/export\s*\{[^}]*\bservice\b[^}]*\}/.test(indexSource)) {
      violations.push({
        file: indexPath,
        message: "App with src/service/ must re-export it as 'service'.",
      });
    }

    if (apiPath && !/export\s+type\s+\{\s*ApiType\s*\}\s+from\s+["']\.\/api/.test(indexSource)) {
      violations.push({
        file: indexPath,
        message: "Apps with an API must re-export 'type ApiType' from ./api.",
      });
    }
  }

  if (existsSync(serviceIndexPath)) {
    const serviceSource = readFileSync(serviceIndexPath, "utf8");

    if (/\bclass\s+\w+/.test(serviceSource)) {
      violations.push({
        file: serviceIndexPath,
        message: "Service modules must stay functional/stateless (no classes).",
      });
    }

    if (/export\s+default\s+/.test(serviceSource)) {
      violations.push({
        file: serviceIndexPath,
        message: "Service modules must use named exports, not default export.",
      });
    }

    if (!/export\s+const\s+\w+Service\s*=\s*\{/.test(serviceSource)) {
      violations.push({
        file: serviceIndexPath,
        message: "service/index.ts must export a '*Service' facade object.",
      });
    }
  }

  if (!apiPath || specialApps.has(appName)) continue;

  const apiSource = readFileSync(apiPath, "utf8");
  const apiSpecifiers = extractSpecifiers(apiSource);
  const hasDirectRoutes = hasMatch(apiSource, /^\s*\.(get|post|put|patch|delete)\(/m);

  const hasServerImport = apiSpecifiers.includes("@k2b/cloud/server");

  if (hasDirectRoutes && !hasServerImport) {
    violations.push({
      file: apiPath,
      message: "API must import from @k2b/cloud/server.",
    });
  }

  if (hasDirectRoutes && !/\brespond\(/.test(apiSource)) {
    violations.push({
      file: apiPath,
      message: "API must map service results through respond(...).",
    });
  }

  const firstUse = firstIndex(apiSource, [/^\s*\.use\(/gm]);
  const firstRoute = firstIndex(apiSource, [/^\s*\.get\(/gm, /^\s*\.post\(/gm, /^\s*\.put\(/gm, /^\s*\.patch\(/gm, /^\s*\.delete\(/gm]);

  if (hasDirectRoutes && firstRoute !== -1 && (firstUse === -1 || firstUse > firstRoute)) {
    violations.push({
      file: apiPath,
      message: "Middleware should be mounted before route handlers.",
    });
  }

  if (/\bc\.(json|html)\(/.test(apiSource)) {
    violations.push({
      file: apiPath,
      message: "Prefer respond(...) and result helpers over direct c.json/c.html responses.",
    });
  }

  if (apiSpecifiers.some((specifier) => /^@\/(core|shared)\//.test(specifier))) {
    violations.push({
      file: apiPath,
      message: "API must not import internal aliases (@/core or @/shared).",
    });
  }

  if (
    apiSpecifiers.some(
      (specifier) =>
        specifier.includes("/src/") ||
        specifier.includes("../core/") ||
        specifier.includes("../lib/") ||
        specifier.includes("../contracts/") ||
        specifier.includes("../cloud/"),
    )
  ) {
    violations.push({
      file: apiPath,
      message: "API must use public package surfaces, not deep filesystem imports.",
    });
  }

  const hasRateLimitImport =
    apiSpecifiers.includes("@k2b/cloud/server") && importsNamed(apiSource, "@k2b/cloud/server", "rateLimit");

  if (hasRateLimitImport && !/\.use\(\s*rateLimit\(/.test(apiSource)) {
    violations.push({
      file: apiPath,
      message: "rateLimit middleware imported but not mounted.",
    });
  }

  if (!hasRateLimitImport && appName !== "files" && !specialApps.has(appName)) {
    violations.push({
      file: apiPath,
      message: "App APIs should include rateLimit middleware unless explicitly exempt (files upload/thumbnail throughput exception).",
    });
  }
}

if (violations.length > 0) {
  console.error("Service/API contract check failed:\n");
  for (const violation of violations) {
    console.error(`- ${relative(workspaceRoot, violation.file)} ${violation.message}`);
  }
  process.exit(1);
}

console.log("Service/API contract check passed.");
