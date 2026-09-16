import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import capabilitiesCliModule from "./capabilities";
import type { CloudCliContext, CloudCliFlags } from "./index";

const createContext = (args: string[], flags: CloudCliFlags, fetch: CloudCliContext["fetch"]) => {
  const lines: string[] = [];
  const ctx: CloudCliContext = {
    args,
    flags,
    options: { profile: "test", server: "http://cloud.test", token: "token", output: "json" },
    getDefault: async () => undefined,
    setDefault: async () => undefined,
    createApiClient: (() => {
      throw new Error("not needed");
    }) as CloudCliContext["createApiClient"],
    fetch,
    readJson: async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(`${response.status} ${(body as { message?: string }).message ?? "Request failed"}`);
      return body;
    },
    print: (value = "") => lines.push(value),
    write: async (value) => void lines.push(value),
    error: (value) => lines.push(value),
    json: (value) => lines.push(JSON.stringify(value)),
    jsonLine: (value) => lines.push(JSON.stringify(value)),
    table: () => undefined,
  };
  return { ctx, lines };
};

describe("capabilities CLI", () => {
  test("discovers and invokes a canonical resource reader across catalog pages", async () => {
    const manifest = compileCapabilities(
      "contacts",
      defineCapabilities({
        protocolVersion: 2,
        types: { contact: { title: "Contact", description: "One contact.", reader: "contact.read" } },
        queries: {
          "contact.read": {
            title: "Read contact",
            description: "Read one contact.",
            input: z.object({ id: z.string().describe("Stable contact id.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            openWorld: false,
            run: async ({ id }) => ok({ data: { id } }),
          },
        },
      }),
    ).manifest;
    const requests: Array<{ path: string; body?: unknown }> = [];
    const { ctx, lines } = createContext(["read", "contacts.contact", "contact-1"], {}, async (path, init) => {
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path.includes("cursor=")) {
        return Response.json({
          protocolVersion: 2,
          apps: [
            {
              appId: "contacts",
              appName: "Contacts",
              appIcon: "ti ti-address-book",
              appDescription: "Contacts",
              manifest,
            },
          ],
          page: { hasMore: false },
        });
      }
      if (path.startsWith("/api/capabilities/v1/catalog")) {
        return Response.json({ protocolVersion: 2, apps: [], page: { hasMore: true, nextCursor: "before-contacts" } });
      }
      return Response.json({ data: { id: "contact-1" } });
    });
    await capabilitiesCliModule.run(ctx);
    expect(requests.at(-1)).toEqual({
      path: "/api/capabilities/v1/queries/contacts/contact.read",
      body: { input: { id: "contact-1" } },
    });
    expect(lines).toEqual(['{"data":{"id":"contact-1"}}']);
  });

  test("fails closed for missing apps, Types without readers, and repeated catalog cursors", async () => {
    const missing = createContext(["read", "missing.item", "one"], {}, async () =>
      Response.json({ protocolVersion: 2, apps: [], page: { hasMore: false } }),
    );
    await expect(capabilitiesCliModule.run(missing.ctx)).rejects.toThrow("Capability app missing is unavailable");

    const noReaderManifest = compileCapabilities(
      "contacts",
      defineCapabilities({
        protocolVersion: 2,
        types: { contact: { title: "Contact", description: "One contact." } },
      }),
    ).manifest;
    const noReader = createContext(["read", "contacts.contact", "one"], {}, async () =>
      Response.json({
        protocolVersion: 2,
        apps: [
          {
            appId: "contacts",
            appName: "Contacts",
            appIcon: "ti ti-address-book",
            appDescription: "Contacts",
            manifest: noReaderManifest,
          },
        ],
        page: { hasMore: false },
      }),
    );
    await expect(capabilitiesCliModule.run(noReader.ctx)).rejects.toThrow("unknown or has no reader");

    const repeated = createContext(["read", "missing.item", "one"], {}, async () =>
      Response.json({ protocolVersion: 2, apps: [], page: { hasMore: true, nextCursor: "same" } }),
    );
    await expect(capabilitiesCliModule.run(repeated.ctx)).rejects.toThrow("repeated cursor");
  });

  test("invokes a query with strict JSON input", async () => {
    let request: { path: string; init?: RequestInit } | undefined;
    const { ctx, lines } = createContext(
      ["query", "contacts", "search"],
      { input: '{"query":"Ada","tags":[],"limit":5}' },
      async (path, init) => {
        request = { path, init };
        return Response.json({ data: [] });
      },
    );
    await capabilitiesCliModule.run(ctx);
    expect(request?.path).toBe("/api/capabilities/v1/queries/contacts/search");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ input: { query: "Ada", tags: [], limit: 5 } });
    expect(lines).toEqual(['{"data":[]}']);
  });

  test("omits an idempotency key for actions that do not require one", async () => {
    const keys: Array<string | null> = [];
    const { ctx } = createContext(["action", "example", "refresh"], { input: "{}" }, async (_path, init) => {
      keys.push(new Headers(init?.headers).get("idempotency-key"));
      return Response.json({ data: {} });
    });
    await capabilitiesCliModule.run(ctx);
    expect(keys).toEqual([null]);
  });

  test("forwards the idempotency key", async () => {
    const keys: Array<string | null> = [];
    const { ctx } = createContext(
      ["action", "contacts", "create"],
      { input: '{"bookId":"one","label":"Ada"}', "idempotency-key": "contact-ada" },
      async (_path, init) => {
        keys.push(new Headers(init?.headers).get("idempotency-key"));
        return Response.json({ data: { id: "one" } });
      },
    );
    await capabilitiesCliModule.run(ctx);
    expect(keys).toEqual(["contact-ada"]);
  });

  test("warns against retrying a non-idempotent Action after network loss", async () => {
    const { ctx } = createContext(["action", "example", "refresh"], { input: "{}" }, async () => {
      throw new Error("connection reset");
    });
    await expect(capabilitiesCliModule.run(ctx)).rejects.toThrow("ACTION_OUTCOME_UNKNOWN");
    await expect(capabilitiesCliModule.run(ctx)).rejects.toThrow("do not retry automatically");
  });

  test("warns against retrying a non-idempotent Action after response body loss", async () => {
    const { ctx } = createContext(["action", "example", "refresh"], { input: "{}" }, async () => {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("connection reset"));
          },
        }),
      );
    });
    await expect(capabilitiesCliModule.run(ctx)).rejects.toThrow("ACTION_OUTCOME_UNKNOWN");
  });

  test("rejects oversized capability results before parsing", async () => {
    const { ctx } = createContext(["query", "contacts", "search"], { input: "{}" }, async () => {
      return new Response("x".repeat(300 * 1024));
    });
    await expect(capabilitiesCliModule.run(ctx)).rejects.toThrow("RESPONSE_TOO_LARGE");
  });

  test("accepts catalog pages above the invocation result limit", async () => {
    const payload = JSON.stringify({ protocolVersion: 2, apps: [], page: { hasMore: false } });
    const { ctx, lines } = createContext(["catalog"], {}, async () => new Response(`${" ".repeat(300 * 1024)}${payload}`));
    await capabilitiesCliModule.run(ctx);
    expect(lines).toContain(payload);
  });

  test("rejects invalid catalog and invocation envelopes", async () => {
    const invalidCatalog = createContext(["catalog"], {}, async () => Response.json({ protocolVersion: 2, apps: [] }));
    await expect(capabilitiesCliModule.run(invalidCatalog.ctx)).rejects.toThrow();

    const invalidResult = createContext(["query", "contacts", "search"], { input: "{}" }, async () => Response.json({ value: [] }));
    await expect(capabilitiesCliModule.run(invalidResult.ctx)).rejects.toThrow();
  });
});
