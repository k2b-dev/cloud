import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import type { CapabilityDefinitions } from "../../packages/cloud/src/contracts/capabilities";
import { packageIds } from "../workspace";
import type { Finding, Rule } from "./rule";

/** Every shipped application speaks these locales; the base presentation covers English. */
const REQUIRED_LOCALES = ["de"] as const;

type Copy = { title?: string; description?: string } | undefined;
const complete = (copy: Copy): boolean => Boolean(copy?.title && copy.description);

/**
 * The capability declaration an app passes to `app.start()`, read from `capabilities: <name>` in
 * `src/index.ts` and the module that name is imported from.
 */
const declarationOf = (srcDir: string): { file: string; exportName: string } | null | Error => {
  const index = join(srcDir, "index.ts");
  if (!existsSync(index)) return null;
  const source = readFileSync(index, "utf8");
  const exportName = /\bcapabilities:\s*([A-Za-z_$][\w$]*)\b/.exec(source)?.[1];
  if (!exportName) return null;
  const specifier = new RegExp(`import\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}\\s*from\\s*["'](\\.[^"']+)["']`).exec(source)?.[1];
  if (!specifier) return new Error(`Cannot find the import of ${exportName}; declare capabilities in a module of this app.`);
  const file = [".ts", ".tsx", "/index.ts"].map((suffix) => resolve(srcDir, specifier + suffix)).find(existsSync);
  return file ? { file, exportName } : new Error(`Cannot resolve ${specifier} for ${exportName}.`);
};

/**
 * Built-in applications present every capability to people in every shipped locale: each Type,
 * Query, Action, Command, and Universal Search tag has a translated title and description. The
 * Assistant, approvals, search, and the capability catalog show exactly these texts.
 */
export const rule: Rule = {
  name: "capability-presentation",
  description: "Built-in capability declarations translate every title and description into each shipped locale",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const appId of packageIds(workspaceRoot)) {
      const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
      if (!declaration) continue;
      if (declaration instanceof Error) {
        findings.push({ file: join(workspaceRoot, "packages", appId, "src", "index.ts"), message: declaration.message });
        continue;
      }
      const loaded = (await import(declaration.file)) as Record<string, CapabilityDefinitions | undefined>;
      const definitions = loaded[declaration.exportName];
      if (!definitions) {
        findings.push({ file: declaration.file, message: `${declaration.exportName} is not exported.` });
        continue;
      }
      const { manifest, presentation } = compileCapabilities(appId, definitions);
      for (const locale of REQUIRED_LOCALES) {
        const translation = presentation?.translations[locale];
        const missing = [
          ...manifest.types.filter((type) => !complete(translation?.types?.[type.localId])).map((type) => `type ${type.localId}`),
          ...manifest.queries.flatMap((query) => [
            ...(complete(translation?.queries?.[query.localId]) ? [] : [`query ${query.localId}`]),
            ...(query.universalSearch?.tags ?? [])
              .filter((tag) => !complete(translation?.queries?.[query.localId]?.searchTags?.[tag.tag]))
              .map((tag) => `search tag ${query.localId}#${tag.tag}`),
          ]),
          ...manifest.actions
            .filter((action) => !complete(translation?.actions?.[action.localId]))
            .map((action) => `action ${action.localId}`),
          ...manifest.commands
            .filter((command) => !complete(translation?.commands?.[command.localId]))
            .map((command) => `command ${command.localId}`),
        ];
        if (missing.length > 0) {
          findings.push({
            file: declaration.file,
            message: `presentation.translations.${locale} needs a title and description for: ${missing.join(", ")}`,
          });
        }
      }
    }
    return findings;
  },
};
