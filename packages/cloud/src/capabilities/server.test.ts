import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { invokeCapability, invokeCapabilityWithDataSchema, reviewCapabilityAction } from "./server";

const originalFetch = globalThis.fetch;
const originalCoreOrigin = process.env.CLOUD_CORE_INTERNAL_ORIGIN;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalCoreOrigin === undefined) delete process.env.CLOUD_CORE_INTERNAL_ORIGIN;
  else process.env.CLOUD_CORE_INTERNAL_ORIGIN = originalCoreOrigin;
});

describe("server capability client", () => {
  test("sends the source credential and invocation metadata only to the configured Core origin", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal:3000/private/path";
    const forwarded: Request[] = [];
    let body: BodyInit | null | undefined;
    globalThis.fetch = (async (input, init) => {
      forwarded.push(input instanceof Request ? input : new Request(input, init));
      body = init?.body;
      return Response.json({ data: { id: "one" } });
    }) as typeof fetch;

    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "target app",
        capabilityId: "item.rename/unsafe",
        kind: "action",
        input: { id: "one" },
        idempotencyKey: "attempt-1",
      },
      z.object({ id: z.string() }).strict(),
      {
        authorization: "Bearer source-token",
        cookie: "session_token=source-session",
        requestId: "request-1",
        traceparent: "00-trace-parent",
        tracestate: "vendor=value",
        locale: "de-CH",
      },
    );

    expect(result).toEqual({ ok: true, data: { data: { id: "one" } } });
    const request = forwarded[0]!;
    expect(request.url).toBe("http://core.internal:3000/api/capabilities/v1/actions/target%20app/item.rename%2Funsafe");
    expect(request.url).not.toContain("target.invalid");
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toBe("Bearer source-token");
    expect(request.headers.get("cookie")).toBe("session_token=source-session");
    expect(request.headers.get("idempotency-key")).toBe("attempt-1");
    expect(request.headers.get("x-cloud-locale")).toBe("de-CH");
    expect(request.headers.get("x-request-id")).toBe("request-1");
    expect(request.headers.get("traceparent")).toBe("00-trace-parent");
    expect(request.headers.get("tracestate")).toBe("vendor=value");
    expect(body).toBe(JSON.stringify({ input: { id: "one" } }));
  });

  test("keeps response schema validation at the server-helper boundary", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.internal";
    globalThis.fetch = (async () => Response.json({ data: { id: 42 } })) as unknown as typeof fetch;

    const result = await invokeCapabilityWithDataSchema(
      { appId: "demo", capabilityId: "item.read", kind: "query", input: { id: "one" } },
      z.object({ id: z.string() }).strict(),
      {},
    );

    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 502 } });
  });

  test("sends a workload credential and mandate only to Core", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "http://core.internal:3000";
    let request: Request | undefined;
    let body: BodyInit | null | undefined;
    globalThis.fetch = (async (input, init) => {
      request = input instanceof Request ? input : new Request(input, init);
      body = init?.body;
      return Response.json({ data: { id: "one" } });
    }) as typeof fetch;

    const result = await invokeCapability(
      { appId: "spaces", capabilityId: "event.create", kind: "action", input: { title: "One" }, idempotencyKey: "job-7" },
      {
        authorization: "Bearer cld_mail-workload",
        cookie: "session_token=must-not-leave",
        requestId: "request-7",
        traceparent: "00-trace",
        locale: "de",
        mandate: { id: "11111111-1111-4111-8111-111111111111", revision: 4, callingAppId: "mail" },
      },
    );

    expect(result.ok).toBeTrue();
    expect(request?.url).toBe("http://core.internal:3000/api/_internal/identity/v1/invoke");
    expect(request?.headers.get("authorization")).toBe("Bearer cld_mail-workload");
    expect(request?.headers.get("x-cloud-app-id")).toBe("mail");
    expect(request?.headers.get("cookie")).toBeNull();
    expect(request?.headers.get("idempotency-key")).toBeNull();
    expect(JSON.parse(String(body))).toEqual({
      kind: "action",
      targetApp: "spaces",
      capabilityId: "event.create",
      input: { title: "One" },
      mandateId: "11111111-1111-4111-8111-111111111111",
      mandateRevision: 4,
      idempotencyKey: "job-7",
      metadata: { requestId: "request-7", traceparent: "00-trace", locale: "de" },
    });
  });

  test("distinguishes network failure, cancellation, and an unknown non-idempotent Action outcome", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.internal";
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const unavailable = await invokeCapability({ appId: "demo", capabilityId: "item.read", kind: "query", input: {} }, { locale: "de-CH" });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "APP_UNAVAILABLE", status: 503 } });

    globalThis.fetch = (async () => {
      throw new DOMException("cancelled", "AbortError");
    }) as unknown as typeof fetch;
    const cancelled = await invokeCapability({ appId: "demo", capabilityId: "item.read", kind: "query", input: {} }, { locale: "de-CH" });
    expect(cancelled).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED", status: 499 } });

    const unknown = await invokeCapability({ appId: "demo", capabilityId: "item.rename", kind: "action", input: {} }, { locale: "de-CH" });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: "ACTION_OUTCOME_UNKNOWN", status: 502, details: { retrySafe: false } },
    });
  });

  test("combines caller and invocation cancellation and keeps Action review read-only", async () => {
    process.env.CLOUD_CORE_INTERNAL_ORIGIN = "https://core.internal";
    const caller = new AbortController();
    const invocation = new AbortController();
    const requests: Request[] = [];
    globalThis.fetch = (async (input) => {
      const request = input as Request;
      requests.push(request);
      if (request.signal.aborted) throw request.signal.reason;
      return Response.json({ message: "Review item." });
    }) as typeof fetch;

    caller.abort(new DOMException("caller cancelled", "AbortError"));
    const cancelled = await reviewCapabilityAction(
      { appId: "demo", capabilityId: "item.rename", input: { id: "one" }, signal: invocation.signal },
      { signal: caller.signal, locale: "en" },
    );
    expect(cancelled).toMatchObject({ ok: false, error: { code: "REQUEST_CANCELLED", status: 499 } });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[0]?.url).toBe("https://core.internal/api/capabilities/v1/actions/demo/item.rename/review");
    expect(requests[0]?.headers.get("idempotency-key")).toBeNull();
  });
});
