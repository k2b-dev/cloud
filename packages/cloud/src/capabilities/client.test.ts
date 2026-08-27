import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { invokeCapability, invokeCapabilityWithDataSchema, listCapabilityCatalog, reviewCapabilityAction } from "./client";

describe("public capability client", () => {
  test("uses the public route and forwards the idempotency key", async () => {
    let url = "";
    let request: RequestInit | undefined;
    const result = await invokeCapabilityWithDataSchema(
      {
        appId: "demo app",
        capabilityId: "item.rename",
        kind: "action",
        input: { id: "one" },
        idempotencyKey: "attempt-1",
      },
      z.object({ id: z.string() }).passthrough(),
      {
        fetch: async (input, init) => {
          url = String(input);
          request = init;
          return Response.json({ data: { id: "one" } });
        },
      },
    );

    expect(result).toEqual({ ok: true, data: { data: { id: "one" } } });
    expect(url).toBe("/api/capabilities/v1/actions/demo%20app/item.rename");
    expect(new Headers(request?.headers).get("idempotency-key")).toBe("attempt-1");
    expect(request?.credentials).toBe("same-origin");
  });

  test("requires a runtime schema for typed data and validates it", async () => {
    const result = await invokeCapabilityWithDataSchema(
      { appId: "demo", capabilityId: "get", kind: "query", input: {} },
      z.object({ id: z.string() }).passthrough(),
      { fetch: async () => Response.json({ data: { id: 42 } }) },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 502 } });
  });

  test("loads and validates the public catalog", async () => {
    let url = "";
    const result = await listCapabilityCatalog({
      cursor: "demo",
      limit: 10,
      fetch: async (input) => {
        url = String(input);
        return Response.json({ protocolVersion: 1, apps: [], page: { hasMore: false } });
      },
    });
    expect(result).toEqual({ ok: true, data: { protocolVersion: 1, apps: [], page: { hasMore: false } } });
    expect(url).toBe("/api/capabilities/v1/catalog?cursor=demo&limit=10");
  });

  test("accepts a valid catalog page larger than the invocation result limit", async () => {
    const operation = (index: number) => ({
      localId: `query-${index}`,
      title: `Query ${index}`,
      description: "d".repeat(1000),
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      dataSchema: { type: "object", properties: {}, additionalProperties: false },
      schemaHash: "0".repeat(64),
      openWorld: false,
    });
    const app = (appId: string) => ({
      appId,
      appName: appId,
      appIcon: "ti ti-box",
      appDescription: "",
      manifest: {
        protocolVersion: 1 as const,
        appId,
        manifestHash: "0".repeat(64),
        types: [],
        queries: Array.from({ length: 200 }, (_, index) => operation(index)),
        actions: [],
      },
    });
    const payload = { protocolVersion: 1, apps: [app("one"), app("two")], page: { hasMore: false } };
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeGreaterThan(256 * 1024);

    const result = await listCapabilityCatalog({ fetch: async () => Response.json(payload) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.apps).toHaveLength(2);
  });

  test("returns structured Cloud errors without throwing", async () => {
    const result = await invokeCapability(
      { appId: "demo", capabilityId: "get", kind: "query", input: {} },
      {
        fetch: async () => Response.json({ code: "FORBIDDEN", message: "No access" }, { status: 403 }),
      },
    );

    expect(result).toEqual({ ok: false, error: { code: "FORBIDDEN", message: "No access", status: 403 } });
  });

  test("fails closed on invalid success envelopes and network failures", async () => {
    const invalid = await invokeCapability(
      { appId: "demo", capabilityId: "get", kind: "query", input: {} },
      {
        fetch: async () => Response.json({ value: 1 }),
      },
    );
    const unavailable = await invokeCapability(
      { appId: "demo", capabilityId: "get", kind: "query", input: {} },
      {
        headers: { "x-cloud-locale": "de-CH" },
        fetch: async () => {
          throw new Error("offline");
        },
      },
    );

    expect(invalid).toMatchObject({ ok: false, error: { code: "INVALID_APP_RESPONSE", status: 502 } });
    expect(unavailable).toMatchObject({ ok: false, error: { code: "APP_UNAVAILABLE", message: "Cloud ist nicht verfügbar", status: 503 } });
  });

  test("marks a lost non-idempotent Action response as outcome unknown", async () => {
    const result = await invokeCapability(
      { appId: "demo", capabilityId: "rename", kind: "action", input: {} },
      {
        fetch: async () => {
          throw new Error("offline");
        },
      },
    );
    expect(result).toMatchObject({
      ok: false,
      error: { code: "ACTION_OUTCOME_UNKNOWN", status: 502, details: { retrySafe: false } },
    });

    const unreadable = await invokeCapability(
      { appId: "demo", capabilityId: "rename", kind: "action", input: {} },
      {
        fetch: async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200 },
          ),
      },
    );
    expect(unreadable).toMatchObject({ ok: false, error: { code: "ACTION_OUTCOME_UNKNOWN" } });
  });

  test("uses the Action review route", async () => {
    let url = "";
    const result = await reviewCapabilityAction(
      { appId: "demo", capabilityId: "rename", input: { id: "one" } },
      {
        fetch: async (input) => {
          url = String(input);
          return Response.json({ message: "Rename one." });
        },
      },
    );

    expect(result).toEqual({ ok: true, data: { message: "Rename one." } });
    expect(url).toBe("/api/capabilities/v1/actions/demo/rename/review");
  });
});
