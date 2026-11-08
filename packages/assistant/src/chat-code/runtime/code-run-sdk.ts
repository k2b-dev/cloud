import { listCapabilityCatalog } from "@k2b/cloud/capabilities/server";
import { CODE_CHECK_LIMITS, generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityManifest } from "@k2b/cloud/contracts";
import type { RequestAuthority } from "@k2b/cloud/server";

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
    manifests.push(...result.data.apps.map((app) => app.manifest));
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
