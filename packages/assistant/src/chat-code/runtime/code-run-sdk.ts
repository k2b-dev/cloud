import { listCapabilityCatalog, normalizeCapabilityCall } from "@k2b/cloud/capabilities/server";
import type { CodeSdkManifest } from "@k2b/cloud/code";
import { CODE_CHECK_LIMITS, generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityManifest } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";
import { z } from "zod";
import { CloudError } from "./errors";
import type { RuntimeSdkCallOptions } from "./services";

/** One-off scripts have no version decision. Their run's authorized catalog bounds
 * possible calls; the turn host still reviews each actual Action and current access.
 */
export function requireCodeRunCapability(manifest: CodeSdkManifest, name: string, input: unknown, coordinates?: RuntimeSdkCallOptions) {
  const operation = manifest.operations.find((operation) => operation.capability === name);
  if (!operation) throw new CloudError("denied", "code_capability_undeclared");
  const definition = {
    localId: operation.localId,
    ...(operation.target ? { target: operation.target.slice(operation.appId.length + 1) } : {}),
    refs: Object.fromEntries(Object.entries(operation.refs).map(([field, type]) => [field, type.slice(operation.appId.length + 1)])),
  };
  if (coordinates?.target !== undefined || coordinates?.refs !== undefined)
    return normalizeCapabilityCall(operation.appId, definition, { input, target: coordinates.target, refs: coordinates.refs });
  // Legacy cloud.capabilities.run uses flat target/ref fields. Normalize against
  // the admitted snapshot before the live turn service can execute anything.
  const data = { ...z.record(z.string(), z.unknown()).parse(input) };
  const refs = Object.fromEntries(
    Object.entries(operation.refs).map(([field, type]) => {
      const id = z.string().min(1).parse(data[field]);
      delete data[field];
      return [field, { type, id }];
    }),
  );
  const target = definition.target ? { type: operation.target!, id: z.string().min(1).parse(data[definition.target]) } : undefined;
  if (definition.target) delete data[definition.target];
  return normalizeCapabilityCall(operation.appId, definition, { input: data, target, refs });
}

/** One-off runs use the same catalog generator as lasting Code, under the current caller's authority. */
export async function codeRunSdk(authority: RequestAuthority | null, locale?: string, signal?: AbortSignal) {
  if (!authority) throw new Error("Code SDK requires an authenticated caller.");
  const manifests: CapabilityManifest[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  do {
    signal?.throwIfAborted();
    const result = await listCapabilityCatalog({ authority, locale, cursor, limit: 25 });
    if (!result.ok) throw new Error("Code SDK catalog unavailable. Retry the run.");
    bytes += Buffer.byteLength(JSON.stringify(result.data));
    if (bytes > CODE_CHECK_LIMITS.requestBytes) throw new Error("Code SDK exceeds the request budget.");
    manifests.push(
      ...result.data.apps.map((app) => ({
        ...app.manifest,
        actions: app.manifest.actions.filter(
          (action) => !app.manifest.types.some((type) => type.assistant?.tools.includes(action.localId)),
        ),
      })),
    );
    cursor = result.data.page.hasMore ? result.data.page.nextCursor : undefined;
  } while (cursor);
  return generateCodeSdk(manifests, { mode: "code_run" });
}

/** Inspect parsed import specifiers, so comments and ordinary strings do not add a catalog dependency. */
export function usesCodeRunSdk(files: readonly { path: string; content: string }[]): boolean {
  const parser = new Bun.Transpiler({ loader: "ts" });
  return files.some(
    (file) => /\.(?:js|ts)$/.test(file.path) && parser.scanImports(file.content).some((specifier) => specifier.path === "@sdk"),
  );
}
