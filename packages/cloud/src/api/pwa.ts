import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { describeRoute } from "hono-openapi";
import { z } from "zod";
import {
  isPwaShellAvailable,
  PWA_LIMITS,
  PwaDeviceListSchema,
  PwaPairingConfirmSchema,
  PwaPairingStartResultSchema,
  PwaPairingStatusSchema,
} from "../contracts/pwa";
import { type AuthContext, auth, jsonResponse, rateLimit, v } from "../server";
import { logger } from "../services/logging";
import { PwaError, pwaDevices } from "../services/pwa-devices";
import * as settings from "../services/settings";
import { publicCloudOrigin } from "../shared/app-url";
import { getRuntimeContext } from "../ssr/runtime";

export type PwaRouteOptions = {
  service?: typeof pwaDevices;
  /** True while the mobile app (the `pwa` application) is registered. */
  shellAvailable?: (c: Context) => boolean;
};

const log = logger("pwa");

const MESSAGES: Record<PwaError["code"], string> = {
  UNAVAILABLE: "The mobile app is not available right now.",
  REAUTHENTICATE: "Sign in again to pair a phone.",
  FORBIDDEN: "Use Cloud on the web for this.",
  ACCOUNT_BLOCKED: "This account cannot use the mobile app right now.",
  INVALID_REQUEST: "The request is not valid.",
  NOT_FOUND: "Not found.",
  EXPIRED: "This pairing has expired.",
  ALREADY_USED: "This pairing link was already used.",
  WRONG_CODE: "The code does not match.",
  CONFLICT: "The pairing is not at this step.",
  ALREADY_PAIRED: "This app is paired with another account.",
  ACCOUNT_MISMATCH: "This browser is signed in to another account.",
  LIMIT_REACHED: "The limit for this account was reached.",
  UNPAIRED: "This phone is not paired.",
};

/** `{ code, message }` with a safe English message; the UI maps codes to its own catalog. */
export const pwaErrorResponse = (c: Context, error: PwaError) =>
  c.json(
    { code: error.code, message: MESSAGES[error.code], ...(error.attemptsLeft !== undefined ? { attemptsLeft: error.attemptsLeft } : {}) },
    error.status,
  );

export const pwaInvalidRequest = () => ({ code: "INVALID_REQUEST", message: MESSAGES.INVALID_REQUEST });

/** Never log bodies, cookies, secrets, keys or codes: only the error name. */
export const handlePwaError = (error: Error, c: Context) => {
  if (error instanceof PwaError) return pwaErrorResponse(c, error);
  if (error instanceof HTTPException && error.status < 500) return pwaErrorResponse(c, new PwaError("INVALID_REQUEST", 400));
  log.error("Mobile app operation failed", { error: error.name || "UnknownError" });
  return pwaErrorResponse(c, new PwaError("UNAVAILABLE", 503));
};

/** Reads the live registry that Core's runtime middleware puts on every request. */
export const defaultShellAvailable = (c: Context): boolean => isPwaShellAvailable(getRuntimeContext(c).apps);

/**
 * No caching or referrers, JSON bodies within the limit, and an `Origin` equal to the
 * operator's canonical address on every non-GET request. Forwarded headers are never
 * trusted: behind the gateway they describe the internal hop.
 */
export const pwaTransport = (): MiddlewareHandler[] => [
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Vary", "Origin");
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const origin = c.req.header("Origin");
      if (!origin || origin !== publicCloudOrigin(await settings.get<string>("app.url"))) {
        return pwaErrorResponse(c, new PwaError("FORBIDDEN", 403));
      }
    }
    await next();
  },
  bodyLimit({ maxSize: PWA_LIMITS.bodyBytes, onError: (c) => pwaErrorResponse(c, new PwaError("INVALID_REQUEST", 400)) }),
];

const IdParamSchema = z.object({ id: z.string().uuid() });

