import type { CapabilityManifest } from "@k2b/cloud/contracts";
import { logger } from "@k2b/cloud/services";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { loadCodeSdkManifests } from "./authoring-check";
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
 * The app's operations and events exactly as `code_sdk` lists them: the same manifests and the same index function.
 * The index of one app does not depend on other apps, so only that app's declarations are generated.
 */
export function codeHelpReference(
  appId: string,
  manifests: readonly CapabilityManifest[],
  policy: readonly { row: CodePolicyRow; value: CodePolicyValue }[],
): CodeHelpReference {
  const index = codeChatSdkView(
    manifests.filter((manifest) => manifest.appId === appId),
    { mode: "personal" },
  );
  if (index.kind !== "index") throw new Error("code_sdk returned declarations instead of the index");
  const app = index.apps[0];
  const values = new Map(policy.map((entry) => [entry.row, entry.value]));
  return {
    export: app?.export ?? null,
    // A classification without an effective row cannot run; the policy table covers every row.
    operations: (app?.methods ?? []).map((method) => ({ ...method, policy: values.get(method.policy) ?? "never" })),
    events: index.events,
  };
}

/**
 * The Code section of an app's Help: null for people who cannot write Code, "failed" when the catalog or the policy
 * could not be read. Visibility only; every call is still checked when Code runs.
 */
export async function loadCodeHelpReference(appId: string, context: CodeContext): Promise<CodeHelpReference | "failed" | null> {
  if (!canAuthorCode(context)) return null;
  try {
    const manifests = (await loadCodeSdkManifests(context)).filter((manifest) => manifest.appId === appId);
    // Without operations there is no policy to show; the empty state needs no policy read.
    if (!manifests.length) return codeHelpReference(appId, [], []);
    const { rows } = await effectiveCodePolicy({}, context);
    return codeHelpReference(appId, manifests, rows);
  } catch (error) {
    if (context.signal?.aborted) throw error;
    logger("core:code-help").warn("Code help reference unavailable", {
      appId,
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}
