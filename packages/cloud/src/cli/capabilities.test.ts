import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { futureLibrary } from "../../test/future-capability-manifest";
import { compileCapabilities } from "../_internal/capabilities";
import { reviewFixture } from "../_internal/capability-review.test-fixture";
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
  test.each(["json", "jsonl", "text"] as const)(
    "discovers and invokes a canonical resource reader across catalog pages in %s",
    async (output) => {
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
        return Response.json({
          data: { id: "contact-1" },
          refs: [
            { type: "contacts.contact", id: "contact-1" },
            { type: "foreign.item", id: "one" },
          ],
        });
      });
      ctx.options.output = output;
      await capabilitiesCliModule.run(ctx);
      expect(requests.findLast((request) => !request.path.includes("/catalog?"))).toEqual({
        path: "/api/capabilities/v1/queries/contacts/contact.read",
        body: { input: { id: "contact-1" } },
      });
      expect(JSON.parse(lines[0] ?? "")).toEqual({
        data: { id: "contact-1" },
        refs: [
          {
            type: "contacts.contact",
            id: "contact-1",
            permalink: "http://cloud.test/open/contacts.contact/~contact-1",
          },
          { type: "foreign.item", id: "one" },
        ],
      });
    },
  );

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
    const requests: string[] = [];
    const { ctx, lines } = createContext(
      ["query", "contacts", "search"],
      { input: '{"query":"Ada","tags":[],"limit":5}' },
      async (path, init) => {
        requests.push(path);
        request = { path, init };
        return Response.json({ data: [] });
      },
    );
    await capabilitiesCliModule.run(ctx);
    expect(request?.path).toBe("/api/capabilities/v1/queries/contacts/search");
    expect(JSON.parse(String(request?.init?.body))).toEqual({ input: { query: "Ada", tags: [], limit: 5 } });
    expect(lines).toEqual(['{"data":[]}']);
    expect(requests).toEqual(["/api/capabilities/v1/queries/contacts/search"]);
  });

  test("keeps resource card facts and ignores unfamiliar reference presentation in CLI JSON output", async () => {
    const ref = { type: "contacts.contact", id: "one", context: "Contact in Team", status: "Active" };
    const { ctx, lines } = createContext(["query", "contacts", "read"], { input: '{"id":"one"}' }, async (path) =>
      path.includes("catalog")
        ? Response.json({ protocolVersion: 2, apps: [], page: { hasMore: false } })
        : Response.json({ data: {}, refs: [{ ...ref, futurePresentation: "ignored" }] }),
    );
    await capabilitiesCliModule.run(ctx);
    expect(JSON.parse(lines[0]!)).toMatchObject({ refs: [ref] });
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

  test("reads catalog pages from a newer Cloud release", async () => {
    const page = {
      protocolVersion: 2,
      generatedAt: "2027-01-01T00:00:00Z",
      apps: [{ appId: "library", appName: "Library", appIcon: "ti ti-books", appDescription: "Books", manifest: futureLibrary().manifest }],
      page: { hasMore: false },
    };
    const catalog = createContext(["catalog"], {}, async () => Response.json(page));
    await capabilitiesCliModule.run(catalog.ctx);
    const listed = JSON.parse(catalog.lines[0]!);
    expect(listed).not.toHaveProperty("generatedAt");
    expect(listed.apps[0].manifest).not.toHaveProperty("fileProvider");
    expect(listed.apps[0].manifest.queries.map((query: { localId: string }) => query.localId)).toEqual(["book.read"]);

    const requests: string[] = [];
    const read = createContext(["read", "library.book", "b1"], {}, async (path) => {
      requests.push(path);
      return path.startsWith("/api/capabilities/v1/catalog") ? Response.json(page) : Response.json({ data: { id: "b1", name: "Book" } });
    });
    await capabilitiesCliModule.run(read.ctx);
    expect(requests.at(-1)).toBe("/api/capabilities/v1/queries/library/book.read");
  });

  test("rejects invalid catalog and invocation envelopes", async () => {
    const invalidCatalog = createContext(["catalog"], {}, async () => Response.json({ protocolVersion: 2, apps: [] }));
    await expect(capabilitiesCliModule.run(invalidCatalog.ctx)).rejects.toThrow();

    const invalidResult = createContext(["query", "contacts", "search"], { input: "{}" }, async () => Response.json({ value: [] }));
    await expect(capabilitiesCliModule.run(invalidResult.ctx)).rejects.toThrow();
  });
});

