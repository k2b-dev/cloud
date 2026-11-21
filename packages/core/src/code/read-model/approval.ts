import type { CodePolicyRow } from "../policy-contracts";
import { codeReadModelMessages } from "./messages";
export function approvalReason(row: CodePolicyRow, locale: string) {
  const { t } = codeReadModelMessages.resolve([locale]);
  switch (row) {
    case "read":
      return t.approval_read;
    case "silent_you":
      return t.approval_silent_you;
    case "silent_draft":
      return t.approval_silent_draft;
    case "silent_shared":
      return t.approval_silent_shared;
    case "ai_chat_you":
    case "ai":
      return t.approval_ai;
    case "internet":
      return t.approval_internet;
    case "public_routes":
      return t.approval_public_routes;
    case "owner_data":
      return t.approval_owner_data;
    default:
      return t.approval_silent_shared;
  }
}
