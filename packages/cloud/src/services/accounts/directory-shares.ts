import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { z } from "zod";
import type { User } from "../../contracts/shared";
import type { RequestActor } from "../../server/middleware/auth";
import { audit } from "../audit";

import * as entities from "./entities";

export const DirectorySharePrincipalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), userId: z.uuid() }).strict(),
  z.object({ type: z.literal("group"), groupId: z.uuid() }).strict(),
  z.object({ type: z.literal("service_account"), serviceAccountId: z.uuid() }).strict(),
]);
type DirectorySharePrincipal = z.infer<typeof DirectorySharePrincipalSchema>;
type Administrator = Pick<User, "id" | "uid" | "provider" | "roles">;
const administrator = (actor: Administrator) => actor.roles.includes("admin");
const auditActor = (actor: Administrator) => ({ userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles });
const recipientExists = async (id: string) => {
  const [row] = await sql`SELECT id FROM auth.service_accounts WHERE id=${id}::uuid AND kind IN ('standalone','agent')`;
  return Boolean(row);
};

export const directoryShares = {
  list: async (params: { actor: Administrator; recipientId: string; page: number; perPage: number }) => {
    if (!administrator(params.actor)) return fail(err.forbidden("Administrator access required"));
    if (!(await recipientExists(params.recipientId))) return fail(err.notFound("Service account"));
    const rows = await sql<
      {
        id: string;
        user_id: string | null;
        group_id: string | null;
        service_account_id: string | null;
        label: string;
        service_account_kind: string | null;
        total: number;
      }[]
    >`SELECT share.id, share.user_id, share.group_id, share.service_account_id,
        COALESCE(NULLIF(u.display_name,''),u.uid,g.name,sa.name) AS label,
        sa.kind AS service_account_kind, count(*) OVER()::int AS total
      FROM auth.directory_shares share
      LEFT JOIN auth.users u ON u.id=share.user_id
      LEFT JOIN auth.groups g ON g.id=share.group_id
      LEFT JOIN auth.service_accounts sa ON sa.id=share.service_account_id
      WHERE share.recipient_id=${params.recipientId}::uuid
      ORDER BY share.created_at, share.id
      LIMIT ${params.perPage} OFFSET ${(params.page - 1) * params.perPage}`;
    return ok({
      items: rows.map((row) => ({
        id: row.id,
        label: row.label,
        serviceAccountKind: row.service_account_kind,
        principal: row.user_id
          ? { type: "user" as const, userId: row.user_id }
          : row.group_id
            ? { type: "group" as const, groupId: row.group_id }
            : { type: "service_account" as const, serviceAccountId: row.service_account_id! },
      })),
      total: rows[0]?.total ?? 0,
      page: params.page,
      perPage: params.perPage,
    });
  },
  grant: async (params: {
    actor: Administrator;
    recipientId: string;
    principal: DirectorySharePrincipal;
  }): Promise<Result<{ id: string }>> => {
    if (!administrator(params.actor)) return fail(err.forbidden("Administrator access required"));
    const principal = DirectorySharePrincipalSchema.safeParse(params.principal);
    if (!principal.success) return fail(err.badInput("Choose an exact directory entry"));
    if (!(await recipientExists(params.recipientId))) return fail(err.notFound("Service account"));
    const target = principal.data;
    try {
      return await sql.begin(async (db) => {
        const [row] = await db<{ id: string }[]>`INSERT INTO auth.directory_shares(recipient_id,user_id,group_id,service_account_id)
          VALUES(${params.recipientId}::uuid, ${target.type === "user" ? target.userId : null}::uuid,
            ${target.type === "group" ? target.groupId : null}::uuid,
            ${target.type === "service_account" ? target.serviceAccountId : null}::uuid)
          ON CONFLICT (recipient_id,user_id,group_id,service_account_id) DO UPDATE SET recipient_id=EXCLUDED.recipient_id RETURNING id`;
        if (!row) return fail(err.internal("Could not save directory access"));
        await audit.record(
          {
            action: "accounts.directory.grant",
            outcome: "allowed",
            actor: auditActor(params.actor),
            target: { type: "directory_share", id: row.id },
            metadata: { serviceAccountId: params.recipientId, principal: target },
          },
          db,
        );
        return ok(row);
      });
    } catch (error) {
      if (
        z.object({ code: z.literal("23503") }).safeParse(error).success ||
        z.object({ errno: z.literal("23503") }).safeParse(error).success
      )
        return fail(err.notFound("Directory entry"));
      throw error;
    }
  },
  revoke: async (params: { actor: Administrator; recipientId: string; id: string }): Promise<Result<void>> => {
    if (!administrator(params.actor)) return fail(err.forbidden("Administrator access required"));
    return sql.begin(async (db) => {
      await db`DELETE FROM auth.directory_shares WHERE id=${params.id}::uuid AND recipient_id=${params.recipientId}::uuid`;
      await audit.record(
        {
          action: "accounts.directory.revoke",
          outcome: "allowed",
          actor: auditActor(params.actor),
          target: { type: "directory_share", id: params.id },
          metadata: { serviceAccountId: params.recipientId },
        },
        db,
      );
      return ok();
    });
  },
  search: async (params: { actor: RequestActor; query: Omit<entities.EntityListParams, "visibility">; requestId?: string }) => {
    const { actor, query } = params;
    const result = await (async () => {
      if (
        actor.kind !== "service_account" ||
        actor.delegatedUser ||
        !["standalone", "agent"].includes(actor.serviceAccount.kind) ||
        !actor.scopes.includes("read")
      )
        return fail(err.forbidden("Directory read access required"));
      // Sharing an entry never shares its membership or management relationships.
      if (
        query.memberOfGroupId ||
        query.managerOfGroupId ||
        query.parentGroupId ||
        query.managedByUserId ||
        query.userMemberOfGroupIds?.length
      )
        return fail(err.forbidden("Directory shares do not include group relationships"));
      return ok(await entities.list({ ...query, visibility: { type: "directory_shares", serviceAccountId: actor.serviceAccount.id } }));
    })();
    return audit.recordResult({
      action: "accounts.directory.search",
      result,
      requestId: params.requestId,
      target: actor.kind === "service_account" ? { type: "service_account", id: actor.serviceAccount.id } : null,
      metadata:
        actor.kind === "service_account" ? { serviceAccountId: actor.serviceAccount.id, credentialId: actor.credentialId ?? null } : {},
    });
  },
};
