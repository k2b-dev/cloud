import { join } from "node:path";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
import { packageIds } from "../workspace";
import { declarationOf } from "./capability-presentation";
import type { Rule } from "./rule";

/** Candidate resource IDs: a migration report, not proof that a domain field grants access. */
export const capabilityTargetGaps = (manifest: CapabilityManifest): string[] => {
  const idPaths = (schema: unknown, prefix = ""): string[] => {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
    return Object.entries(schema).flatMap(([key, value]) => {
      if (key === "items") return idPaths(value, `${prefix}[]`);
      if (["anyOf", "oneOf", "allOf"].includes(key) && Array.isArray(value)) return value.flatMap((part) => idPaths(part, prefix));
      if (key !== "properties" || !value || typeof value !== "object" || Array.isArray(value)) return [];
      return Object.entries(value).flatMap(([name, field]) => {
        const path = prefix ? `${prefix}.${name}` : name;
        return /^(id|ids)$|(?:Id|Ids|_id|_ids)$/.test(name) ? [path] : idPaths(field, path);
      });
    });
  };
  return manifest.actions
    .filter((action) => action.target === undefined)
    .flatMap((action) => {
      const fields = [...new Set(idPaths(action.inputSchema))];
      return fields.length ? [`${manifest.appId}.${action.localId}: ${fields.join(", ")}`] : [];
    });
};

/** C0 additive migration: report the gaps until every application has moved to explicit targets. */
export const rule: Rule = {
  name: "capability-targets",
  description: "Report Actions with resource ID inputs but no declared target (additive migration)",
  run: async ({ workspaceRoot, flags }) => {
    const findings = [];
    for (const appId of packageIds(workspaceRoot)) {
      const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
      if (!declaration) continue;
      if (declaration instanceof Error) throw declaration;
      const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
      const definitions = loaded[declaration.exportName];
      if (!definitions) throw new Error(`${declaration.exportName} is not exported`);
      for (const gap of capabilityTargetGaps(compileCapabilities(appId, definitions).manifest))
        findings.push({ file: declaration.file, message: `Action needs a target: ${gap}` });
    }
    // C0f removes report-only mode after C0b–C0g. --enforce-targets supports migration checks now.
    if (flags.has("--enforce-targets")) return findings;
    if (findings.length)
      console.info(`Capability target migration gaps (${findings.length}):\n${findings.map((item) => `  ${item.message}`).join("\n")}`);
    return [];
  },
};
