import { AppTerminalLoginSchema } from "@k2b/cloud/contracts";
import { AppApprovalError, type AppTerminalLogins, appApproval, audit, toPgTextArray } from "@k2b/cloud/services";
import { type SQL, sql } from "bun";
import { Hono } from "hono";
import { z } from "zod";
import { authenticateOAuthBroker, oauthBrokerBearer } from "./identity-oauth-issuance";

const Scope = z.string().regex(/^[a-z][a-z0-9_:.-]{0,39}$/);
const RequestSchema = z
  .object({
    deviceAuthorizationId: z.string().uuid(),
    identifier: z.string().trim().min(1).max(254),
    clientId: z.string().min(1).max(256),
    scopes: z
      .array(Scope)
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length),
    lifetimeSeconds: z.number().int().min(1).max(7_776_000),
  })
  .strict();

/** Same profile, direct-user and recursive-group grants as the OAuth application. */
const clientAccess = async (tx: SQL, clientId: string, user: { id: string; profile: "guest" | "user" }): Promise<boolean> => {
  const [row] = await tx<{ allowed: boolean }[]>`
    WITH RECURSIVE user_all_groups(group_id) AS (
      SELECT group_id FROM auth.user_groups_v2 WHERE user_id=${user.id}::uuid
      UNION
      SELECT gg.parent_group_id FROM auth.group_groups_v2 gg JOIN user_all_groups ag ON ag.group_id=gg.child_group_id
    )
    SELECT (${user.profile}=ANY(c.allowed_profiles) AND (
      c.access_mode='profiles' OR (c.access_mode='specific' AND (
        EXISTS (SELECT 1 FROM oauth.client_access_users g WHERE g.client_id=c.id AND g.user_id=${user.id}::uuid)
        OR EXISTS (SELECT 1 FROM oauth.client_access_groups g JOIN user_all_groups ag ON ag.group_id=g.group_id WHERE g.client_id=c.id)
      )))) AS allowed
    FROM oauth.clients c WHERE c.client_id=${clientId} AND c.is_public AND c.allow_device_grant`;
  return row?.allowed === true;
};

/** OAuth schema access stays in Core; Cloud only owns the sign-in lifecycle. */
export const terminalLogins: AppTerminalLogins = {
  describe: async (tx, ids) => {
    if (!ids.length) return new Map();
    const rows = await tx<{ device_id: string; client_id: string; name: string }[]>`
      SELECT d.id AS device_id,c.client_id,c.name FROM oauth.device_authorizations d
      JOIN oauth.clients c ON c.client_id=d.client_id
      WHERE d.id=ANY(${toPgTextArray(ids)}::uuid[]) AND d.status='pending' AND d.expires_at > now()
        AND c.is_public AND c.allow_device_grant`;
    return new Map(rows.map((row) => [row.device_id, { id: row.client_id, name: row.name }]));
  },
  decide: async (tx, input) => {
    if (!(await clientAccess(tx, input.clientId, input.user))) return false;
    const [row] = await tx<{ id: string; scopes: string[]; client_pk: string; name: string }[]>`
      UPDATE oauth.device_authorizations d
      SET status=${input.decision === "approve" ? "approved" : "denied"},user_id=${input.user.id}::uuid,decided_at=now(),
        login_lifetime_seconds=l.lifetime_seconds
      FROM oauth.clients c, auth.app_logins l
      WHERE d.id=${input.deviceAuthorizationId}::uuid AND d.client_id=${input.clientId}
        AND d.status='pending' AND d.expires_at > now()
        AND c.client_id=d.client_id AND c.is_public AND c.allow_device_grant
        AND l.device_authorization_id=d.id AND l.kind='terminal' AND l.client_id=d.client_id
        AND l.user_id=${input.user.id}::uuid AND l.state='pending'
        AND d.scopes @> l.scopes AND l.scopes @> d.scopes AND d.scopes <@ c.scopes AND NOT ('admin'=ANY(d.scopes))
        AND (d.login_lifetime_seconds IS NULL OR l.lifetime_seconds<=d.login_lifetime_seconds)
      RETURNING d.id,d.scopes,c.id AS client_pk,c.name`;
    if (!row) return false;
    await audit.record(
      {
        action: "oauth.device.authorize",
        outcome: input.decision === "approve" ? "allowed" : "denied",
        actor: { userId: input.user.id, uid: input.user.uid, provider: input.user.provider },
        target: { type: "oauth_client", id: row.client_pk, label: row.name },
        ...(input.decision === "deny" ? { reason: "resource_owner_denied" } : {}),
        metadata: { clientId: input.clientId, deviceGrantId: row.id, scopes: row.scopes, via: "app-approval" },
      },
      tx,
    );
    return true;
  },
};

