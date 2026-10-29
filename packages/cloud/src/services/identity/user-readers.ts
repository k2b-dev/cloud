import { sql } from "bun";
import { z } from "zod";
import { accountCategory } from "../../contracts/account-categories";
import type { AccessSubject, UserRequestActor } from "../../contracts/shared";
import { readAccountCategoryPolicy } from "../account-category-policy";
import { isAccountExpired } from "../accounts/model";
import { toPgUuidArray } from "../postgres";
import { buildProjectedUser, userProjectionJoin, userProjectionSql } from "../session/user";
import { readIdentityGroupsAdmin } from "./runtime-config";

/** Current person authority for bounded permission queries; never creates sessions or service-account authority. */
export const resolveUserReaders = async (userIds: readonly string[]): Promise<{ actor: UserRequestActor; subject: AccessSubject }[]> => {
  const ids = z.array(z.uuid()).max(500).parse(userIds);
  if (!ids.length) return [];
  const groupsAdmin = await readIdentityGroupsAdmin(sql);
  const policy = await readAccountCategoryPolicy();
  const rows = await sql<Record<string, unknown>[]>`
    SELECT ${userProjectionSql([...groupsAdmin])} FROM auth.users u ${userProjectionJoin()}
    WHERE u.id = ANY(${toPgUuidArray(ids)}::uuid[]) AND (u.account_expires IS NULL OR u.account_expires > now())
  `;
  return rows.flatMap((row) => {
    const user = buildProjectedUser(row);
    return !isAccountExpired(user.accountExpires) && policy[accountCategory(user)].enabled
      ? [{ actor: { kind: "user" as const, user }, subject: { type: "user" as const, userId: user.id } }]
      : [];
  });
};
