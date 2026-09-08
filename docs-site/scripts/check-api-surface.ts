import { resolve } from "node:path";

export const packageSpecifier = (packageName: string, exportPath: string) =>
  exportPath === "." ? packageName : `${packageName}${exportPath.slice(1)}`;

export const documentedPackageSpecifiers = (packageName: string, reference: string): Set<string> =>
  new Set(
    [...reference.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)]
      .map((match) => match[1])
      .filter((specifier) => specifier === packageName || specifier.startsWith(`${packageName}/`)),
  );

export const undocumentedExports = (packageName: string, exports: Record<string, unknown>, reference: string): string[] => {
  const documented = documentedPackageSpecifiers(packageName, reference);
  return Object.keys(exports)
    .map((exportPath) => packageSpecifier(packageName, exportPath))
    .filter((specifier) => !documented.has(specifier));
};

export const unguidedSpecializedEntryPoints = (reference: string): string[] => {
  const section = reference.match(/## Specialized entry points\s+([\s\S]*?)(?=\n## |\s*$)/)?.[1] ?? "";
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|$/gm)]
    .filter(([, , status]) => /^(Supported|Specialized)\b/.test(status.trim()))
    .filter(([, , , , guide]) => !/\]\(\/en\/docs(?:\/[^)\s]*)?\)/.test(guide))
    .map(([, specifier]) => specifier);
};

if (import.meta.main) {
  const workspaceRoot = resolve(import.meta.dir, "../..");
  const packageJson = await Bun.file(resolve(workspaceRoot, "packages/cloud/package.json")).json();
  const referenceRoot = resolve(workspaceRoot, "docs-site/docs/en/reference");
  const reference = await Bun.file(resolve(referenceRoot, "api-surface.md")).text();
  const missing = undocumentedExports("@k2b/cloud", packageJson.exports, reference);
  const unguided = unguidedSpecializedEntryPoints(reference);

  if (missing.length > 0) {
    console.error(`Cloud package exports missing from the API reference:\n${missing.map((specifier) => `- ${specifier}`).join("\n")}`);
    process.exit(1);
  }

  if (unguided.length > 0) {
    console.error(
      `Supported specialized entry points without a feature guide:\n${unguided.map((specifier) => `- ${specifier}`).join("\n")}`,
    );
    process.exit(1);
  }

  console.log(`API surface check passed (${Object.keys(packageJson.exports).length} exports classified).`);
}
