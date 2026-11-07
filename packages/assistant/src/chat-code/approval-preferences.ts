import type { AiApprovalPreferenceView } from "@k2b/cloud/ai";
import { coreClient } from "@k2b/cloud/clients/core";

const failure = async (response: Pick<Response, "json">, fallback: string) => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return new Error(typeof body?.message === "string" ? body.message : fallback);
};

/** Remembered approvals that apply everywhere, or only those of one chat. */
export async function listApprovalPreferences(conversation?: string): Promise<AiApprovalPreferenceView[]> {
  const response = await coreClient.ai["approval-preferences"].$get({ query: conversation ? { conversation } : {} });
  if (!response.ok) throw await failure(response, "Failed to load remembered approvals");
  return (await response.json()).approvals;
}

export async function revokeApprovalPreference(id: string): Promise<void> {
  const response = await coreClient.ai["approval-preferences"][":preferenceId"].$delete({ param: { preferenceId: id } });
  // Already gone is the outcome the person asked for.
  if (!response.ok && response.status !== 404) throw await failure(response, "Failed to revoke approval");
}

/** Revokes the approval that lets one chat read `origin` without asking. */
export async function revokeChatWebsite(conversation: string, origin: string): Promise<void> {
  const approvals = await listApprovalPreferences(conversation);
  const approval = approvals.find((entry) => entry.website?.origin === origin && entry.website.resourceId === null);
  if (approval) await revokeApprovalPreference(approval.id);
}
