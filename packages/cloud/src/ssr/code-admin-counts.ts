import { sql } from "../runtime/clients";
import type { ApprovalRoleContext } from "../services/approvals/authority";
import { openRecipientRequests } from "../services/approvals/content";

export type CodeAdminCounts = { approvals: number; reports: number };

/** One snapshot for the Code frame badge and its visible approval/report breakdown. */
export const readCodeAdminCounts = async (input: {
  approverUserId: string;
  roleContext: ApprovalRoleContext;
  timeoutMs?: number;
}): Promise<CodeAdminCounts> =>
  sql.begin(async (tx) => {
    if (input.timeoutMs !== undefined) {
      const budget = Math.max(1, Math.floor(input.timeoutMs));
      await tx.unsafe(`SET LOCAL lock_timeout = ${budget}`);
      await tx.unsafe(`SET LOCAL statement_timeout = ${budget}`);
    }
    const open = await openRecipientRequests(input.approverUserId, undefined, input.roleContext, tx);
    const [row] = await tx<CodeAdminCounts[]>`SELECT
      (SELECT count(*)::int FROM (${open.query}) r WHERE r.kind='code_version') AS approvals,
      (SELECT count(*)::int FROM code.page_reports WHERE state='open' AND ${open.admin}) AS reports`;
    return row ?? { approvals: 0, reports: 0 };
  });
