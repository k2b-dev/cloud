import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import { z } from "zod";
import type { AuthContext } from "../server/middleware/auth";
import { rateLimit } from "../server/middleware/rate-limit";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { pairingSecret } from "../services/pairing-secret";
import { session } from "../services/session";
import {
  AppPwaAttempt,
  AppPwaClaim,
  AppPwaError,
  AppPwaId,
  type AppPwaOptions,
  AppPwaSecret,
  type AppPwaWebSignIn,
  parseAppPwaInput as parse,
  pwaFail,
} from "./contracts";
import { type AppPwaService, createAppPwaService } from "./service";
import { readAppPwaJson, untilAppPwaAbort } from "./transport-input";

/** Cookie paths are not trustworthy in the Cookie header. Reject all ambiguous same-name credentials. */
export const appPwaCookie = (header: string | null, name: string): string | undefined => {
  const entries = (header ?? "")
    .split(";")
    .map((value) => value.trim())
    .filter((value) => value.split("=", 1)[0]?.trim() === name);
  if (entries.length > 1) return pwaFail("DUPLICATE_COOKIE", 400);
  const entry = entries[0];
  if (!entry) return undefined;
  const value = entry.slice(entry.indexOf("=") + 1);
  if (!value || entry.indexOf("=") < 0) return pwaFail("BROWSER_REQUIRED", 401);
  return value;
};

/** Only this surface's browser credential is considered; employee cookies/bearers are irrelevant. */
export const appPwaCredential = (headers: Headers, service: Pick<AppPwaService, "cookieName" | "csrf">): string => {
  const cookie = appPwaCookie(headers.get("Cookie"), service.cookieName);
  if (!cookie || !AppPwaSecret.safeParse(cookie).success) return pwaFail("BROWSER_REQUIRED", 401);
  const received = headers.get("X-App-Pwa-CSRF");
  if (!received || !pairingSecret.matches(received, pairingSecret.hash(service.csrf(cookie)))) return pwaFail("CSRF_REQUIRED", 403);
  return cookie;
};

const empty = z.strictObject({});
const deviceIdInput = z.strictObject({ deviceId: AppPwaId });
const visitIdInput = z.strictObject({ visitId: AppPwaId });
const queryInput = z.strictObject({ visitId: AppPwaId, input: z.unknown() });
const commandInput = AppPwaAttempt.extend({ visitId: AppPwaId });

