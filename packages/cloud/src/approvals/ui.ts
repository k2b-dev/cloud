/**
 * The shared list of pending Action approvals. Every app mounts the same component for its own scope; Core serves the
 * route behind it and decides through the platform's approval requests.
 */

export type { ApprovalsProps } from "./Approvals";
export { default as Approvals } from "./Approvals";
export { approvalNavCount, default as ApprovalsNavStatus } from "./ApprovalsNavStatus";
