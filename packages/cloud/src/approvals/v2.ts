/**
 * The approval list for pages built with `@k2b/ui/v2` (their layout has `ui: "v2"`). The same props, requests, answers
 * and outcomes as `Approvals` of `@k2b/cloud/approvals/ui`; it draws itself from v2 primitives as the content of the
 * page's `Pane`. A separate entry, so pages that are still v1 do not load v2.
 */
export type { ApprovalsProps } from "./Approvals";
export { default as Approvals } from "./ApprovalsV2";
