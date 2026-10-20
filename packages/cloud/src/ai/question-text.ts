/**
 * The plain-text form of an Assistant question, the same one the chat card shows: for `cld`, notifications, and Cloud
 * Login. Pure and browser-safe, in its own entry so neither the CLI bundle nor browser bundles that use
 * `@k2b/cloud/ai/browser` pull it in by accident.
 */
export { type ApprovalCardInput, approvalCard } from "../approvals/approval-card";
export type { ActionCard } from "./chat/action-card";
export { type ActionQuestionText, type ActionTextRow, actionCardText, actionQuestionLines } from "./chat/action-text";
