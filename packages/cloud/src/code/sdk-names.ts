import { z } from "zod";
import {
  CapabilityAppIdSchema,
  CapabilityLocalIdSchema,
  type CapabilityManifest,
  CapabilityManifestSchema,
} from "../contracts/capabilities";
import { CodeSdkExportNameSchema, reservedCodeSdkExports } from "../contracts/code-sdk-names";
import { hasFileInput } from "./file-ref";

// Check source names before the compatibility reader can omit unreadable entries.
// The shared local-ID grammar also covers quoted property paths (including hyphens).
const sdkLocalId = CapabilityLocalIdSchema.refine((value) => !/\s/.test(value), "Use an SDK path without whitespace");
const sdkLocalName = z.object({ localId: sdkLocalId });
const sdkOperationNames = sdkLocalName.extend({
  target: sdkLocalId.optional(),
  refs: z.record(z.string().min(1).max(100), sdkLocalId).optional(),
});
const sdkManifestNames = z.object({
  sdkExportName: CodeSdkExportNameSchema.refine((name) => !reservedCodeSdkExports.has(name), "Reserved SDK export name").optional(),
  appId: CapabilityAppIdSchema.refine((value) => !/\s/.test(value), "Use an SDK app ID without whitespace"),
  types: z.array(sdkLocalName),
  queries: z.array(sdkOperationNames),
  actions: z.array(sdkOperationNames),
  commands: z.array(sdkLocalName),
  events: z.array(sdkLocalName.extend({ subject: sdkLocalId, place: sdkLocalId.optional() })).optional(),
});

export const sdkPath = (value: string): string[] =>
  value.split(".").map((segment) => {
    if (forbiddenProperties.has(segment)) throw new Error(`SDK path collision at ${segment}`);
    return segment.replace(/[-_]+([a-zA-Z0-9])/g, (_, char: string) => char.toUpperCase());
  });
const forbiddenProperties = new Set(["__proto__", "prototype", "constructor"]);
export const codeSdkExportName = (appId: string): string => {
  const name = appId.replaceAll("-", "_");
  if (!/^[a-z][a-z0-9_]*$(?![\s\S])/.test(name)) throw new Error("Use a valid SDK app identifier");
  return reservedCodeSdkExports.has(name) ? `_${name}` : name;
};

/** Validate names before publishing an app, and again before SDK generation. No declarations or runtime are generated here. */
export function validateCodeSdkNames(manifests: readonly CapabilityManifest[]): CapabilityManifest[] {
  const apps = manifests
    .map((value) => {
      sdkManifestNames.parse(value);
      return CapabilityManifestSchema.parse(value);
    })
    .sort((a, b) => a.appId.localeCompare(b.appId));
  if (new Set(apps.map((app) => app.appId)).size !== apps.length) throw new Error("Duplicate SDK app ID");
  const exports = new Set<string>();
  for (const app of apps) {
    const name = app.sdkExportName ?? codeSdkExportName(app.appId);
    if (exports.has(name)) throw new Error(`${app.appId}: SDK export name collision`);
    exports.add(name);
    const mapped = new Map<string, string>();
    const registerPath = (namespace: string | null, raw: string) => {
      const rawSegments = raw.split(".");
      const segments = sdkPath(raw);
      if (["id", "type"].includes(segments[0] ?? "")) throw new Error(`${app.appId}.${raw}: SDK path collision with handle identity`);
      for (let length = 1; length <= segments.length; length++) {
        const key = JSON.stringify([namespace, segments.slice(0, length)]);
        const original = rawSegments.slice(0, length).join(".");
        if (mapped.has(key) && mapped.get(key) !== original) throw new Error(`${app.appId}.${raw}: SDK path collision`);
        mapped.set(key, original);
      }
    };
    const ids = [...app.types, ...app.queries, ...app.actions, ...app.commands].map((entry) => entry.localId);
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) throw new Error(`${app.appId}.${duplicate}: SDK path collision (duplicate capability local ID)`);
    for (const type of app.types) registerPath(null, type.localId);
    const methods = new Set<string>();
    for (const op of [...app.queries, ...app.actions]) {
      if (
        (op.stream?.direction === "write" && !hasFileInput(op.inputSchema)) ||
        ("code" in op && op.code === false) ||
        ("appOnly" in op && op.appOnly)
      )
        continue;
      const raw = op.target && op.localId.startsWith(`${op.target}.`) ? op.localId.slice(op.target.length + 1) : op.localId;
      registerPath(op.target ?? null, raw);
      const key = JSON.stringify([op.target ?? null, sdkPath(raw)]);
      if (methods.has(key)) throw new Error(`${app.appId}.${op.localId}: SDK path collision`);
      methods.add(key);
    }
  }
  return apps;
}
