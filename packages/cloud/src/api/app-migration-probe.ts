import { Hono } from "hono";
import { z } from "zod";
import { recordAppMigrationProbe } from "../services/app-migration-evidence";
import { authenticateSignedAppRequest } from "./authenticate-app-request";

export { APP_MIGRATION_RECEIPT_PATH } from "../contracts/app-migration";
/** Core-only: the same authentication, replay and explicit grant checks as broker/OAuth requests. */
export const createAppMigrationProbeRoutes = (authenticate = authenticateSignedAppRequest, record = recordAppMigrationProbe) =>
  new Hono().post("/:scope", async (c) => {
    const scope = z.enum(["identity:invoke", "oauth:issue"]).safeParse(c.req.param("scope"));
    if (!scope.success) return c.body(null, 404);
    const identity = await authenticate(c, scope.data);
    if (identity instanceof Response) return identity;
    if (!identity.keyId) return c.body(null, 401);
    const body = z
      .object({ nonce: z.uuid() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.body(null, 400);
    await record({ keyId: identity.keyId, scope: scope.data, nonce: body.data.nonce });
    return c.body(null, 204);
  });
