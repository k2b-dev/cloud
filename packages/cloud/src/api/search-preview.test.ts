import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { hc } from "hono/client";
import { z } from "zod";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { compileCapabilities } from "../_internal/capabilities";
import { person } from "../_internal/define-app.test-fixture";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AuthContext } from "../server";
import type { CoreApiType } from ".";
import type { CapabilityDispatchParams } from "./capabilities";
import { createSearchRoutes } from "./search";

useUnitClients();
afterEach(() => mock.restore());

const manifest = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 2,
    types: {
      item: { title: "Item", description: "Readable item.", reader: "read" },
      hidden: { title: "Hidden", description: "No reader." },
    },
    queries: {
      read: {
        title: "Read",
        description: "Read an item.",
        input: z.object({ id: z.string().describe("Stable resource ID.") }).strict(),
        data: z.unknown(),
        openWorld: false,
        run: async () => ok({ data: {} }),
      },
    },
  }),
).manifest;
const app: CapabilityRegistryEntry = {
  appId: "demo",
  appName: "Demo",
  appDescription: "Demo",
  appIcon: "ti ti-box",
  endpoint: "http://demo/api/_internal/capabilities/v1",
  manifest,
};
const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  c.set("actor", { kind: "user", user: person });
  c.set("accessSubject", { type: "user", userId: person.id });
  c.set("user", person);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};
const view = { version: 1, blocks: [{ kind: "Detail", title: "Item", items: { from: ["facts"] } }] };
const payload = { data: { facts: [{ label: "Name", value: "Authorized item" }], secret: "Never return raw data" }, view };
const routes = (overrides: Parameters<typeof createSearchRoutes>[0] = {}) =>
  createSearchRoutes({
    authenticate,
    getCapability: async () => app,
    getApp: async () => ({ id: "demo", name: "Demo", description: "", icon: "ti ti-box", baseUrl: "http://demo", routes: ["/app/demo"] }),
    dispatch: async () => Response.json(payload),
    ...overrides,
  });
const path = "/search/preview?type=demo.item&id=ref-1";
async function expectFallback(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("private, no-store");
  expect(await response.json()).toEqual({ view: null });
}