/** Closed HTTP adapter: application code can register only typed query/command/device operations, never middleware. */
export const createAppPwaRouter = (service: AppPwaService) => {
  const guestBase = `${service.path}_api`;
  const staffBase = `/api/${service.appId}/app-pwa`;
  // AuthContext is used only to reuse platform rateLimit's IP mode. Guest handlers never read its identity slots.
  const router = new Hono<AuthContext>();
  const limiter = rateLimit({ keyBy: "ip" });
  router.onError((error, c) => {
    const safe = error instanceof AppPwaError ? error : new AppPwaError("UNAVAILABLE", 503);
    return c.json({ code: safe.code }, safe.status);
  });
  router.notFound((c) => c.json({ code: "NOT_FOUND" }, 404));
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, no-transform");
    c.header("Pragma", "no-cache");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Content-Type-Options", "nosniff");
    // No CORS middleware and no OPTIONS success. All transport methods are JSON POST, including passive reads.
    if (c.req.method !== "POST") return c.json({ code: "NOT_FOUND" }, 404);
    if (c.req.header("Origin") !== service.publicOrigin) return pwaFail("ORIGIN_REQUIRED", 403);
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(c.req.header("Content-Type") ?? "")) return pwaFail("JSON_REQUIRED", 415);
    return next();
  });
  router.use("*", async (c, next) => {
    const response = await limiter(c, next);
    return response instanceof Response && response.status === 429 ? c.json({ code: "RATE_LIMITED" }, 429) : response;
  });
  const body = (c: Context) => readAppPwaJson(c.req.raw, service.budgets.requestBytes, c.req.raw.signal);
  const credential = (c: Context): string => appPwaCredential(c.req.raw.headers, service);
  const web = async (c: Context): Promise<{ signIn: AppPwaWebSignIn; token: string }> => {
    if (c.req.header("Authorization")) return pwaFail("WEB_SESSION_REQUIRED", 401);
    appPwaCookie(c.req.header("Cookie") ?? null, "session_token");
    const token = session.getWebToken(c);
    const authenticated = token ? await session.authenticate(token) : null;
    if (!token || !authenticated || authenticated.data.kind !== "web") return pwaFail("WEB_SESSION_REQUIRED", 401);
    return { signIn: { userId: authenticated.user.id, sid: authenticated.data.sid }, token };
  };
  const staffCsrf = (token: string) => pairingSecret.hash(`cloud-app-pwa:staff:${service.appId}:${token}`);
  const staff = async (c: Context): Promise<AppPwaWebSignIn> => {
    const current = await web(c);
    const received = c.req.header("X-App-Pwa-CSRF");
    if (!received || !pairingSecret.matches(received, pairingSecret.hash(staffCsrf(current.token)))) return pwaFail("CSRF_REQUIRED", 403);
    return current.signIn;
  };
  router.post(`${guestBase}/bootstrap`, async (c) => {
    parse(empty, await body(c));
    const boot = await service.bootstrap(appPwaCookie(c.req.header("Cookie") ?? null, service.cookieName), c.req.raw.signal);
    setCookie(c, service.cookieName, boot.credential, {
      secure: true,
      httpOnly: true,
      sameSite: "Strict",
      path: service.path,
      // Session cookie: the durable browser expiry is authoritative and is never renewed by bootstrap.
    });
    return c.json({ csrf: boot.csrf });
  });
  router.post(`${guestBase}/device/claim`, async (c) => {
    const key = credential(c);
    const input = parse(AppPwaClaim, await body(c));
    return c.json(await service.claimDevice(key, input.qr, c.req.raw.signal));
  });
  router.post(`${guestBase}/visit/claim`, async (c) => {
    const key = credential(c);
    const input = parse(AppPwaClaim, await body(c));
    return c.json(await service.claimVisit(key, input.qr, c.req.raw.signal));
  });
  router.post(`${guestBase}/status`, async (c) => {
    const key = credential(c);
    parse(empty, await body(c));
    return c.json(await service.status(key, c.req.raw.signal));
  });
  router.post(`${guestBase}/visit/end`, async (c) => {
    const key = credential(c);
    const input = parse(visitIdInput, await body(c));
    return c.json(await service.endVisit(key, input.visitId, c.req.raw.signal));
  });
  router.post(`${guestBase}/visit/attempt`, async (c) => {
    const key = credential(c);
    const input = parse(z.strictObject({ visitId: AppPwaId, attemptId: AppPwaId }), await body(c));
    return c.json(await service.attempt(key, input.visitId, input.attemptId, c.req.raw.signal));
  });
  router.post(`${guestBase}/query/:route`, async (c) => {
    const key = credential(c);
    const input = parse(queryInput, await body(c));
    return c.json(await service.query(key, input.visitId, c.req.param("route"), input.input, c.req.raw.signal));
  });
  router.post(`${guestBase}/command/:route`, async (c) => {
    const key = credential(c);
    const input = parse(commandInput, await body(c));
    return c.json(await service.command(key, input.visitId, c.req.param("route"), input.attemptId, input.input, c.req.raw.signal));
  });
  router.post(`${guestBase}/device/:route`, async (c) => {
    const key = credential(c);
    const input = parse(z.strictObject({ input: z.unknown() }), await body(c));
    return c.json(await service.deviceOperation(key, c.req.param("route"), input.input, c.req.raw.signal));
  });
  router.post(`${staffBase}/bootstrap`, async (c) => {
    parse(empty, await body(c));
    const current = await web(c);
    // Authorization occurs on every real action, inside its service transaction.
    return c.json({ csrf: staffCsrf(current.token) });
  });
  router.post(`${staffBase}/devices/issue`, async (c) => {
    const signIn = await staff(c);
    const input = parse(z.strictObject({ requestId: AppPwaId, name: z.string() }), await body(c));
    return c.json(await service.issueDevice(signIn, input, c.req.raw.signal));
  });
  router.post(`${staffBase}/devices/list`, async (c) => {
    const signIn = await staff(c);
    const input = parse(z.strictObject({ after: AppPwaId.optional() }), await body(c));
    return c.json(await service.listDevices(signIn, input.after, c.req.raw.signal));
  });
  router.post(`${staffBase}/devices/status`, async (c) => {
    const signIn = await staff(c);
    const input = parse(deviceIdInput, await body(c));
    return c.json(await service.deviceStatus(signIn, input.deviceId, c.req.raw.signal));
  });
  router.post(`${staffBase}/devices/revoke`, async (c) => {
    const signIn = await staff(c);
    const input = parse(deviceIdInput, await body(c));
    return c.json(await service.revokeDevice(signIn, input.deviceId, c.req.raw.signal));
  });
  router.post(`${staffBase}/visits/issue`, async (c) => {
    const signIn = await staff(c);
    const input = parse(z.strictObject({ requestId: AppPwaId, deviceId: AppPwaId, subject: z.unknown() }), await body(c));
    return c.json(await service.issueVisit(signIn, input, c.req.raw.signal));
  });
  router.post(`${staffBase}/visits/revoke`, async (c) => {
    const signIn = await staff(c);
    const input = parse(z.strictObject({ deviceId: AppPwaId, visitId: AppPwaId }), await body(c));
    return c.json(await service.revokeVisit(signIn, input.deviceId, input.visitId, c.req.raw.signal));
  });
  // Exposing only fetch prevents app authors from accidentally appending an unguarded generic guest route.
  return {
    guestApiPath: guestBase,
    staffApiPath: staffBase,
    fetch: async (request: Request): Promise<Response> => {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_SECONDS * 1000)]);
      try {
        return await untilAppPwaAbort(signal, async () => router.fetch(new Request(request, { signal })));
      } catch {
        return Response.json(
          { code: "UNAVAILABLE" },
          {
            status: 503,
            headers: {
              "Cache-Control": "no-store, no-transform",
              Pragma: "no-cache",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
      }
    },
  };
};

export const createAppPwa = (options: AppPwaOptions) => {
  const service = createAppPwaService(options);
  return { service, router: createAppPwaRouter(service), setup: service.setup };
};