/** The web session of a person: never the mobile app's session, an API key or an OAuth token. */
const webActor = async (c: Context) => {
  if (c.req.header("Authorization")) throw new PwaError("FORBIDDEN", 403);
  const token = auth.session.getWebToken(c);
  // Only the mobile app's session: pairing phones needs the web, a new sign-in would not help.
  if (!token && auth.session.getAppToken(c)) throw new PwaError("FORBIDDEN", 403);
  const session = token ? await auth.session.authenticateRequest(c, token) : null;
  if (!session) throw new PwaError("REAUTHENTICATE", 403);
  if (session.data.kind !== "web") throw new PwaError("FORBIDDEN", 403);
  return { userId: session.user.id, sid: session.data.sid };
};

/** The phone this request also comes from (Chrome on a paired Android phone shares the app's cookies). */
const currentDeviceId = async (c: Context, userId: string): Promise<string | null> => {
  const token = auth.session.getAppToken(c);
  const session = token ? await auth.session.authenticateRequest(c, token) : null;
  return session?.data.kind === "app" && session.user.id === userId ? (session.data.deviceId ?? null) : null;
};

const tags = ["Mobile app"];

/** Web side of the mobile app (preview), mounted by Core at `/api/auth/pwa/v1`. */
export const createPwaRoutes = (options: PwaRouteOptions = {}) => {
  const service = options.service ?? pwaDevices;
  const shellAvailable = options.shellAvailable ?? defaultShellAvailable;
  return new Hono<AuthContext>()
    .onError(handlePwaError)
    .use("*", ...pwaTransport())
    .use("*", rateLimit())
    .post(
      "/pairings",
      describeRoute({
        tags,
        summary: "Start pairing a phone",
        description: "Needs a web sign-in from the last ten minutes. The link secret is returned once.",
        responses: { 201: jsonResponse(PwaPairingStartResultSchema, "Pairing started") },
      }),
      async (c) => {
        const actor = await webActor(c);
        if (!shellAvailable(c)) throw new PwaError("UNAVAILABLE", 503);
        return c.json(await service.startPairing(actor), 201);
      },
    )
    .get(
      "/pairings/:id",
      describeRoute({
        tags,
        summary: "Read a pairing",
        description: "Only for the web session that started it. Never returns the code.",
        responses: { 200: jsonResponse(PwaPairingStatusSchema, "Pairing state") },
      }),
      v("param", IdParamSchema, pwaInvalidRequest),
      async (c) => c.json(await service.inspectPairing(await webActor(c), c.req.valid("param").id)),
    )
    .post(
      "/pairings/:id/confirm",
      describeRoute({ tags, summary: "Confirm a pairing with the code the phone shows", responses: { 204: { description: "Confirmed" } } }),
      v("param", IdParamSchema, pwaInvalidRequest),
      v("json", PwaPairingConfirmSchema, pwaInvalidRequest),
      async (c) => {
        await service.confirmPairing(await webActor(c), c.req.valid("param").id, c.req.valid("json").code);
        return c.body(null, 204);
      },
    )
    .post(
      "/pairings/:id/cancel",
      describeRoute({ tags, summary: "Cancel a pairing", responses: { 204: { description: "Cancelled" } } }),
      v("param", IdParamSchema, pwaInvalidRequest),
      async (c) => {
        await service.cancelPairing(await webActor(c), c.req.valid("param").id);
        return c.body(null, 204);
      },
    )
    .get(
      "/devices",
      describeRoute({ tags, summary: "List paired phones", responses: { 200: jsonResponse(PwaDeviceListSchema, "Active phones") } }),
      async (c) => {
        const actor = await webActor(c);
        return c.json({ items: await service.list(actor, await currentDeviceId(c, actor.userId)) });
      },
    )
    .delete(
      "/devices/:id",
      describeRoute({ tags, summary: "Remove a paired phone", responses: { 204: { description: "Removed; idempotent" } } }),
      v("param", IdParamSchema, pwaInvalidRequest),
      async (c) => {
        await service.revoke(await webActor(c), c.req.valid("param").id);
        return c.body(null, 204);
      },
    );
};
