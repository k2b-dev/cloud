import { describe, expect, spyOn, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import type { MiddlewareHandler } from "hono";
import { generateKeyPair } from "jose";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities, UniversalSearchDataSchema, UniversalSearchInputSchema } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { AuthContext } from "../server";
import { searchInvocationOperation } from "../services/identity/invocation-operations";
import type { signInvocationToken } from "../services/identity/invocation-token";
import type { withActiveIdentitySigner } from "../services/identity/key-ring";
import { createSearchRoutes } from "./search";

const capabilities = defineCapabilities({
  protocolVersion: 1,
  types: {
    item: { title: "Item", description: "A searchable test item." },
  },
  queries: {
    search: {
      title: "Search items",
      description: "Find test items by text and facets.",
      input: UniversalSearchInputSchema,
      data: UniversalSearchDataSchema,
      openWorld: false,
      universalSearch: {
        tags: [{ tag: "item", title: "Items", description: "Show test items.", aliases: ["thing"] }],
      },
      run: async () => ok({ data: [] }),
    },
  },
});

const manifest = compileCapabilities("demo", capabilities).manifest;
const app: CapabilityRegistryEntry = {
  appId: "demo",
  appName: "Demo",
  appIcon: "ti ti-box",
  appDescription: "",
  endpoint: "http://demo:3000/api/_internal/capabilities/v1",
  manifest,
};

const authenticate: MiddlewareHandler<AuthContext> = async (c, next) => {
  const user = { id: "11111111-1111-4111-8111-111111111111", roles: ["user"] } as AuthContext["Variables"]["user"];
  c.set("actor", { kind: "user", user });
  c.set("accessSubject", { type: "user", userId: user.id });
  c.set("user", user);
  c.set("credentialKind", "session");
  c.set("credentialScopes", []);
  await next();
};

const withInvocationMode = async <T>(mode: "legacy" | "jwt", run: () => Promise<T>): Promise<T> => {
  const previous = process.env.CLOUD_INVOCATION_ISSUANCE_MODE;
  process.env.CLOUD_INVOCATION_ISSUANCE_MODE = mode;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.CLOUD_INVOCATION_ISSUANCE_MODE;
    else process.env.CLOUD_INVOCATION_ISSUANCE_MODE = previous;
  }
};

const provider = (index: number): CapabilityRegistryEntry => {
  const appId = `search-${String(index).padStart(2, "0")}`;
  return {
    ...app,
    appId,
    appName: `Search ${index}`,
    endpoint: `http://${appId}:3000/api/_internal/capabilities/v1`,
    manifest: compileCapabilities(appId, capabilities).manifest,
  };
};

const fakeInvocation = (
  params: Parameters<typeof signInvocationToken>[0],
  token = `invocation:${params.targetAppId}:${params.operation}:${params.schemaHash}`,
): Awaited<ReturnType<typeof signInvocationToken>> => {
  const issuedAt = 1_700_000_000;
  return {
    token,
    kid: "22222222-2222-4222-8222-222222222222",
    claims: {
      ...params.authority,
      iss: "https://cloud.test",
      aud: `app:${params.targetAppId}`,
      token_use: "invocation",
      act: { sub: `app:${params.callingAppId}` },
      op: params.operation,
      schema_hash: params.schemaHash,
      ver: 1,
      ...(params.requestId ? { request_id: params.requestId } : {}),
      jti: "33333333-3333-4333-8333-333333333333",
      iat: issuedAt,
      nbf: issuedAt,
      exp: issuedAt + 30,
    },
  };
};

let signerKey: CryptoKey | undefined;
const withActiveSigner: typeof withActiveIdentitySigner = async (_purpose, callback) => {
  signerKey ??= (await generateKeyPair("RS256")).privateKey;
  return callback({
    kid: "22222222-2222-4222-8222-222222222222",
    key: signerKey,
    signUntil: new Date(Date.now() + 60_000),
  });
};