export const createIdentityOAuthDeviceApprovalRoutes = (
  service: Pick<typeof appApproval, "startTerminalLogin"> = appApproval,
  db: SQL = sql,
) =>
  new Hono()
    .onError((error, c) => {
      console.error("[oauth-device-approval] operation failed", error.name);
      return c.json({ code: "UNAVAILABLE" }, 503);
    })
    .post("/oauth/device-approval", async (c) => {
      c.header("Cache-Control", "no-store");
      if (!authenticateOAuthBroker(oauthBrokerBearer(c.req.header("authorization")))) return c.json({ code: "UNAUTHORIZED" }, 401);
      const contentLength = Number(c.req.header("content-length") ?? 0);
      if (Number.isFinite(contentLength) && contentLength > 262_144) return c.json({ code: "INVALID_REQUEST" }, 413);
      let body: unknown;
      try {
        const text = await c.req.text();
        if (new TextEncoder().encode(text).byteLength > 262_144) return c.json({ code: "INVALID_REQUEST" }, 413);
        body = JSON.parse(text);
      } catch {
        return c.json({ code: "INVALID_REQUEST" }, 400);
      }
      const parsed = RequestSchema.safeParse(body);
      if (!parsed.success) return c.json({ code: "INVALID_REQUEST" }, 400);
      const input = parsed.data;
      const [authorization] = await db`
        SELECT d.id FROM oauth.device_authorizations d JOIN oauth.clients c ON c.client_id=d.client_id
        WHERE d.id=${input.deviceAuthorizationId}::uuid AND d.client_id=${input.clientId}
          AND d.status='pending' AND d.expires_at > now() AND c.is_public AND c.allow_device_grant
          AND d.scopes @> ${toPgTextArray(input.scopes)}::text[] AND d.scopes <@ ${toPgTextArray(input.scopes)}::text[]
          AND d.scopes <@ c.scopes AND NOT ('admin'=ANY(d.scopes))
          AND (d.login_lifetime_seconds IS NULL OR ${input.lifetimeSeconds}<=d.login_lifetime_seconds)`;
      if (!authorization || !AppTerminalLoginSchema.shape.client.shape.id.safeParse(input.clientId).success)
        return c.json({ code: "CONFLICT" }, 409);
      try {
        return c.json(await service.startTerminalLogin(input, (tx, user) => clientAccess(tx, input.clientId, user)));
      } catch (error) {
        if (error instanceof AppApprovalError) return c.json({ code: error.code }, error.status);
        throw error;
      }
    });

/** Retain approval evidence until the linked OAuth row is gone, including during issuance. OAuth is an optional app. */
export const cleanupTerminalLogins = async (db: SQL = sql): Promise<void> => {
  const [schema] = await db`SELECT to_regclass('oauth.device_authorizations') IS NOT NULL AS installed`;
  if (!schema?.installed) return;
  await db`DELETE FROM auth.app_logins WHERE id IN (
    SELECT l.id FROM auth.app_logins l WHERE l.kind='terminal' AND l.state='approved' AND l.expires_at < now()
      AND NOT EXISTS (SELECT 1 FROM oauth.device_authorizations d WHERE d.id=l.device_authorization_id)
    ORDER BY l.expires_at LIMIT 100 FOR UPDATE OF l SKIP LOCKED)`;
};

export default createIdentityOAuthDeviceApprovalRoutes();
