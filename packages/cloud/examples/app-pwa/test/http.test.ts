import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { COUNTER_PATH, RESPONSE_BYTES } from "../src/constants";
import { createHttp, createKioskApi, createStaffApi, HttpFailure } from "../src/http";
import { KioskFailure } from "../src/model";
import { fixtureSnapshot } from "./fixtures";

const origin = "https://cloud.example.test";
const visitId = "10000000-0000-4000-8000-000000000001";
const otherId = "10000000-0000-4000-8000-000000000002";
const attempt = "20000000-0000-4000-8000-000000000001";
const iso = "2026-10-23T10:02:00.000Z";
const device = { id: otherId, name: "Laden-iPad", state: "active", expiresAt: iso };
const visit = { id: visitId, state: "active", expiresAt: iso, idleExpiresAt: iso };
const input = {
  documentId: "contract" as const,
  revision: 1,
  signature: { kind: "typed" as const, name: "Lea Muster", svg: "test adapter payload" },
  consent: true as const,
};
const signal = () => new AbortController().signal;
type Call = { url: string; init: RequestInit; body: Record<string, unknown> };
function fixture(handle: (call: Call) => unknown | Response | Promise<unknown | Response>) {
  const calls: Call[] = [];
  const send = async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const value = await handle(call);
    return value instanceof Response ? value : Response.json(value);
  };
  return { calls, fetch: send };
}
const normal = (call: Call): unknown => {
  if (call.url.endsWith("bootstrap")) return { csrf: "browser-bound-token" };
  if (call.url.endsWith("status")) return { device, visit };
  if (call.url.endsWith("query/document")) return fixtureSnapshot().visit;
  if (call.url.endsWith("device/claim")) return device;
  if (call.url.endsWith("visit/claim")) return visit;
  return { state: "revoked" };
};

describe("production App-PWA HTTP adapter", () => {
  test("bootstraps first, sends exact-origin JSON POST with CSRF, then queries the status visit", async () => {
    const f = fixture(normal);
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    expect((await api.snapshot(signal())).visit?.customerName).toBe("Lea Muster");
    expect(f.calls.map((call) => call.url)).toEqual([
      `${origin}${COUNTER_PATH}_api/bootstrap`,
      `${origin}${COUNTER_PATH}_api/status`,
      `${origin}${COUNTER_PATH}_api/query/document`,
    ]);
    for (const call of f.calls) {
      expect(call.init.method).toBe("POST");
      expect(call.init.credentials).toBe("same-origin");
      expect(call.init.redirect).toBe("error");
    }
    expect(new Headers(f.calls[0]?.init.headers).has("X-App-Pwa-CSRF")).toBe(false);
    expect(new Headers(f.calls[1]?.init.headers).get("X-App-Pwa-CSRF")).toBe("browser-bound-token");
    expect(f.calls[2]?.body).toEqual({ visitId, input: {} });
    expect(f.calls.some((call) => /command/.test(call.url))).toBe(false);
  });
  test("accepts only the strict target-app QR and never fetches its URL", async () => {
    const f = fixture(normal);
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    const qr = `${origin}${COUNTER_PATH}#cloud-app-pwa:device:${"A".repeat(43)}`;
    expect(api.acceptsQr(qr)).toBe(true);
    for (const invalid of [
      qr + " ",
      qr.replace("visit-demo", "other"),
      qr.replace("https:", "http:"),
      qr.replace("#", "?x=1#"),
      "javascript:alert(1)",
    ]) {
      expect(api.acceptsQr(invalid)).toBe(false);
      await expect(api.scan(invalid, signal())).rejects.toBeInstanceOf(KioskFailure);
    }
    expect(f.calls).toHaveLength(0);
    await api.scan(qr, signal());
    expect(f.calls[1]?.url).toBe(`${origin}${COUNTER_PATH}_api/device/claim`);
    expect(f.calls[1]?.body).toEqual({ qr });
  });
  test("recovers an unpaired browser neutrally with fresh bootstrap", async () => {
    const f = fixture((call) =>
      call.url.endsWith("status") ? Response.json({ code: "BROWSER_REQUIRED" }, { status: 401 }) : normal(call),
    );
    expect(await createKioskApi({ publicOrigin: origin, fetch: f.fetch }).snapshot(signal())).toEqual({ device: null, visit: null });
    expect(f.calls.filter((call) => call.url.endsWith("bootstrap"))).toHaveLength(2);
  });
  test("lost command reconciles the original visit and uses only non-sensitive completion", async () => {
    const f = fixture((call) => {
      if (call.url.includes("command/")) throw new TypeError("lost response");
      if (call.url.endsWith("visit/attempt")) return { state: "committed", completed: false };
      return normal(call);
    });
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    await api.snapshot(signal());
    await expect(api.sign(attempt, input, signal())).rejects.toThrow("lost response");
    expect(await api.reconcile(attempt, signal())).toBe("committed");
    expect(f.calls.at(-1)?.body).toEqual({ visitId, attemptId: attempt });
    expect(f.calls.filter((call) => call.url.includes("command/"))).toHaveLength(1);
  });
  test("an old pending attempt cannot claim a new customer's session", async () => {
    let currentVisit = visit;
    const f = fixture((call) => {
      if (call.url.endsWith("status")) return { device, visit: currentVisit };
      if (call.url.endsWith("query/document")) return { ...fixtureSnapshot().visit, id: currentVisit.id };
      if (call.url.includes("command/")) throw new TypeError("lost response");
      return normal(call);
    });
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    await api.snapshot(signal());
    await expect(api.sign(attempt, input, signal())).rejects.toThrow();
    currentVisit = { ...visit, id: otherId };
    await api.snapshot(signal());
    expect(await api.reconcile(attempt, signal())).toBe("absent");
    expect(f.calls.some((call) => call.url.endsWith("visit/attempt"))).toBe(false);
  });
  test("malformed, oversized and redirected/non-JSON responses fail closed", async () => {
    for (const response of [
      Response.json({ wrong: true }),
      new Response("{}", { headers: { "Content-Type": "text/html" } }),
      Response.json({ text: "x".repeat(RESPONSE_BYTES) }),
    ]) {
      const f = fixture(() => response);
      const http = createHttp({ publicOrigin: origin, fetch: f.fetch }, "/api/test");
      await expect(http.bootstrap(signal())).rejects.toBeInstanceOf(HttpFailure);
    }
  });
  test("schema-checks command output and closes using the current visit id", async () => {
    const f = fixture((call) => (call.url.includes("command/") ? { result: { completed: true }, replayed: false } : normal(call)));
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    await api.snapshot(signal());
    expect(await api.sign(attempt, input, signal())).toEqual({ completed: true });
    await api.end(attempt, signal());
    expect(f.calls.at(-1)?.body).toEqual({ visitId });
    expect(f.calls.at(-1)?.url).toEndWith("visit/end");
  });
  test("staff nullable claimed QR, QR expiry and bounded pagination use the public transport", async () => {
    const f = fixture((call) => {
      if (call.url.endsWith("bootstrap")) return { csrf: "staff-token" };
      if (call.url.endsWith("devices/list")) return { items: [device], next: otherId };
      if (call.url.endsWith("devices/issue")) return { ...device, qr: null, qrExpiresAt: iso };
      if (call.url.endsWith("visits/issue")) return { ...visit, qr: null, qrExpiresAt: iso };
      return normal(call);
    });
    const api = createStaffApi({ publicOrigin: origin, fetch: f.fetch });
    expect((await api.list(signal(), otherId)).next).toBe(otherId);
    expect(f.calls.at(-1)?.body).toEqual({ after: otherId });
    expect((await api.pair(attempt, "Laden-iPad", signal())).qr).toBeNull();
    expect((await api.visit(attempt, otherId, signal())).qrExpiresAt).toBe(iso);
    expect(new Headers(f.calls.at(-1)?.init.headers).get("X-App-Pwa-CSRF")).toBe("staff-token");
    expect(f.calls.at(-1)?.body).toEqual({ requestId: attempt, deviceId: otherId, subject: { customerId: visitId } });
  });
  test("generic channel rejects schema drift", async () => {
    const f = fixture((call) => (call.url.endsWith("bootstrap") ? { csrf: "token" } : { completed: "yes" }));
    const http = createHttp({ publicOrigin: origin, fetch: f.fetch }, "/api/test");
    await expect(http.call("command", {}, z.object({ completed: z.boolean() }), signal())).rejects.toBeInstanceOf(HttpFailure);
  });
});

