import { sql } from "@k2b/cloud";
import { AppTerminalLoginSchema, OAuthDeviceApprovalRequestSchema } from "@k2b/cloud/contracts";
import { AppApprovalError, type AppTerminalLogins, appApproval, audit, toPgTextArray } from "@k2b/cloud/services";
import * as settings from "@k2b/cloud/services/settings";
import type { SQL } from "bun";
import { Hono } from "hono";
import { authorizeOAuthRequest } from "./identity-oauth-issuance";

const legalAccepted = async (tx: SQL, userId: string) =>
  (await tx`SELECT 1 FROM auth.legal_acceptances WHERE user_id=${userId}::uuid`).length > 0;

/** Display and decide only platform-owned evidence; issuer policy is checked at issuance. */
export const terminalLogins: AppTerminalLogins = {
  describe: async (tx, ids) => {
    if (!ids.length) return new Map();
    const rows = await tx<{ id: string; client_id: string; name: string }[]>`
      SELECT l.id,l.client_id,l.oauth_client_name AS name FROM auth.app_logins l
      JOIN auth.oauth_clients c ON c.client_id=l.client_id AND c.issuer_app_id=l.oauth_issuer_app_id AND c.status='active'
      WHERE l.id=ANY(${toPgTextArray(ids)}::uuid[]) AND l.kind='terminal' AND l.state='pending'
        AND l.oauth_grant_expires_at > now()`;
    return new Map(rows.map((row) => [row.id, { id: row.client_id, name: row.name }]));
  },
  decide: async (tx, input) => {
    const [row] = await tx<{ id: string; scopes: string[]; name: string }[]>`
      SELECT l.id,l.scopes,l.oauth_client_name AS name FROM auth.app_logins l
      JOIN auth.oauth_clients c ON c.client_id=l.client_id AND c.issuer_app_id=l.oauth_issuer_app_id AND c.status='active'
      WHERE l.id=${input.loginId}::uuid AND l.device_authorization_id=${input.deviceAuthorizationId}::uuid
        AND l.kind='terminal' AND l.client_id=${input.clientId} AND l.user_id=${input.user.id}::uuid
        AND l.state='pending' AND l.auth_epoch=${input.user.auth_epoch}::bigint
        AND l.oauth_grant_expires_at > clock_timestamp() AND NOT ('admin'=ANY(l.scopes))`;
    if (!row) return false;
    await audit.record(
      {
        action: "oauth.device.authorize",
        outcome: input.decision === "approve" ? "allowed" : "denied",
        actor: { userId: input.user.id, uid: input.user.uid, provider: input.user.provider },
        target: { type: "oauth_client", id: input.clientId, label: row.name },
        ...(input.decision === "deny" ? { reason: "resource_owner_denied" } : {}),
        metadata: { clientId: input.clientId, deviceGrantId: input.deviceAuthorizationId, scopes: row.scopes, via: "app-approval" },
      },
      tx,
    );
    return true;
  },
};

export const createIdentityOAuthDeviceApprovalRoutes = (
  service: Pick<typeof appApproval, "startTerminalLogin"> = appApproval,
  db: SQL = sql,
  authorize = authorizeOAuthRequest,
) =>
  new Hono<{ Variables: { oauthIssuerAppId: string } }>()
    .onError((error, c) => {
      console.error("[oauth-device-approval] operation failed", error.name);
      return c.json({ code: "UNAVAILABLE" }, 503);
    })
    .post("/oauth/device-approval", async (c) => {
      c.header("Cache-Control", "no-store");
      const denied = await authorize(c);
      if (denied) return denied;
      if (Number(c.req.header("content-length") ?? 0) > 262_144) return c.json({ code: "INVALID_REQUEST" }, 413);
      let body: unknown;
      try {
        const text = await c.req.text();
        if (new TextEncoder().encode(text).byteLength > 262_144) return c.json({ code: "INVALID_REQUEST" }, 413);
        body = JSON.parse(text);
      } catch {
        return c.json({ code: "INVALID_REQUEST" }, 400);
      }
      const parsed = OAuthDeviceApprovalRequestSchema.safeParse(body);
      if (!parsed.success) return c.json({ code: "INVALID_REQUEST" }, 400);
      const input = parsed.data;
      const appId = c.get("oauthIssuerAppId");
      if (typeof appId !== "string") return c.json({ code: "FORBIDDEN" }, 403);
      const [client] = await db`SELECT client_id FROM auth.oauth_clients
      WHERE client_id=${input.clientId} AND issuer_app_id=${appId} AND status='active'`;
      if (
        !client ||
        Date.parse(input.grantExpiresAt) <= Date.now() ||
        !AppTerminalLoginSchema.shape.client.shape.id.safeParse(input.clientId).success
      )
        return c.json({ code: "CONFLICT" }, 409);
      try {
        const hours = await settings.get<number>("user.session.expiry_hours");
        if (!Number.isFinite(hours) || hours < 1) throw new Error("user.session.expiry_hours must be a positive number");
        return c.json(
          await service.startTerminalLogin(
            { ...input, issuerAppId: appId, lifetimeSeconds: Math.min(input.lifetimeSeconds, Math.floor(hours * 3600)) },
            async (tx, user) => legalAccepted(tx, user.id),
          ),
        );
      } catch (error) {
        if (error instanceof AppApprovalError) return c.json({ code: error.code }, error.status);
        throw error;
      }
    });

/** Retain approved evidence through the issuer's grant deadline, including during issuance. */
export const cleanupTerminalLogins = async (db: SQL = sql): Promise<void> => {
  await db`DELETE FROM auth.app_logins WHERE id IN (
    SELECT id FROM auth.app_logins WHERE kind='terminal' AND state='approved'
      AND COALESCE(oauth_grant_expires_at,expires_at) < now()
    ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`;
};

export default createIdentityOAuthDeviceApprovalRoutes();
