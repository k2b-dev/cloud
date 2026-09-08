import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  APP_APPROVAL_LIMITS,
  AppDeviceMutationSchema,
  AppDeviceRequestSchema,
  AppLoginReferenceSchema,
  AppLoginStartSchema,
  AppPairingClaimSchema,
  AppPairingConfirmSchema,
  AppPairingReferenceSchema,
  AppPairingStartSchema,
} from "../contracts/app-approval";
import { auth, type AuthContext, rateLimit, v } from "../server";
import { appApproval, AppApprovalError, type AppApprovalActor, type createAppApprovalService } from "../services/app-approval";

const PairingIdSchema = z.object({ pairingId: z.string().uuid() }).strict();
const DevicePageSchema = z.object({ after: z.string().uuid().optional() }).strict();
type Service = ReturnType<typeof createAppApprovalService>;

/** This is a separate credential surface, never a user API-key or OAuth scope. */
export const createAppApprovalRoutes = (service: Service = appApproval) => {
  const actor = async (c: Parameters<typeof auth.session.getToken>[0]): Promise<AppApprovalActor> => {
    const token = auth.session.getToken(c);
    const session = token ? await auth.session.authenticateRequest(c, token) : null;
    if (!session) throw new AppApprovalError("REAUTHENTICATE", 403);
    return { userId: session.user.id, sid: session.data.sid, admin: session.user.roles.includes("admin") };
  };
  return new Hono<AuthContext>()
    .onError((error, c) => {
      if (error instanceof AppApprovalError) return c.json({ code: error.code, message: error.code }, error.status);
      if (error instanceof HTTPException && error.status < 500) return c.json({ code: "INVALID_REQUEST" }, error.status);
      // Never include SQL, pairing secrets, signature bodies or keys in errors.
      console.error("[app-approval] operation failed", error instanceof Error ? error.name : "UnknownError");
      return c.json({ code: "UNAVAILABLE", message: "App approval is unavailable." }, 503);
    })
    .use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      c.header("Vary", "Origin");
      const cfg = await service.config(c.req.path.includes("/manage/") ? false : true);
      const origin = c.req.header("Origin");
      const deviceSurface = /\/(info|pairings\/claim|pairings\/result|device)$/.test(c.req.path);
      if (origin && origin !== cfg.issuer && !(deviceSurface && origin === cfg.appOrigin)) return c.json({ code: "FORBIDDEN" }, 403);
      if (!deviceSurface && c.req.method !== "GET" && origin !== cfg.issuer) return c.json({ code: "FORBIDDEN" }, 403);
      if (deviceSurface && origin === cfg.appOrigin) {
        c.header("Access-Control-Allow-Origin", cfg.appOrigin);
        c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        c.header("Access-Control-Allow-Headers", "Content-Type");
        c.header("Access-Control-Max-Age", "300");
      }
      if (c.req.method === "OPTIONS") return c.body(null, 204);
      await next();
    })
    .use("*", bodyLimit({ maxSize: APP_APPROVAL_LIMITS.bodyBytes }))
    .use("*", rateLimit({ keyBy: "ip" }))
    .use("/manage/*", auth.requireRole("authenticated"))
    .get("/info", describeRoute({ tags: ["App approval"], summary: "Discover the enabled app approval protocol" }), async (c) =>
      c.json(await service.info()),
    )
    .post(
      "/manage/pairings/start",
      describeRoute({ tags: ["App approval"], summary: "Start recent-session authorized device pairing" }),
      v("json", AppPairingStartSchema),
      async (c) => c.json(await service.startPairing(await actor(c), c.req.valid("json").userId), 201),
    )
    .post("/manage/pairings/status", v("json", PairingIdSchema), async (c) =>
      c.json(await service.inspectPairing(await actor(c), c.req.valid("json").pairingId)),
    )
    .post("/manage/pairings/confirm", v("json", AppPairingConfirmSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(await service.confirmPairing(await actor(c), input.pairingId, input.comparison));
    })
    .post("/manage/pairings/cancel", v("json", PairingIdSchema), async (c) => {
      await service.cancelPairing(await actor(c), c.req.valid("json").pairingId);
      return c.body(null, 204);
    })
    .get("/manage/devices", v("query", DevicePageSchema), async (c) =>
      c.json(await service.listDevices(await actor(c), c.req.valid("query").after)),
    )
    .post("/manage/devices/update", v("json", AppDeviceMutationSchema), async (c) => {
      const input = c.req.valid("json");
      await service.mutateDevice(await actor(c), input.deviceId, input.operation === "rename" ? input.name : undefined);
      return c.body(null, 204);
    })
    .post(
      "/pairings/claim",
      describeRoute({ tags: ["App approval"], summary: "Claim a pairing with device proof of possession" }),
      v("json", AppPairingClaimSchema),
      async (c) => c.json(await service.claimPairing(c.req.valid("json"))),
    )
    .post("/pairings/result", v("json", AppPairingReferenceSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(await service.pairingResult(input.pairingId, input.secret, input.publicKey));
    })
    .post(
      "/device",
      describeRoute({ tags: ["App approval"], summary: "Execute a one-use signed device command" }),
      v("json", AppDeviceRequestSchema),
      async (c) => c.json(await service.deviceCommand(c.req.valid("json"))),
    )
    .post(
      "/login/start",
      describeRoute({ tags: ["App approval"], summary: "Start a browser-bound app login without revealing account existence" }),
      v("json", AppLoginStartSchema),
      async (c) => {
        const input = c.req.valid("json");
        return c.json(await service.startLogin(input.identifier, input.category), 202);
      },
    )
    .post("/login/status", v("json", AppLoginReferenceSchema), async (c) => {
      const input = c.req.valid("json");
      return c.json(await service.browserStatus(input.requestId, input.browserSecret));
    })
    .post(
      "/login/complete",
      describeRoute({ tags: ["App approval"], summary: "Consume an approval once and set only the original browser session cookie" }),
      v("json", AppLoginReferenceSchema),
      async (c) => {
        const input = c.req.valid("json");
        const userId = await service.consumeLogin(input.requestId, input.browserSecret);
        await auth.session.create(c, userId);
        return c.body(null, 204);
      },
    );
};
