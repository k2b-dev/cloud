import { clearAppPwaFragment, parseAppPwaQr } from "@k2b/cloud/app-pwa/browser";
import { z } from "zod";
import { COUNTER_PATH, DEVICE_PAGE_SIZE, REQUEST_BYTES, RESPONSE_BYTES, STAFF_API_PATH, SUBJECT_ID } from "./constants";
import { type KioskApi, KioskFailure, VisitViewSchema } from "./model";
import type { StaffApi } from "./Staff";

const Id = z.uuid();
export const DeviceSchema = z.object({
  id: Id,
  name: z.string(),
  state: z.enum(["pending", "active", "revoked", "expired"]),
  expiresAt: z.iso.datetime().nullable(),
});
const VisitStatusSchema = z.object({
  id: Id,
  state: z.enum(["pending", "active", "revoked", "ended", "expired"]),
  expiresAt: z.iso.datetime().nullable(),
  idleExpiresAt: z.iso.datetime().nullable(),
});
const StatusSchema = z.object({ device: DeviceSchema.nullable(), visit: VisitStatusSchema.nullable() });
export const PageSchema = z.object({ items: z.array(DeviceSchema).max(DEVICE_PAGE_SIZE), next: Id.nullable() });
const PairSchema = DeviceSchema.extend({ qr: z.string().nullable(), qrExpiresAt: z.iso.datetime() });
const VisitQrSchema = VisitStatusSchema.extend({ qr: z.string().nullable(), qrExpiresAt: z.iso.datetime() });
const BootstrapSchema = z.strictObject({ csrf: z.string().min(1) });
const RevokedSchema = z.object({ state: z.literal("revoked") });
const CommandSchema = z.union([
  z.object({ result: z.strictObject({ completed: z.boolean() }), replayed: z.boolean() }),
  z.object({ state: z.literal("committed"), completed: z.boolean(), result: z.null(), replayed: z.boolean() }),
]);
const AttemptSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("unknown") }),
  z.strictObject({ state: z.literal("committed"), completed: z.boolean() }),
]);
export class HttpFailure extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export type HttpOptions = { publicOrigin: string; fetch?: (input: string, init: RequestInit) => Promise<Response> };

/** One same-origin, bounded JSON channel. No credentials/functions cross island props. */
export function createHttp(options: HttpOptions, base: string) {
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin) throw new Error("Canonical HTTPS origin required");
  const send = options.fetch ?? globalThis.fetch;
  let csrf: string | undefined;
  const post = async <T>(path: string, body: unknown, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> => {
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > REQUEST_BYTES) throw new HttpFailure("TOO_LARGE", 413);
    // Ten seconds is this example's explicit foreground recovery budget.
    const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const response = await send(`${origin.origin}${base}/${path}`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal: boundedSignal,
      headers: { "Content-Type": "application/json", ...(csrf ? { "X-App-Pwa-CSRF": csrf } : {}) },
      body: serialized,
    });
    if (!/^application\/json(?:;|$)/i.test(response.headers.get("Content-Type") ?? "")) throw new HttpFailure("UNAVAILABLE", 503);
    const reader = response.body?.getReader();
    if (!reader) throw new HttpFailure("UNAVAILABLE", 503);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > RESPONSE_BYTES) {
          await reader.cancel();
          throw new HttpFailure("TOO_LARGE", 413);
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const data = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
    } catch {
      throw new HttpFailure("UNAVAILABLE", 503);
    }
    if (!response.ok) {
      const error = z.object({ code: z.string() }).safeParse(value);
      throw new HttpFailure(error.success ? error.data.code : "UNAVAILABLE", response.status);
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new HttpFailure("UNAVAILABLE", 503);
    signal.throwIfAborted();
    return result.data;
  };
  const bootstrap = async (signal: AbortSignal) => {
    csrf = undefined;
    csrf = (await post("bootstrap", {}, BootstrapSchema, signal)).csrf;
  };
  const call = async <T>(path: string, body: unknown, schema: z.ZodType<T>, signal: AbortSignal) => {
    if (!csrf) await bootstrap(signal);
    return post(path, body, schema, signal);
  };
  return { call, bootstrap };
}

