import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { AppPwaError, appPwaCommand } from "./contracts";
import { appPwaQr, parseAppPwaQr } from "./protocol";
import { appPwaDigest, createAppPwaService } from "./service";
import { appPwaCookie, appPwaCredential, createAppPwaRouter } from "./transport";

const origin = "https://cloud.example.test";
const path = "/app/signing/customer/";
const secret = "a".repeat(43);
const options = {
  app: { id: "signing", installable: { path } },
  publicOrigin: origin,
  schema: "app_pwa_unit",
  subject: z.strictObject({ documentId: z.uuid() }),
  budgets: { requestBytes: 8192, responseBytes: 8192, listPageSize: 10, maxAccessIds: 10 },
  authorizeStaff: async () => true,
  authorizeVisit: async () => true,
};

describe("App-PWA protocol", () => {
  test.each(["device", "visit"] as const)("parses the exact %s QR without navigation", (kind) => {
    expect(parseAppPwaQr(appPwaQr(origin, path, { kind, secret }), origin, path)).toEqual({ kind, secret });
  });
  test("rejects URL normalization, foreign scopes and malformed secrets", () => {
    const qr = appPwaQr(origin, path, { kind: "visit", secret });
    for (const invalid of [
      qr.replace("https:", "http:"),
      qr.replace("cloud.example.test", "other.test"),
      qr.replace("https://", "https://user@"),
      qr.replace("/app/", "/x/../app/"),
      qr.replace("/customer/", "/other/"),
      qr.replace("#", "?x=1#"),
      qr.replace("#", "?#"),
      qr.replace("customer", "%63ustomer"),
      qr.replace("test/", "test:443/"),
      `${qr} `,
      ` ${qr}`,
      `${qr}\n`,
      `${qr}&extra=1`,
      qr.slice(0, -1),
      qr.replace("cloud-app-pwa", "pair"),
    ])
      expect(parseAppPwaQr(invalid, origin, path)).toBeNull();
  });
  test("rejects duplicate or empty protected cookies, regardless of cookie order", () => {
    expect(appPwaCookie("other=x; protected=abc", "protected")).toBe("abc");
    expect(() => appPwaCookie("protected=abc; protected=def", "protected")).toThrow(AppPwaError);
    expect(() => appPwaCookie("protected=abc; protected=abc", "protected")).toThrow(AppPwaError);
    expect(() => appPwaCookie("protected=", "protected")).toThrow(AppPwaError);
  });
  test("guest transport never falls back to employee identity and requires bound CSRF", () => {
    const service = createAppPwaService(options);
    expect(() =>
      appPwaCredential(new Headers({ cookie: "session_token=employee; pwa_session=phone", authorization: "Bearer employee" }), service),
    ).toThrow("BROWSER_REQUIRED");
    expect(() => appPwaCredential(new Headers({ cookie: `${service.cookieName}=bad` }), service)).toThrow("BROWSER_REQUIRED");
    const cookie = `${service.cookieName}=${secret}`;
    expect(() => appPwaCredential(new Headers({ cookie }), service)).toThrow("CSRF_REQUIRED");
    expect(() => appPwaCredential(new Headers({ cookie, "X-App-Pwa-CSRF": "other" }), service)).toThrow("CSRF_REQUIRED");
    expect(appPwaCredential(new Headers({ cookie, "X-App-Pwa-CSRF": service.csrf(secret) }), service)).toBe(secret);
    expect(() =>
      appPwaCredential(new Headers({ cookie: `${cookie}; ${cookie}`, "X-App-Pwa-CSRF": service.csrf(secret) }), service),
    ).toThrow("DUPLICATE_COOKIE");
  });
  test("cancelled transport returns a stable private failure without touching dependencies", async () => {
    const router = createAppPwaRouter(createAppPwaService(options));
    const response = await router.fetch(
      new Request(`${origin}${router.guestApiPath}/bootstrap`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.abort(),
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "UNAVAILABLE" });
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
  test("digest binds validated JSON without binding object property order", () => {
    expect(appPwaDigest({ a: 1, b: { x: 2, y: 3 } })).toBe(appPwaDigest({ b: { y: 3, x: 2 }, a: 1 }));
    expect(appPwaDigest({ a: 1 })).not.toBe(appPwaDigest({ a: "1" }));
    for (const value of [undefined, NaN, Infinity, new Date("2026-01-01T00:00:00Z"), { x: undefined }])
      expect(() => appPwaDigest(value)).toThrow(AppPwaError);
  });
  test("command input validation rejects before a handler can execute", () => {
    const operation = appPwaCommand({ input: z.strictObject({ revision: z.number().int() }), output: z.null(), handler: async () => null });
    expect(() => operation.parse({ revision: "1" })).toThrow(AppPwaError);
  });
  test("rejects invalid configuration and requires startup setup", async () => {
    expect(() => createAppPwaService({ ...options, publicOrigin: "http://cloud.example.test" })).toThrow();
    expect(() => createAppPwaService({ ...options, deviceTtlSeconds: 43201 })).not.toThrow();
    for (const ttl of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(() => createAppPwaService({ ...options, deviceTtlSeconds: ttl })).toThrow();
    expect(() => createAppPwaService({ ...options, schema: "x; DROP SCHEMA auth" })).toThrow();
    const withoutVisitPolicy = { ...options };
    Reflect.deleteProperty(withoutVisitPolicy, "authorizeVisit");
    expect(() => createAppPwaService(withoutVisitPolicy)).toThrow("visit-subject authorization");
    const service = createAppPwaService(options);
    expect(service.cookieName).toMatch(/^__Secure-cloud-app-pwa-signing-/);
    await expect(service.bootstrap()).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
  test("closed router rejects transport before dependencies and never exposes generic routes", async () => {
    const router = createAppPwaRouter(createAppPwaService(options));
    expect(Object.keys(router).sort()).toEqual(["fetch", "guestApiPath", "staffApiPath"]);
    for (const [headers, status, code] of [
      [{ "content-type": "application/json" }, 403, "ORIGIN_REQUIRED"],
      [{ origin: "https://other.test", "content-type": "application/json" }, 403, "ORIGIN_REQUIRED"],
      [{ origin, "content-type": "text/plain" }, 415, "JSON_REQUIRED"],
    ] as const) {
      const response = await router.fetch(
        new Request(`${origin}${router.guestApiPath}/bootstrap`, { method: "POST", headers, body: "{}" }),
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ code });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    }
    const response = await router.fetch(new Request(`${origin}${router.guestApiPath}/bootstrap`));
    expect(response.status).toBe(404);
  });
});
