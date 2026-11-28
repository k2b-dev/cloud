import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";

/**
 * The open approvals as the platform's list draws them, inside the activity's `Canvas`. A canvas runs from edge to edge,
 * so the drawing keeps the page's text edge itself (`--k2-edge`, the v2 token, also on the phone).
 * k2b-ui gap: the platform's approval list is still v1 (`@k2b/cloud/approvals/ui`); `@k2b/cloud/approvals/v2` (#4200)
 * replaces this drawing, its own count row included.
 */
export default function PendingApprovals(props: { app?: string; initial: ApprovalPage }) {
  return (
    <div style={{ padding: "0 var(--k2-edge, 20px)" }}>
      <Approvals app={props.app} initial={props.initial} />
    </div>
  );
}
