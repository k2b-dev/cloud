import { Approvals, ApprovalsNavStatus, approvalNavCount } from "@k2b/cloud/approvals/ui";
import type { ApprovalPage } from "@k2b/cloud/contracts/approvals";

export const InventoryApprovals = (props: { initial: ApprovalPage }) => <Approvals app="inventory" initial={props.initial} />;

export const InventoryApprovalBand = (props: { link: string; initial: ApprovalPage }) => (
  <Approvals app="inventory" link={props.link} initial={props.initial} layout="band" />
);

export const InventoryApprovalsStatus = (props: { initial: number }) => <ApprovalsNavStatus app="inventory" initial={props.initial} />;

export const inventoryApprovalCount = (initial: number) => approvalNavCount("inventory", initial);
