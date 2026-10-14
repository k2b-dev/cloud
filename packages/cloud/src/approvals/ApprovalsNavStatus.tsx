import { AppWorkspace, useLocale } from "@k2b/ui";
import { liveApprovalCount } from "../ssr/app-badges";
import { approvalMessages } from "./messages";

/**
 * The count for an app's "Approvals" navigation row: the count the page rendered with, then the count the rail reads
 * once a minute and after every decision. A count that drops to zero stays as a muted 0 until the row goes away.
 */
export default function ApprovalsNavStatus(props: { app: string; initial: number }) {
  const locale = useLocale();
  const count = () => liveApprovalCount(props.app) ?? props.initial;
  return (
    <AppWorkspace.SidebarItemStatus
      waiting={{ count: count(), label: approvalMessages.resolve([locale()]).t.waiting({ count: count() }) }}
    />
  );
}

/** The current count for one app, or the rendered one until the browser has read it. */
export const approvalNavCount = (app: string, initial: number): number => liveApprovalCount(app) ?? initial;