test("final command and its lost response recover from public status without stored domain output", async () => {
  for (const lost of [false, true]) {
    const f = fixture((call) => {
      if (call.url.endsWith("query/document")) {
        const view = fixtureSnapshot().visit;
        if (view?.documents[0]) view.documents[0].signed = true;
        return view;
      }
      if (call.url.includes("command/")) {
        if (lost) throw new TypeError("final answer lost");
        return { state: "committed", completed: true, result: null, replayed: false };
      }
      if (call.url.endsWith("visit/attempt")) return { state: "committed", completed: true };
      return normal(call);
    });
    const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
    await api.snapshot(signal());
    const finalInput = { ...input, documentId: "receipt" as const };
    if (lost) {
      await expect(api.sign(attempt, finalInput, signal())).rejects.toThrow("final answer lost");
      expect(await api.reconcile(attempt, signal())).toBe("completed");
    } else expect(await api.sign(attempt, finalInput, signal())).toEqual({ completed: true });
    expect(f.calls.filter((call) => call.url.endsWith("query/document"))).toHaveLength(1);
  }
});

test("an aborted stale response cannot erase a newer visit binding", async () => {
  let release: ((response: Response) => void) | undefined;
  let defer = true;
  const f = fixture((call) => {
    if (call.url.endsWith("query/document") && defer) {
      defer = false;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }
    if (call.url.includes("command/")) return { result: { completed: false }, replayed: false };
    return normal(call);
  });
  const api = createKioskApi({ publicOrigin: origin, fetch: f.fetch });
  const controller = new AbortController();
  const stale = api.snapshot(controller.signal);
  const rejected = stale.then(
    () => false,
    () => true,
  );
  for (let tries = 0; !release && tries < 100; tries++) await Bun.sleep(1);
  if (!release) throw new Error("Deferred query did not start");
  controller.abort();
  await api.snapshot(signal());
  release(Response.json(fixtureSnapshot().visit));
  expect(await rejected).toBe(true);
  expect(await api.sign(attempt, input, signal())).toEqual({ completed: false });
  expect(f.calls.at(-1)?.body.visitId).toBe(visitId);
});
