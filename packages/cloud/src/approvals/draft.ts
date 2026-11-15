import { fetchAppAction } from "../browser/app-actions";
import { ApprovalDraftInputSchema, type ApprovalDraftResult, ApprovalDraftResultSchema } from "../contracts/approvals";

/** Submit values only; Cloud derives editable fields and the current action from the stored request. */
export async function editApprovalDraft(id: string, values: Record<string, string>, digest: string): Promise<ApprovalDraftResult> {
  const response = await fetchAppAction(`/api/approvals/${encodeURIComponent(id)}/draft`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(ApprovalDraftInputSchema.parse({ values, digest })),
  });
  const body: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      body && typeof body === "object" && "message" in body && typeof body.message === "string"
        ? body.message
        : "Draft editing failed. Reload the approval and retry.",
    );
  return ApprovalDraftResultSchema.parse(body);
}

export type AiEditDraftHandler = (
  request: { turnId: string; callId: string; requestId: string },
  values: Record<string, string>,
  digest: string,
) => Promise<ApprovalDraftResult>;