describe("search reader previews", () => {
  test("the Core client exposes the preview query", () => {
    const url = hc<CoreApiType>("http://localhost").search.preview.$url({ query: { type: "demo.item", id: "ref-1" } });
    expect(`${url.pathname}${url.search}`).toBe(path);
  });

  test("uses the normal search authentication before reading a resource", async () => {
    const dispatch = mock(async () => Response.json(payload));
    const response = await routes({ authenticate: undefined, dispatch }).request(path);
    expect(response.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("uses the person's authority, locale, reader and credential exchange path; returns only the bound view", async () => {
    let call: CapabilityDispatchParams | undefined;
    const response = await routes({
      dispatch: async (params) => {
        call = params;
        return Response.json(payload);
      },
    }).request(path, { headers: { "x-cloud-locale": "de" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private, no-store");
    expect(await response.json()).toEqual({ view: { version: 1, blocks: [{ kind: "Detail", title: "Item", items: payload.data.facts }] } });
    expect(call).toMatchObject({
      authority: {
        actor: { kind: "user", user: person },
        accessSubject: { type: "user", userId: person.id },
        credentialKind: "session",
        scopes: [],
      },
      locale: "de",
      kind: "queries",
      appId: "demo",
      capabilityId: "read",
      origin: "http",
      input: { id: "ref-1" },
    });
    expect(call?.request.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([403, 404, 500])("a reader denying access or failing (%i) reveals no reader content", async (status) => {
    await expectFallback(
      await routes({
        dispatch: async (call) => {
          expect(call.authority?.accessSubject).toEqual({ type: "user", userId: person.id });
          return Response.json({ ...payload, message: "Private reader failure" }, { status });
        },
      }).request(path),
    );
  });

  test.each(["demo.hidden", "demo.unknown"])("no reader for %s never dispatches", async (type) => {
    const dispatch = mock(async () => Response.json(payload));
    await expectFallback(await routes({ dispatch }).request(`/search/preview?type=${type}&id=ref-1`));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a reader without a top-level view falls back even when data.view exists", async () => {
    await expectFallback(await routes({ dispatch: async () => Response.json({ data: { view } }) }).request(path));
  });

  test.each([
    {
      version: 1,
      blocks: [
        {
          kind: "Choice",
          id: "choose",
          title: "Choose",
          mode: "one",
          options: [{ id: "a", title: "A" }],
          option: { id: ["id"], title: ["title"] },
          submit: "Choose",
        },
      ],
    },
    { version: 1, blocks: [{ kind: "Draft", fields: [{ name: "title", label: "Title", type: "text" }] }] },
    { version: 1, blocks: [{ kind: "Link", label: "Outside", href: "https://outside.test" }] },
    { version: 1, blocks: [{ kind: "Image", alt: "Foreign", src: "/app/other/image" }] },
    { version: 1, blocks: [{ kind: "Detail", title: "Missing", items: { from: ["missing"] } }] },
  ])("rejects views unsuitable for a preview: %j", async (invalid) => {
    await expectFallback(await routes({ dispatch: async () => Response.json({ data: {}, view: invalid }) }).request(path));
  });

  test("a reader's own image route is allowed", async () => {
    const imageView = { version: 1, blocks: [{ kind: "Image", alt: "Item", src: "/app/demo/image/ref-1" }] };
    const response = await routes({ dispatch: async () => Response.json({ data: {}, view: imageView }) }).request(path);
    expect(await response.json()).toEqual({ view: imageView });
  });

  test("app disappearance and registry/transport failures are opaque", async () => {
    for (const overrides of [
      { getCapability: async () => null },
      { getApp: async () => null },
      {
        getCapability: async () => {
          throw new Error("Private registry detail");
        },
      },
      {
        dispatch: async () => {
          throw new Error("Private transport detail");
        },
      },
      { dispatch: async () => new Response("not JSON") },
    ])
      await expectFallback(await routes(overrides).request(path));
  });

  test.each(["", "?type=demo.item", "?type=bad&id=x", "?type=demo.item&id=", `?type=demo.item&id=${"x".repeat(513)}`])(
    "bad query %s is 400",
    async (query) => {
      const dispatch = mock(async () => Response.json(payload));
      expect((await routes({ dispatch }).request(`/search/preview${query}`)).status).toBe(400);
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  test.each(["disconnect", "deadline"])("%s aborts the reader and promptly falls back", async (reason) => {
    const abort = new AbortController();
    if (reason === "deadline")
      spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        expect(ms).toBe(8_000);
        return abort.signal;
      });
    let readerSignal: AbortSignal | undefined;
    const router = routes({
      dispatch: (params) => {
        readerSignal = params.request.signal;
        abort.abort();
        // Also prove the response is bounded if a broken transport ignores cancellation.
        return new Promise<Response>(() => {});
      },
    });
    await expectFallback(
      await router.request(new Request(`http://localhost${path}`, reason === "disconnect" ? { signal: abort.signal } : {})),
    );
    expect(readerSignal?.aborted).toBeTrue();
  });

  test("an already disconnected request never dispatches", async () => {
    const abort = new AbortController();
    abort.abort();
    const dispatch = mock(async () => Response.json(payload));
    await expectFallback(await routes({ dispatch }).request(new Request(`http://localhost${path}`, { signal: abort.signal })));
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("a deadline during reader discovery prevents a later dispatch", async () => {
    const abort = new AbortController();
    spyOn(AbortSignal, "timeout").mockReturnValue(abort.signal);
    const dispatch = mock(async () => Response.json(payload));
    await expectFallback(
      await routes({
        getCapability: async () => {
          abort.abort();
          return app;
        },
        dispatch,
      }).request(path),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });
});