describe("global capability search", () => {
  test("returns a structured unavailable error when capability discovery fails", async () => {
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => {
        throw new Error("registry offline");
      },
    });
    const response = await routes.request("/search?q=test");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "APP_UNAVAILABLE", message: "Capability registry is currently unavailable" });
  });

  test("discovers and routes multiple providers from one app", async () => {
    const multiManifest = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 1,
        types: { item: { title: "Item", description: "One search result." } },
        queries: {
          first: {
            ...capabilities.queries.search,
            universalSearch: { tags: [{ tag: "first", title: "First", description: "Search first items." }] },
          },
          second: {
            ...capabilities.queries.search,
            universalSearch: { tags: [{ tag: "second", title: "Second", description: "Search second items." }] },
          },
        },
      }),
    ).manifest;
    const calls: string[] = [];
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [{ ...app, manifest: multiManifest }],
      fetch: async (url) => {
        calls.push(String(url));
        return Response.json({ data: [] });
      },
    });

    expect((await routes.request("/search?q=test&tag=second")).status).toBe(200);
    expect(calls).toEqual(["http://demo:3000/api/_internal/capabilities/v1/queries/second"]);

    calls.length = 0;
    expect((await routes.request("/search?q=test")).status).toBe(200);
    expect(calls.sort()).toEqual([
      "http://demo:3000/api/_internal/capabilities/v1/queries/first",
      "http://demo:3000/api/_internal/capabilities/v1/queries/second",
    ]);
  });

  test("caps merged results per app instead of per registered Query", async () => {
    const multiManifest = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 1,
        types: { item: { title: "Item", description: "One search result." } },
        queries: {
          first: capabilities.queries.search,
          second: {
            ...capabilities.queries.search,
            universalSearch: { tags: [{ tag: "second", title: "Second", description: "Search second items." }] },
          },
        },
      }),
    ).manifest;
    const otherManifest = compileCapabilities("other", capabilities).manifest;
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [
        { ...app, manifest: multiManifest },
        {
          ...app,
          appId: "other",
          appName: "Other",
          endpoint: "http://other:3000/api/_internal/capabilities/v1",
          manifest: otherManifest,
        },
      ],
      fetch: async (url) => {
        const appId = String(url).includes("http://other:") ? "other" : "demo";
        const queryId = String(url).split("/").at(-1) ?? "search";
        return Response.json({
          data: Array.from({ length: 2 }, (_, index) => ({
            ref: { type: `${appId}.item`, id: `${queryId}-${index}` },
            title: `${appId}-${queryId}-${index}`,
            links: [{ rel: "open", href: `/app/${appId}/${queryId}-${index}` }],
          })),
        });
      },
    });

    const response = await routes.request("/search?q=test&provider_limit=2");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ appId: string }> };
    expect(body.items).toHaveLength(4);
    expect(body.items.filter((item) => item.appId === "demo")).toHaveLength(2);
    expect(body.items.filter((item) => item.appId === "other")).toHaveLength(2);
  });

  test("discovers tags and maps stable resource refs", async () => {
    let input: unknown;
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [app],
      fetch: async (_url, init) => {
        input = JSON.parse(String(init?.body));
        return Response.json({
          data: [
            {
              ref: { type: "demo.item", id: "42" },
              title: "Answer",
              preview: "A result",
              links: [{ rel: "open", href: "/app/demo/42" }],
            },
          ],
        });
      },
    });

    const response = await routes.request("/search?q=answer&tag=thing&provider_limit=2", {
      headers: { cookie: "session=test" },
    });
    expect(response.status).toBe(200);
    expect(input).toEqual({ input: { query: "answer", tags: ["thing"], limit: 6 } });
    expect(await response.json()).toEqual({
      query: "answer",
      count: 1,
      items: [
        {
          appId: "demo",
          appName: "Demo",
          appIcon: "ti ti-box",
          readable: false,
          ref: { type: "demo.item", id: "42" },
          title: "Answer",
          href: "/app/demo/42",
          preview: "A result",
        },
      ],
      apps: [{ id: "demo", name: "Demo", icon: "ti ti-box" }],
    });
  });

  test("reports unsupported facets without calling providers", async () => {
    let calls = 0;
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [app],
      fetch: async () => {
        calls += 1;
        return Response.json({ data: [] });
      },
    });

    const response = await routes.request("/search?tag=missing");
    expect(response.status).toBe(200);
    expect(calls).toBe(0);
    expect(await response.json()).toEqual({
      query: "",
      count: 0,
      items: [],
      apps: [{ id: "demo", name: "Demo", icon: "ti ti-box" }],
      unsupportedTags: ["missing"],
    });
  });

  test("filters provider fan-out by app while returning the complete app filter catalog", async () => {
    const otherManifest = compileCapabilities("other", capabilities).manifest;
    const calls: string[] = [];
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [
        app,
        { ...app, appId: "other", appName: "Other", endpoint: "http://other:3000/api/_internal/capabilities/v1", manifest: otherManifest },
      ],
      fetch: async (url) => {
        calls.push(String(url));
        return Response.json({ data: [] });
      },
    });

    const response = await routes.request("/search?q=test&app=other");
    expect(response.status).toBe(200);
    expect(calls).toEqual(["http://other:3000/api/_internal/capabilities/v1/queries/search"]);
    expect((await response.json()).apps).toEqual([
      { id: "demo", name: "Demo", icon: "ti ti-box" },
      { id: "other", name: "Other", icon: "ti ti-box" },
    ]);
  });

  test("returns the app catalog without provider fan-out for an unscoped empty request", async () => {
    let calls = 0;
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [app],
      fetch: async () => {
        calls += 1;
        return Response.json({ data: [] });
      },
    });

    const response = await routes.request("/search");
    expect(response.status).toBe(200);
    expect(calls).toBe(0);
    expect(await response.json()).toEqual({
      query: "",
      count: 0,
      items: [],
      apps: [{ id: "demo", name: "Demo", icon: "ti ti-box" }],
    });
  });

  test("filters navigation-only resources before applying the global result limit", async () => {
    const readableManifest = compileCapabilities(
      "demo",
      defineCapabilities({
        protocolVersion: 1,
        types: {
          navigation: { title: "Navigation item", description: "Navigation only." },
          readable: { title: "Readable item", description: "Readable item.", reader: "read" },
        },
        queries: {
          search: capabilities.queries.search,
          read: {
            title: "Read item",
            description: "Read one item.",
            input: z.object({ id: z.string().describe("Stable item id.") }).strict(),
            data: z.object({ id: z.string() }).strict(),
            openWorld: false,
            run: async ({ id }) => ok({ data: { id } }),
          },
        },
      }),
    ).manifest;
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [{ ...app, manifest: readableManifest }],
      fetch: async () =>
        Response.json({
          data: [
            ...Array.from({ length: 30 }, (_, index) => ({
              ref: { type: "demo.navigation", id: String(index) },
              title: `Navigation ${index}`,
              priority: 9,
              links: [{ rel: "open", href: `/app/demo/navigation/${index}` }],
            })),
            {
              ref: { type: "demo.readable", id: "kept" },
              title: "Readable",
              links: [{ rel: "open", href: "/app/demo/readable/kept" }],
            },
          ],
        }),
    });

    const response = await routes.request("/search?q=item&require_reader=true&provider_limit=30");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ ref: { id: string }; readable: boolean }> };
    expect(body.items).toEqual([expect.objectContaining({ ref: { type: "demo.readable", id: "kept" }, readable: true })]);
  });

  test("rejects unbounded queries and provider limits before fan-out", async () => {
    const routes = createSearchRoutes({ authenticate, listCapabilities: async () => [app] });
    expect((await routes.request(`/search?q=${"x".repeat(501)}`)).status).toBe(400);
    expect((await routes.request("/search?provider_limit=31")).status).toBe(400);
    expect((await routes.request(`/search?${Array.from({ length: 21 }, (_, index) => `tag=t${index}`).join("&")}`)).status).toBe(400);
    expect((await routes.request(`/search?app=${"a".repeat(121)}`)).status).toBe(400);
    expect((await routes.request("/search?require_reader=false")).status).toBe(400);
  });

  test("caps a provider that returns more items than requested", async () => {
    const routes = createSearchRoutes({
      authenticate,
      listCapabilities: async () => [app],
      fetch: async () =>
        Response.json({
          data: Array.from({ length: 100 }, (_, index) => ({
            ref: { type: "demo.item", id: String(index) },
            title: `Item ${index}`,
            links: [{ rel: "open", href: `/app/demo/${index}` }],
          })),
        }),
    });
    const response = await routes.request("/search?q=item&provider_limit=2");
    expect(response.status).toBe(200);
    expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(6);
  });

  test("issues one target, operation, and schema-bound JWT per started provider without forwarding the source credential", async () => {
    await withInvocationMode("jwt", async () => {
      const providers = [provider(1), provider(2), provider(3)];
      const signed: Parameters<typeof signInvocationToken>[0][] = [];
      const forwarded = new Map<string, Headers>();
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => providers,
        withActiveSigner,
        signInvocation: async (params) => {
          signed.push(params);
          return fakeInvocation(params);
        },
        fetch: async (url, init) => {
          forwarded.set(String(url), new Headers(init?.headers));
          return Response.json({ data: [] });
        },
      });

      const response = await routes.request("/search?q=needle", {
        headers: {
          authorization: "Bearer source-oauth-token",
          cookie: "session_token=source-session; analytics=private",
          "x-request-id": "search-request",
        },
      });

      expect(response.status).toBe(200);
      expect(signed).toHaveLength(providers.length);
      for (const entry of providers) {
        const call = signed.find((candidate) => candidate.targetAppId === entry.appId);
        expect(call).toMatchObject({
          targetAppId: entry.appId,
          callingAppId: "core",
          operation: searchInvocationOperation,
          schemaHash: entry.manifest.queries[0]?.schemaHash,
          requestId: "search-request",
          authority: {
            sub: "11111111-1111-4111-8111-111111111111",
            principal_type: "user",
            credential_kind: "session",
            scopes: [],
          },
        });
        const headers = forwarded.get(`${entry.endpoint}/queries/search`);
        expect(headers?.get("authorization")).toBe(
          `Bearer invocation:${entry.appId}:${searchInvocationOperation}:${entry.manifest.queries[0]?.schemaHash}`,
        );
        expect(headers?.get("authorization")).not.toContain("source-oauth-token");
        expect(headers?.get("cookie")).toBeNull();
        expect(headers?.get("x-cloud-invocation-operation")).toBe(searchInvocationOperation);
        expect(headers?.get("x-cloud-capability-schema-hash")).toBe(entry.manifest.queries[0]?.schemaHash);
      }
    });
  });

  test("guards one prepared signer for a thirty-target JWT fan-out", async () => {
    await withInvocationMode("jwt", async () => {
      const providers = Array.from({ length: 30 }, (_, index) => provider(index));
      let guardCalls = 0;
      let preparedSigner: Parameters<typeof signInvocationToken>[0]["signer"];
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => providers,
        withActiveSigner: async (purpose, callback, options) => {
          guardCalls += 1;
          return withActiveSigner(
            purpose,
            async (signer) => {
              preparedSigner = signer;
              return callback(signer);
            },
            options,
          );
        },
        signInvocation: async (params) => {
          expect(params.signer).toBe(preparedSigner);
          return fakeInvocation(params);
        },
        fetch: async () => Response.json({ data: [] }),
      });

      expect((await routes.request("/search?q=needle")).status).toBe(200);
      expect(guardCalls).toBe(1);
    });
  });

  test("keeps JWT fan-out at eight concurrent providers and merges partial successes", async () => {
    await withInvocationMode("jwt", async () => {
      const providers = Array.from({ length: 17 }, (_, index) => provider(index));
      let active = 0;
      let maximumActive = 0;
      let signed = 0;
      let providerSettled = false;
      let signedBeforeProviderSettled = 0;
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => providers,
        withActiveSigner,
        signInvocation: async (params) => {
          signed += 1;
          if (!providerSettled) signedBeforeProviderSettled += 1;
          return fakeInvocation(params);
        },
        fetch: async (url) => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Bun.sleep(5);
          providerSettled = true;
          active -= 1;
          const appId = new URL(String(url)).hostname;
          if (appId === "search-09") return Response.json({ code: "UNAVAILABLE", message: "offline" }, { status: 503 });
          return Response.json({
            data: [
              {
                ref: { type: `${appId}.item`, id: appId },
                title: appId,
                links: [{ rel: "open", href: `/app/${appId}` }],
              },
            ],
          });
        },
      });

      const response = await routes.request("/search?q=needle");
      const body = (await response.json()) as { count: number; items: Array<{ appId: string }> };
      expect(response.status).toBe(200);
      expect(maximumActive).toBe(8);
      expect(signed).toBe(providers.length);
      expect(signedBeforeProviderSettled).toBeGreaterThan(8);
      expect(body.count).toBe(16);
      expect(body.items.some((item) => item.appId === "search-09")).toBeFalse();
    });
  });

  test("uses one common JWT fan-out deadline, including providers queued behind the first worker batch", async () => {
    await withInvocationMode("jwt", async () => {
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      const providers = Array.from({ length: 9 }, (_, index) => provider(index));
      const started: Array<{ appId: string; alreadyAborted: boolean }> = [];
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => providers,
        withActiveSigner,
        signInvocation: async (params) => fakeInvocation(params),
        fetch: async (url, init) => {
          const appId = new URL(String(url)).hostname;
          const signal = init?.signal;
          started.push({ appId, alreadyAborted: signal?.aborted ?? false });
          if (appId === "search-00") {
            queueMicrotask(() => deadline.abort());
            return Response.json({
              data: [
                {
                  ref: { type: `${appId}.item`, id: appId },
                  title: appId,
                  links: [{ rel: "open", href: `/app/${appId}` }],
                },
              ],
            });
          }
          if (signal?.aborted) throw signal.reason;
          await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
          return Response.json({ data: [] });
        },
      });

      try {
        const response = await routes.request("/search?q=needle");
        const body = (await response.json()) as { count: number; items: Array<{ appId: string }> };
        expect(response.status).toBe(200);
        expect(timeout).toHaveBeenCalledTimes(2);
        expect(timeout).toHaveBeenCalledWith(500);
        expect(timeout).toHaveBeenCalledWith(8_000);
        expect(started).toHaveLength(providers.length);
        expect(started.find((entry) => entry.appId === "search-08")?.alreadyAborted).toBeTrue();
        expect(body.count).toBe(1);
        expect(body.items[0]?.appId).toBe("search-00");
      } finally {
        timeout.mockRestore();
      }
    });
  });

  test("bounds a stuck signer and does not start queued signing after the common deadline", async () => {
    await withInvocationMode("jwt", async () => {
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      const providers = Array.from({ length: 9 }, (_, index) => provider(index));
      let signed = 0;
      let fetched = 0;
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => providers,
        withActiveSigner,
        signInvocation: async () => {
          signed += 1;
          if (signed === 8) queueMicrotask(() => deadline.abort());
          return new Promise<never>(() => undefined);
        },
        fetch: async () => {
          fetched += 1;
          return Response.json({ data: [] });
        },
      });

      try {
        const response = await routes.request("/search?q=needle");
        expect(response.status).toBe(200);
        expect(timeout).toHaveBeenCalledTimes(2);
        expect(timeout).toHaveBeenCalledWith(500);
        expect(timeout).toHaveBeenCalledWith(8_000);
        expect(signed).toBe(8);
        expect(fetched).toBe(0);
        expect((await response.json()) as { count: number }).toMatchObject({ count: 0 });
      } finally {
        timeout.mockRestore();
      }
    });
  });

  test("bounds a stuck active-signer guard before signing or provider fetch", async () => {
    await withInvocationMode("jwt", async () => {
      const deadline = new AbortController();
      const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
      let signed = 0;
      let fetched = 0;
      const routes = createSearchRoutes({
        authenticate,
        listCapabilities: async () => [provider(1)],
        withActiveSigner: async () => {
          queueMicrotask(() => deadline.abort());
          return new Promise<never>(() => undefined);
        },
        signInvocation: async (params) => {
          signed += 1;
          return fakeInvocation(params);
        },
        fetch: async () => {
          fetched += 1;
          return Response.json({ data: [] });
        },
      });

      try {
        const response = await routes.request("/search?q=needle");
        expect(response.status).toBe(200);
        expect(timeout).toHaveBeenCalledTimes(2);
        expect(signed).toBe(0);
        expect(fetched).toBe(0);
        expect(await response.json()).toMatchObject({ count: 0 });
      } finally {
        timeout.mockRestore();
      }
    });
  });
});
