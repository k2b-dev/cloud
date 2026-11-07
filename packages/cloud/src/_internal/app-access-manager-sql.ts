import type { SQL } from "bun";
import { recursiveGroupIdsSubquery } from "../services/accounts/group-sql";

/** Eligibility of access entry alias `a`, shared by the last-manager guard and administration reads. */
export const managerEligibility = (db: SQL) => db`
  EXISTS (SELECT 1 FROM auth.users u WHERE (u.account_expires IS NULL OR u.account_expires > now()) AND
    (u.id = a.user_id OR (a.group_id IS NOT NULL AND a.group_id IN (${recursiveGroupIdsSubquery(db`u.id`)}))))
  OR EXISTS (SELECT 1 FROM auth.service_accounts sa WHERE sa.id = a.service_account_id
    AND sa.status = 'active' AND sa.kind IN ('standalone', 'agent'))
`;
