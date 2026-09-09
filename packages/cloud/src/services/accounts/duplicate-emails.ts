import { err, fail, ok, type PageParams, type Paginated, paginate, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import type { User } from "../../contracts/shared";
import { type AccountsActor, isAdminActor } from "./authz";

export type DuplicateEmailUser = Pick<
  User,
  "id" | "uid" | "provider" | "profile" | "givenname" | "sn" | "displayName" | "mail" | "accountExpires" | "lastLoginLocal"
> & {
  lastLoginIpa: string | null;
  ipaSyncedAt: string | null;
};

type DuplicateEmailGroup = { email: string; users: DuplicateEmailUser[] };
type Row = {
  email: string;
  id: string;
  uid: string;
  provider: User["provider"];
  profile: User["profile"];
  given_name: string;
  sn: string;
  display_name: string;
  mail: string;
  account_expires: Date | null;
  last_login_local: Date | null;
  last_login_ipa: Date | null;
  synced_at: Date | null;
};

/** Temporary cleanup read: paginate addresses, never split matching accounts. */
export const listDuplicateEmails = async (config: {
  actor: AccountsActor;
  pagination?: PageParams;
}): Promise<Result<Paginated<DuplicateEmailGroup>>> => {
  if (!isAdminActor(config.actor)) return fail(err.forbidden("Admin access required"));
  const requested = paginate(config.pagination);
  return sql.begin(async (tx) => {
    // Keep the count and members consistent while another administrator deletes accounts.
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
    const duplicates = tx`
      SELECT lower(btrim(mail)) AS email FROM auth.users
      WHERE NULLIF(btrim(mail), '') IS NOT NULL
      GROUP BY lower(btrim(mail)) HAVING count(*) > 1
    `;
    const [count] = await tx<Array<{ total: number }>>`SELECT count(*)::int AS total FROM (${duplicates}) duplicates`;
    const total = count?.total ?? 0;
    const perPage = requested.perPage;
    const page = Math.min(requested.page, Math.max(1, Math.ceil(total / perPage)));
    const rows = await tx<Row[]>`
      SELECT d.email, u.id, u.uid, u.provider, u.profile, u.given_name, u.sn, u.display_name, u.mail,
        u.account_expires, u.last_login_local, ui.last_login_ipa, ui.synced_at
      FROM (${duplicates} ORDER BY email LIMIT ${perPage} OFFSET ${(page - 1) * perPage}) d
      JOIN auth.users u ON lower(btrim(u.mail)) = d.email
      LEFT JOIN auth.user_ipa_data ui ON ui.user_id = u.id AND u.provider = 'ipa'
      ORDER BY d.email, u.provider, u.uid, u.id
    `;
    const groups = new Map<string, DuplicateEmailGroup>();
    for (const row of rows) {
      let group = groups.get(row.email);
      if (!group) {
        group = { email: row.email, users: [] };
        groups.set(row.email, group);
      }
      group.users.push({
        id: row.id,
        uid: row.uid,
        provider: row.provider,
        profile: row.profile,
        givenname: row.given_name,
        sn: row.sn,
        displayName: row.display_name,
        mail: row.mail,
        accountExpires: row.account_expires?.toISOString() ?? null,
        lastLoginLocal: row.last_login_local?.toISOString() ?? null,
        lastLoginIpa: row.last_login_ipa?.toISOString() ?? null,
        ipaSyncedAt: row.synced_at?.toISOString() ?? null,
      });
    }
    return ok({ items: [...groups.values()], page, perPage, total, hasNext: page * perPage < total });
  });
};
