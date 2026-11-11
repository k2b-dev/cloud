import { getCapabilityCatalogApp } from "@k2b/cloud/capabilities/server";
import type { CapabilityManifest } from "@k2b/cloud/contracts";
import { logger } from "@k2b/cloud/services";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { codeChatSdkView } from "./chat-sdk";
import { effectiveCodePolicy } from "./policy";
import type { CodePolicyRow, CodePolicyValue } from "./policy-contracts";

/** One app's part of Gustav's `code_sdk` index, with the reader's own policy value instead of the classification. */
export type CodeHelpReference = {
  /** The SDK module export, or null when the app offers Code nothing. */
  export: string | null;
  operations: { path: string; kind: "query" | "action"; policy: CodePolicyValue; description: string }[];
  events: { type: string; subject: string; place: string | null; description: string }[];
};
/** One app's part of the `code_sdk` index: methods still carry their policy classification. */
export type CodeHelpIndex = Omit<CodeHelpReference, "operations"> & {
  operations: (Omit<CodeHelpReference["operations"][number], "policy"> & { policy: CodePolicyRow })[];
};

/**
 * People who can write Code: a signed-in member with a credential that may write Code. Guests see Code pages only,
 * so the reference is not for them.
 */
export function canAuthorCode(context: CodeContext): boolean {
  try {
    return codePerson(context, true).profile !== "guest";
  } catch (error) {
    if (error instanceof CodeDataError) return false;
    throw error;
  }
}

/**
 * The app's operations and events exactly as `code_sdk` lists them: the same index function over the same catalog
 * manifest. One app's index does not depend on other apps, so only that app's declarations are generated.
 */
export function codeHelpIndex(appId: string, manifests: readonly CapabilityManifest[]): CodeHelpIndex {
  const index = codeChatSdkView(
    manifests.filter((manifest) => manifest.appId === appId),
    { mode: "personal" },
  );
  if (index.kind !== "index") throw new Error("code_sdk returned declarations instead of the index");
  const app = index.apps[0];
  return { export: app?.export ?? null, operations: app?.methods ?? [], events: index.events };
}

/** Replace each classification with the reader's effective value for personal Code. */
export function withCodePolicy(index: CodeHelpIndex, policy: readonly { row: CodePolicyRow; value: CodePolicyValue }[]): CodeHelpReference {
  const values = new Map(policy.map((entry) => [entry.row, entry.value]));
  // A classification without an effective row cannot run; the policy table covers every row.
  return { ...index, operations: index.operations.map((method) => ({ ...method, policy: values.get(method.policy) ?? "never" })) };
}

/**
 * The Code section of an app's Help: null for people who cannot write Code, "failed" when the catalog entry or the
 * policy could not be read. Visibility only; every call is still checked when Code runs.
 */
export async function loadCodeHelpReference(appId: string, context: CodeContext): Promise<CodeHelpReference | "failed" | null> {
  if (!canAuthorCode(context)) return null;
  try {
    // The catalog entry of this one app: the same authority, presentation, and person-visible filters as the catalog
    // pages code_sdk reads, without the other apps or their event subscribers.
    const entry = await getCapabilityCatalogApp(appId, context.locale, context.authority);
    if (!entry.ok) throw new Error(entry.error.message);
    const index = codeHelpIndex(appId, entry.data ? [entry.data.manifest] : []);
    // Events and the empty state need no policy; only operation labels do.
    if (!index.operations.length) return withCodePolicy(index, []);
    const { rows } = await effectiveCodePolicy({}, context);
    return withCodePolicy(index, rows);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    logger("core:code-help").warn("Code help reference unavailable", {
      appId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
