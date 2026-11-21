/**
 * The shared list of pending Action approvals. Every app mounts the same component for its own scope; Core serves the
 * route behind it and decides through the platform's approval requests. `ApprovalDetails` draws what one approval is
 * about, exactly as the approval card does, for a confirmation an app asks itself. `ApprovalFrame` is the drawing part
 * of every approval; a Code version or an admin review fills it with its own sentence, details, and answers.
 */

export { ActionDetails as ApprovalDetails } from "../ai/chat/action-details";
export type { ApprovalDraftResult } from "../contracts/approvals";
export {
  ApprovalFrame,
  type ApprovalFrameAction,
  type ApprovalFrameProps,
  type ApprovalFrameState,
  type ApprovalFrameStatus,
} from "./ApprovalFrame";
export type { ApprovalsProps } from "./Approvals";
export { default as Approvals } from "./Approvals";
export { approvalNavCount, default as ApprovalsNavStatus } from "./ApprovalsNavStatus";
export type { AiEditDraftHandler } from "./draft";
export { editApprovalDraft } from "./draft";
