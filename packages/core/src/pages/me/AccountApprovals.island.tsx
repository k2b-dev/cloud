import { Approvals } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";

/** Every app's open approvals, or one app's with `?app=`: the safe place for apps that show no list of their own. */
export default function AccountApprovals(props: { app?: string; initial: ApprovalPage }) {
  return <Approvals app={props.app} initial={props.initial} />;
}
