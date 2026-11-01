import { Hono } from "hono";
import { parseAppKey } from "../app-key";
import { env } from "../config/env";
import { APP_MIGRATION_RECEIPT_PATH } from "../contracts/app-migration";
import { redis } from "../runtime/clients";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { sendAppRequest } from "../services/identity/app-request";
import { CLOUD_INVOCATION_TOKEN_TTL_SECONDS, INVOCATION_CLOCK_TOLERANCE_SECONDS } from "../services/identity/constants";
import { coreOrigin } from "../services/identity/core-origin";
import { verifyMigrationProbe } from "../services/identity/invocation-token";

export { APP_MIGRATION_TRIGGER_PATH } from "../contracts/app-migration";
export const createAppMigrationTriggerRoutes = (
  appId: string,
  dependencies: {
    verify?: typeof verifyMigrationProbe;
    send?: typeof sendAppRequest;
    key?: () => string | undefined;
    origin?: typeof coreOrigin;
    consume?: (nonce: string) => Promise<boolean>;
  } = {},
) =>
  new Hono().post("/probe", async (c) => {
    c.header("Cache-Control", "no-store");
    const token = c.req.header("authorization")?.match(/^Bearer (\S+)$/)?.[1];
    if (!token) return c.body(null, 401);
    const claims = await (dependencies.verify ?? verifyMigrationProbe)(token, appId);
    if (!claims) return c.body(null, 401);
    const value = (dependencies.key ?? (() => env.CLOUD_APP_KEY))();
    if (!value) return c.body(null, 409);
    const key = parseAppKey(value);
    if (key.appId !== appId || key.keyId !== claims.key_id) return c.body(null, 409);
    const consume =
      dependencies.consume ??
      (async (nonce: string) =>
        (await redis.send("SET", [
          `cloud:app-migration:${nonce}`,
          "1",
          "NX",
          "EX",
          String(CLOUD_INVOCATION_TOKEN_TTL_SECONDS + 2 * INVOCATION_CLOCK_TOLERANCE_SECONDS),
        ])) === "OK");
    if (!(await consume(claims.jti))) return c.body(null, 409);
    const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_SECONDS * 1000)]);
    try {
      const scopes = claims.oauth ? ["identity:invoke", "oauth:issue"] : ["identity:invoke"];
      for (const scope of scopes) {
        const response = await (dependencies.send ?? sendAppRequest)(
          new Request(new URL(`${APP_MIGRATION_RECEIPT_PATH}/${scope}`, await (dependencies.origin ?? coreOrigin)(true)), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ nonce: claims.jti }),
            signal,
          }),
          { appId },
        );
        await response.body?.cancel();
        if (response.status !== 204) return c.body(null, 502);
      }
      return c.body(null, 204);
    } catch {
      return c.body(null, 503);
    }
  });
