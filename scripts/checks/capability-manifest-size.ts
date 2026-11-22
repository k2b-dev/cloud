import { join } from "node:path";
import { compileCapabilities, MAX_CAPABILITY_MANIFEST_BYTES } from "../../packages/cloud/src/_internal/capabilities";
import type { CapabilityDefinitions, CapabilityManifest } from "../../packages/cloud/src/contracts/capabilities";
import { packageIds } from "../workspace";
import { declarationOf } from "./capability-presentation";
import type { Rule } from "./rule";

/**
 * Room every app keeps below the registry's manifest limit. The limit fails `app.start()`; this margin
 * warns while the largest single operation in the repository (about 23 KB) still fits, so the PR that
 * crosses it can shrink the manifest instead of meeting a hard failure.
 */
export const CAPABILITY_MANIFEST_MARGIN_BYTES = 24 * 1024;

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const format = (value: number): string => value.toLocaleString("en-US");

/** The manifest's largest entries, so a finding names the part that grew. */
export const largestManifestParts = (manifest: CapabilityManifest, count = 5): Array<{ part: string; bytes: number }> =>
  (["types", "queries", "actions", "commands", "events", "subscribes"] as const)
    .flatMap((kind) =>
      (manifest[kind] ?? []).map((entry) => ({
        part: `${kind} ${"localId" in entry ? entry.localId : `${entry.type}@${entry.version}`}`,
        bytes: bytes(entry),
      })),
    )
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, count);

/** A message when the manifest leaves less than the margin below the limit. */
export const capabilityManifestSizeIssue = (
  manifest: CapabilityManifest,
  limit = MAX_CAPABILITY_MANIFEST_BYTES,
  margin = CAPABILITY_MANIFEST_MARGIN_BYTES,
): string | undefined => {
  const size = bytes(manifest);
  if (size <= limit - margin) return undefined;
  const parts = largestManifestParts(manifest)
    .map((part) => `${part.part} ${format(part.bytes)} B`)
    .join(", ");
  return `${manifest.appId} capability manifest is ${format(size)} B, ${format(limit - size)} B below the ${format(limit)} B registry limit; keep ${format(margin)} B free by sharing repeated schemas under $defs or shortening entries. Largest: ${parts}`;
};

export const rule: Rule = {
  name: "capability-manifest-size",
  description: "Keep every app's capability manifest a margin below the registry limit",
  run: async ({ workspaceRoot }) => {
    const findings = [];
    for (const appId of packageIds(workspaceRoot)) {
      const declaration = declarationOf(join(workspaceRoot, "packages", appId, "src"));
      if (!declaration) continue;
      if (declaration instanceof Error) throw declaration;
      const loaded: Record<string, CapabilityDefinitions | undefined> = await import(declaration.file);
      const definitions = loaded[declaration.exportName];
      if (!definitions) throw new Error(`${declaration.exportName} is not exported`);
      const issue = capabilityManifestSizeIssue(compileCapabilities(appId, definitions).manifest);
      if (issue) findings.push({ file: declaration.file, message: issue });
    }
    return findings;
  },
};
