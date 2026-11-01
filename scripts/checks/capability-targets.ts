import { join } from "node:path";
import { compileCapabilities } from "../../packages/cloud/src/_internal/capabilities";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
import { packageIds } from "../workspace";
import { declarationOf } from "./capability-presentation";
import type { Rule } from "./rule";

/** Reviewed input fields that do not select a provider-owned resource to mutate.
 * Keep the exception field-specific and unavailable to resource Code; new ID fields still fail.
 * See /en/docs/platform/capabilities#name-the-resource-an-operation-acts-on.
 */
const reviewedInputIds: Record<string, readonly string[]> = {
  "core.code.policy.update": ["definition.rules[].groupId"], // Installation policy content, not a group mutation.
  "gateway-ops.app-status.forget": ["appId"], // Shared app-status role addresses another application.
  "chat.discussion.post": ["ref.id"], // The discussion item Type belongs to its foreign provider.
};

/** ID-like inputs require a target unless a reviewed domain field is explicitly exempt. */
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
    .filter((action) => action.target === undefined && !action.localId.startsWith("code.access."))
    .flatMap((action) => {
      const exempt = action.code === false ? (reviewedInputIds[`${manifest.appId}.${action.localId}`] ?? []) : [];
      const fields = [...new Set(idPaths(action.inputSchema))].filter((field) => !exempt.includes(field));
      return fields.length ? [`${manifest.appId}.${action.localId}: ${fields.join(", ")}`] : [];
    });
};

/** Missing targets fail the repository gate; there is no report-only migration mode. */
export const rule: Rule = {
  name: "capability-targets",
  description: "Require targets on Actions with resource ID inputs",
  run: async ({ workspaceRoot }) => {
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
    return findings;
  },
};
