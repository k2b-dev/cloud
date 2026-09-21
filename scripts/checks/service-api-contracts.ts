import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { packageIds } from "../workspace";
import { isDirectory, isTestFile, listFiles, sourceFilePattern } from "./files";
import type { Finding, Rule } from "./rule";

const firstIndex = (source: string, patterns: RegExp[]): number => {
  let out = -1;
  for (const pattern of patterns) {
    const match = pattern.exec(source);
    if (!match || match.index === undefined) continue;
    if (out === -1 || match.index < out) out = match.index;
  }
  return out;
};

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

const importsNamed = (source: string, specifier: string, name: string): boolean =>
  new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']${specifier}["']`).test(source);

/** Apps with their own lifecycle that do not follow the standard facade shape. */
const specialApps = new Set(["gateway", "core", "cloud-cli"]);

export const rule: Rule = {
  name: "service-api-contracts",
  description: "Application facade, service module, capability, and API conventions",
  run: async ({ workspaceRoot }) => {
    const packagesRoot = join(workspaceRoot, "packages");
    const nonAppPackages = new Set(["cloud", "ui"]);
    const appNames = packageIds(workspaceRoot).filter((name) => !nonAppPackages.has(name) && isDirectory(join(packagesRoot, name, "src")));
    const findings: Finding[] = [];
    const report = (file: string, message: string) => findings.push({ file, message });

    for (const appName of appNames) {
      const appDir = join(packagesRoot, appName, "src");
      const indexPath = join(appDir, "index.ts");
      const serviceIndexPath = join(appDir, "service", "index.ts");
      const apiDirPath = join(appDir, "api", "index.ts");
      const apiLegacyPath = join(appDir, "api.ts");
      const apiPath = existsSync(apiDirPath) ? apiDirPath : existsSync(apiLegacyPath) ? apiLegacyPath : null;

      if (!existsSync(indexPath)) {
        report(indexPath, "Missing app index.ts facade file.");
        continue;
      }

      const indexSource = readFileSync(indexPath, "utf8");
      const capabilitiesPath = join(appDir, "capabilities.ts");
      const capabilityDefinitionFiles = listFiles(appDir, sourceFilePattern).filter(
        (path) => !isTestFile(path) && /\bdefineCapabilities\s*\(/.test(readFileSync(path, "utf8")),
      );
      const wiresCapabilities = /\bcapabilities\s*:/.test(indexSource);

      for (const definitionPath of capabilityDefinitionFiles) {
        if (definitionPath !== capabilitiesPath) report(definitionPath, "Capability declarations must live in src/capabilities.ts.");
      }

      if (wiresCapabilities || capabilityDefinitionFiles.length > 0) {
        if (!existsSync(capabilitiesPath)) report(indexPath, "Apps that publish capabilities must declare them in src/capabilities.ts.");
        else if (!extractSpecifiers(indexSource).includes("./capabilities")) {
          report(indexPath, "App facade must import its capability declaration from ./capabilities.");
        }
        if (!wiresCapabilities) report(indexPath, "App facade must pass its capability declaration to app.start({ capabilities }).");
      }

      if (!specialApps.has(appName)) {
        if (!/export\s+default\s+/.test(indexSource)) report(indexPath, "App facade must export a default runtime value.");
        if (existsSync(serviceIndexPath) && !/export\s*\{[^}]*\bservice\b[^}]*\}/.test(indexSource)) {
          report(indexPath, "App with src/service/ must re-export it as 'service'.");
        }
        if (apiPath && !/export\s+type\s+\{\s*ApiType\s*\}\s+from\s+["']\.\/api/.test(indexSource)) {
          report(indexPath, "Apps with an API must re-export 'type ApiType' from ./api.");
        }
      }

      if (existsSync(serviceIndexPath)) {
        const serviceSource = readFileSync(serviceIndexPath, "utf8");
        if (/\bclass\s+\w+/.test(serviceSource)) report(serviceIndexPath, "Service modules must stay functional/stateless (no classes).");
        if (/export\s+default\s+/.test(serviceSource))
          report(serviceIndexPath, "Service modules must use named exports, not default export.");
        if (!/export\s+const\s+\w+Service\s*=\s*(?:\{|create\w*Service\s*\()/.test(serviceSource)) {
          report(serviceIndexPath, "service/index.ts must export a '*Service' facade object.");
        }
      }

      if (!apiPath || specialApps.has(appName)) continue;

      const apiSource = readFileSync(apiPath, "utf8");
      const apiSpecifiers = extractSpecifiers(apiSource);
      const hasDirectRoutes = /^\s*\.(get|post|put|patch|delete)\(/m.test(apiSource);
      const hasServerImport = apiSpecifiers.includes("@k2b/cloud/server");

      if (hasDirectRoutes && !hasServerImport) report(apiPath, "API must import from @k2b/cloud/server.");
      if (hasDirectRoutes && !/\brespond\(/.test(apiSource)) report(apiPath, "API must map service results through respond(...).");

      const firstUse = firstIndex(apiSource, [/^\s*\.use\(/gm]);
      const firstRoute = firstIndex(apiSource, [/^\s*\.get\(/gm, /^\s*\.post\(/gm, /^\s*\.put\(/gm, /^\s*\.patch\(/gm, /^\s*\.delete\(/gm]);
      if (hasDirectRoutes && firstRoute !== -1 && (firstUse === -1 || firstUse > firstRoute)) {
        report(apiPath, "Middleware should be mounted before route handlers.");
      }

      if (/\bc\.(json|html)\(/.test(apiSource))
        report(apiPath, "Prefer respond(...) and result helpers over direct c.json/c.html responses.");
      if (apiSpecifiers.some((specifier) => /^@\/(core|shared)\//.test(specifier))) {
        report(apiPath, "API must not import internal aliases (@/core or @/shared).");
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
        report(apiPath, "API must use public package surfaces, not deep filesystem imports.");
      }

      const hasRateLimitImport = hasServerImport && importsNamed(apiSource, "@k2b/cloud/server", "rateLimit");
      if (hasRateLimitImport && !/\.use\(\s*rateLimit\(/.test(apiSource)) report(apiPath, "rateLimit middleware imported but not mounted.");
      if (!hasRateLimitImport && appName !== "files") {
        report(
          apiPath,
          "App APIs should include rateLimit middleware unless explicitly exempt (files upload/thumbnail throughput exception).",
        );
      }
    }

    return findings;
  },
};
