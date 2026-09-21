import { type SQL, sql } from "bun";
import { type RailAdminInput, RailAdminInputSchema, RailAdminSchema, type RailAdminState } from "../contracts/rail-admin";
import { RailShortcutSchema } from "../contracts/rail-preferences";
import { hasRole, type User } from "../contracts/shared";
import { buildAccessPrincipalCondition, createAccess } from "../server/services/access";

export class RailAdminError extends Error {
  constructor(
    public status: 400 | 403 | 409,
    message: string,
  ) {
    super(message);
  }
}
const requireAdmin = (actor: User | undefined) => {
  if (!actor || !hasRole(actor, "admin")) throw new RailAdminError(403, "Administrator access required");
};

export const createRailShortcutsService = (db: SQL = sql) => {
  const list = async (query: SQL = db): Promise<RailAdminState> => {
    const [state] = await query<{ revision: number }[]>`SELECT revision FROM auth.rail_state WHERE singleton`;
    const rows = await query<{ shortcut: unknown; access: unknown }[]>`
      SELECT r.shortcut, COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', a.id, 'permission', a.permission, 'createdAt', a.created_at,
          'principal', CASE WHEN a.user_id IS NOT NULL THEN jsonb_build_object('type', 'user', 'userId', a.user_id)
            WHEN a.group_id IS NOT NULL THEN jsonb_build_object('type', 'group', 'groupId', a.group_id)
            ELSE jsonb_build_object('type', 'authenticated') END,
          'displayName', COALESCE(u.display_name, g.name, '')
        ) ORDER BY a.created_at, a.id)
        FROM auth.rail_shortcut_access ra JOIN auth.access a ON a.id = ra.access_id
        LEFT JOIN auth.users u ON u.id = a.user_id LEFT JOIN auth.groups g ON g.id = a.group_id
        WHERE ra.shortcut_id = r.id
      ), '[]'::jsonb) AS access
      FROM auth.rail_shortcuts r ORDER BY r.position, r.id
    `;
    return RailAdminSchema.parse({ revision: state?.revision ?? 0, entries: rows });
  };
  return {
    async invalidateCache(actor: User | undefined) {
      requireAdmin(actor);
      // One generation switch invalidates every user, including concurrent old refills.
      // Keep the configuration revision unchanged so open editors remain valid.
      await db`UPDATE auth.rail_state SET cache_version = gen_random_uuid() WHERE singleton`;
    },
    async list(actor: User | undefined) {
      requireAdmin(actor);
      return list();
    },
    async save(actor: User | undefined, input: RailAdminInput) {
      requireAdmin(actor);
      const value = RailAdminInputSchema.parse(input);
      return db.begin(async (tx) => {
        const [state] = await tx<{ revision: number }[]>`SELECT revision FROM auth.rail_state WHERE singleton FOR UPDATE`;
        if (state?.revision !== value.revision) throw new RailAdminError(409, "App bar configuration changed. Reload before saving.");
        await tx`DELETE FROM auth.access WHERE id IN (SELECT access_id FROM auth.rail_shortcut_access)`;
        await tx`DELETE FROM auth.rail_shortcuts`;
        for (const [position, entry] of value.entries.entries()) {
          await tx`INSERT INTO auth.rail_shortcuts(id, position, shortcut)
            VALUES (${entry.shortcut.id}, ${position}, (${JSON.stringify(entry.shortcut)}::text)::jsonb)`;
          const seen = new Set<string>();
          for (const access of entry.access) {
            const key = JSON.stringify(access.principal);
            if (seen.has(key)) continue;
            seen.add(key);
            const created = await createAccess({ principal: access.principal, permission: "read" }, tx);
            if (!created.ok) throw new RailAdminError(400, "A selected user or group no longer exists.");
            await tx`INSERT INTO auth.rail_shortcut_access(shortcut_id, access_id) VALUES (${entry.shortcut.id}, ${created.data.id}::uuid)`;
          }
        }
        await tx`UPDATE auth.rail_state SET revision = revision + 1 WHERE singleton`;
        return list(tx);
      });
    },
    async forUser(userId: string) {
      const match = buildAccessPrincipalCondition({
        subject: { type: "user", userId },
        columns: {
          userId: db`a.user_id`,
          groupId: db`a.group_id`,
          serviceAccountId: db`a.service_account_id`,
          authenticatedOnly: db`a.authenticated_only`,
        },
      });
      const rows = await db<{ shortcut: unknown }[]>`
        SELECT r.shortcut FROM auth.rail_shortcuts r WHERE EXISTS (
          SELECT 1 FROM auth.rail_shortcut_access ra JOIN auth.access a ON a.id = ra.access_id
          WHERE ra.shortcut_id = r.id AND a.permission = 'read' AND ${match}
        ) ORDER BY r.position, r.id
      `;
      return rows.map((row) => RailShortcutSchema.parse(row.shortcut));
    },
  };
};
export const railShortcuts = createRailShortcutsService();