export function createKioskApi(options: HttpOptions): KioskApi {
  const http = createHttp(options, `${COUNTER_PATH}_api`);
  let visitId: string | undefined;
  let pending: { attempt: string; visitId: string } | undefined;
  const invalidBrowser = (error: unknown) =>
    error instanceof HttpFailure &&
    ["BROWSER_REQUIRED", "EXPIRED", "REVOKED", "WEB_SESSION_REQUIRED", "DUPLICATE_COOKIE", "CSRF_REQUIRED"].includes(error.code);
  const neutralize = async (error: unknown, signal: AbortSignal) => {
    signal.throwIfAborted();
    visitId = undefined;
    pending = undefined;
    if (invalidBrowser(error)) await http.bootstrap(signal);
  };
  const convert = (error: unknown): never => {
    if (error instanceof HttpFailure) {
      if (["INVALID_QR", "ALREADY_CLAIMED", "ACTIVE_VISIT"].includes(error.code)) throw new KioskFailure("qr_unavailable");
      if (error.code === "APP_REVISION_CONFLICT") throw new KioskFailure("conflict");
      if (["EXPIRED", "BROWSER_REQUIRED"].includes(error.code)) throw new KioskFailure("expired");
      if (["REVOKED", "WEB_SESSION_REQUIRED", "FORBIDDEN", "NOT_FOUND"].includes(error.code)) throw new KioskFailure("forbidden");
    }
    throw error;
  };
  return {
    acceptsQr: (text) => Boolean(parseAppPwaQr(text, options.publicOrigin, COUNTER_PATH)),
    snapshot: async (signal) => {
      try {
        const status = await http.call("status", {}, StatusSchema, signal);
        visitId = status.visit?.id;
        if (pending && pending.visitId !== visitId) pending = undefined;
        const visit = visitId ? await http.call("query/document", { visitId, input: {} }, VisitViewSchema, signal) : null;
        if (visit && visit.id !== visitId) throw new HttpFailure("UNAVAILABLE", 503);
        return { device: status.device ? { name: status.device.name } : null, visit };
      } catch (error) {
        if (error instanceof HttpFailure && error.code === "BROWSER_REQUIRED") {
          await neutralize(error, signal);
          return { device: null, visit: null };
        }
        await neutralize(error, signal);
        return convert(error);
      }
    },
    scan: async (text, signal) => {
      // Fragment removal is synchronous and happens before any bootstrap request.
      clearAppPwaFragment();
      const qr = parseAppPwaQr(text, options.publicOrigin, COUNTER_PATH);
      if (!qr) throw new KioskFailure("qr_unavailable");
      pending = undefined;
      visitId = undefined;
      try {
        await http.bootstrap(signal);
        if (qr.kind === "device") await http.call("device/claim", { qr: text }, DeviceSchema, signal);
        else await http.call("visit/claim", { qr: text }, VisitStatusSchema, signal);
      } catch (error) {
        await neutralize(error, signal);
        return convert(error);
      }
    },
    sign: async (attempt, input, signal) => {
      if (!visitId) throw new KioskFailure("expired");
      pending = { attempt, visitId };
      try {
        const result = await http.call(
          `command/sign-${input.documentId}`,
          { visitId: pending.visitId, attemptId: attempt, input },
          CommandSchema,
          signal,
        );
        pending = undefined;
        return result.result === null ? { completed: result.completed } : result.result;
      } catch (error) {
        if (invalidBrowser(error)) await neutralize(error, signal);
        return convert(error);
      }
    },
    reconcile: async (attempt, signal) => {
      const original = pending;
      // A stale attempt never acquires the current customer's visit id.
      if (!original || original.attempt !== attempt) return "absent";
      try {
        const result = await http.call("visit/attempt", { visitId: original.visitId, attemptId: attempt }, AttemptSchema, signal);
        pending = undefined;
        return result.state === "unknown" ? "absent" : result.completed ? "completed" : "committed";
      } catch (error) {
        if (invalidBrowser(error)) await neutralize(error, signal);
        return convert(error);
      }
    },
    end: async (_attempt, signal) => {
      if (!visitId) {
        pending = undefined;
        return;
      }
      try {
        await http.call("visit/end", { visitId }, RevokedSchema, signal);
        pending = undefined;
        visitId = undefined;
      } catch (error) {
        if (invalidBrowser(error)) await neutralize(error, signal);
        return convert(error);
      }
    },
  };
}
export function createStaffApi(options: HttpOptions): StaffApi {
  const http = createHttp(options, STAFF_API_PATH);
  return {
    status: (deviceId, signal) => http.call("devices/status", { deviceId }, DeviceSchema, signal),
    list: (signal, after) => http.call("devices/list", after ? { after } : {}, PageSchema, signal),
    pair: (requestId, name, signal) => http.call("devices/issue", { requestId, name }, PairSchema, signal),
    revoke: async (id, signal) => {
      await http.call("devices/revoke", { deviceId: id }, RevokedSchema, signal);
    },
    visit: (requestId, deviceId, signal) =>
      http.call("visits/issue", { requestId, deviceId, subject: { customerId: SUBJECT_ID } }, VisitQrSchema, signal),
  };
}