test.each(["query", "action"] as const)("%s emits absolute provider links and canonical permalinks for multiple refs", async (kind) => {
  const manifest = compileCapabilities(
    "demo",
    defineCapabilities({
      protocolVersion: 2,
      types: { item: { title: "Item", description: "An item", reader: "read" } },
      queries: {
        read: {
          title: "Read",
          description: "Read an item",
          input: z.object({ id: z.string().describe("Stable resource id") }).strict(),
          data: z.unknown(),
          openWorld: false,
          run: () => ok({ data: {} }),
        },
      },
    }),
  ).manifest;
  const { ctx, lines } = createContext([kind, "demo", "operation"], { input: "{}" }, async (path) =>
    path.includes("/catalog?")
      ? Response.json({
          protocolVersion: 2,
          apps: [{ appId: "demo", appName: "Demo", appIcon: "ti ti-box", appDescription: "Demo", manifest }],
          page: { hasMore: false },
        })
      : Response.json({
          data: [{ ref: { type: "demo.item", id: ".." }, links: [{ rel: "open", href: "/app/demo/one" }] }],
          refs: [
            { type: "demo.item", id: ".." },
            { type: "demo.item", id: "two" },
            { type: "demo.item", id: "\ud800" },
          ],
          links: [{ rel: "open", href: "/app/demo" }],
        }),
  );
  await capabilitiesCliModule.run(ctx);
  expect(JSON.parse(lines[0] ?? "")).toMatchObject({
    data: [{ links: [{ rel: "open", href: "http://cloud.test/app/demo/one" }] }],
    refs: [
      { permalink: "http://cloud.test/open/demo.item/~.." },
      { permalink: "http://cloud.test/open/demo.item/~two" },
      { type: "demo.item", id: "\ud800" },
    ],
    links: [{ rel: "open", href: "http://cloud.test/app/demo" }],
  });
  expect(JSON.parse(lines[0] ?? "").refs[2]).toEqual({ type: "demo.item", id: "\ud800" });
});

test("catalog enrichment failure does not hide a successful action", async () => {
  const { ctx, lines } = createContext(["action", "demo", "create"], { input: "{}" }, async (path) => {
    if (path.includes("/catalog?")) throw new Error("Registry offline");
    return Response.json({
      data: { id: "one" },
      refs: [{ type: "demo.item", id: "one" }],
      links: [{ rel: "open", href: "/app/demo/one" }],
    });
  });
  await capabilitiesCliModule.run(ctx);
  expect(lines.slice(0, -1)).toEqual(["The capability catalog is unavailable; some resource permalinks could not be added."]);
  expect(JSON.parse(lines.at(-1) ?? "")).toMatchObject({ data: { id: "one" }, links: [{ href: "http://cloud.test/app/demo/one" }] });
});

test("repeated catalog cursors warn once and preserve a successful result", async () => {
  const requests: string[] = [];
  const { ctx, lines } = createContext(["query", "demo", "read"], { input: "{}" }, async (path) => {
    requests.push(path);
    return Response.json(
      path.includes("/catalog?")
        ? { protocolVersion: 2, apps: [], page: { hasMore: true, nextCursor: "same" } }
        : { data: { id: "one" }, refs: [{ type: "demo.item", id: "one" }] },
    );
  });
  await capabilitiesCliModule.run(ctx);
  expect(requests).toHaveLength(3);
  expect(lines).toEqual([
    "The capability catalog is unavailable; some resource permalinks could not be added.",
    JSON.stringify({ data: { id: "one" }, refs: [{ type: "demo.item", id: "one" }] }),
  ]);
});

test("read reuses its manifest when it covers every result ref", async () => {
  const requests: string[] = [];
  const { ctx, lines } = createContext(["read", "library.book", "b1"], {}, async (path) => {
    requests.push(path);
    return Response.json(
      path.includes("/catalog?")
        ? {
            protocolVersion: 2,
            apps: [
              { appId: "library", appName: "Library", appIcon: "ti ti-books", appDescription: "Books", manifest: futureLibrary().manifest },
            ],
            page: { hasMore: true, nextCursor: "after-library" },
          }
        : { data: { id: "b1" }, refs: [{ type: "library.book", id: "b1" }] },
    );
  });
  await capabilitiesCliModule.run(ctx);
  expect(requests).toEqual(["/api/capabilities/v1/catalog?limit=25", "/api/capabilities/v1/queries/library/book.read"]);
  expect(JSON.parse(lines[0] ?? "").refs).toEqual([
    { type: "library.book", id: "b1", permalink: "http://cloud.test/open/library.book/~b1" },
  ]);
});

test("generic CLI review returns the complete unsaved proposal without executing an Action", async () => {
  const review = { ...reviewFixture(), content: { kind: "page", title: "Unsaved", body: "x".repeat(300_000), format: "plain" } };
  const calls: string[] = [];
  const { ctx, lines } = createContext(["review", "demo", "write"], { input: '{"body":"new"}' }, async (path, init) => {
    calls.push(path);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ input: { body: "new" } });
    return Response.json(review);
  });
  await capabilitiesCliModule.run(ctx);
  expect(calls).toEqual(["/api/capabilities/v1/actions/demo/write/review"]);
  expect(lines.map((line) => JSON.parse(line))).toEqual([review]);
});
