/** Isolated real-service browser fixture. Never starts against development data. */
import { sql } from "bun";
import { Hono } from "../../../packages/cloud/node_modules/hono";
import { createAppApprovalRoutes } from "../../../packages/cloud/src/api/app-approval";
import { appApproval } from "../../../packages/cloud/src/browser/app-approval";
import { APP_APPROVAL_PATH } from "../../../packages/cloud/src/contracts/app-approval";
import { createAppApprovalService } from "../../../packages/cloud/src/services/app-approval";

const db = new URL(process.env.DATABASE_URL ?? "http://invalid");
const cache = new URL(process.env.REDIS_URL ?? "http://invalid");
if (
  process.env.CLOUD_APP_APPROVAL_TEST !== "1" ||
  db.hostname !== "127.0.0.1" ||
  db.port !== "55449" ||
  db.pathname !== "/cloud_app_approval_test" ||
  cache.hostname !== "127.0.0.1" ||
  cache.port !== "56399"
)
  throw new Error("Dedicated test database/cache required");
const pwa = "http://127.0.0.1:4178";
for (const port of [43220, 43221]) {
  const issuer = `http://127.0.0.1:${port}`;
  let enabled = true;
  const service = createAppApprovalService(sql, async () => ({ issuer, appOrigin: pwa, enabled, adminPairing: false }));
  const uid = `pwa-${crypto.randomUUID()}`;
  const [user] = await sql`INSERT INTO auth.users(uid,provider,profile) VALUES (${uid},'local','user') RETURNING id`;
  const sid = crypto.randomUUID();
  await sql`INSERT INTO auth.session_families(sid,user_id,auth_epoch,signing_kid,expires_at) VALUES (${sid}::uuid,${user.id}::uuid,0,(SELECT kid FROM auth.signing_keys WHERE purpose='session' LIMIT 1),now()+interval '1 hour')`;
  const actor = { userId: String(user.id), sid, admin: false };
  const logins = new Map<string, Awaited<ReturnType<typeof service.startLogin>>>();
  const app = new Hono().route(APP_APPROVAL_PATH, createAppApprovalRoutes(service));
  app.post("/fixture/pair", async (c) => {
    // Simulate a fresh interactive fixture session for each new test flow.
    await sql`UPDATE auth.session_families SET issued_at=now() WHERE sid=${sid}::uuid`;
    const pairing = await service.startPairing(actor);
    return c.json({ pairingId: pairing.pairingId, link: appApproval.createPairingLink(pwa, pairing) });
  });
  app.post("/fixture/confirm", async (c) => {
    const b = await c.req.json();
    return c.json(await service.confirmPairing(actor, b.pairingId, b.comparison));
  });
  app.post("/fixture/start", async (c) => {
    const result = await service.startLogin(uid, "login");
    logins.set(result.requestId, result);
    return c.json({ requestId: result.requestId, comparison: result.comparison });
  });
  app.post("/fixture/status", async (c) => {
    const b = await c.req.json();
    const login = logins.get(b.requestId)!;
    return c.json(await service.browserStatus(login.requestId, login.browserSecret));
  });
  app.post("/fixture/enabled", async (c) => {
    enabled = (await c.req.json()).enabled;
    return c.json({ enabled });
  });
  app.post("/fixture/devices", async (c) => c.json(await service.listDevices(actor)));
  Bun.serve({ hostname: "127.0.0.1", port, fetch: app.fetch });
}
console.log("Isolated PWA fixture ready: 43220 and 43221");
