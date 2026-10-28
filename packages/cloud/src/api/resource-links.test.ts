import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { AppRegistryEntry, CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import { buildProjectedUser } from "../services/session/user";
import type { CapabilityDispatchParams } from "./capabilities";
import { resolveCloudResourceHref, resolveCloudResourceUrl } from "./resource-links";

const manifest = compileCapabilities(
  "demo",
  defineCapabilities({
    protocolVersion: 2,
    types: { item: { title: "Item", description: "An item.", reader: "read" }, hidden: { title: "Hidden", description: "No reader." } },
    queries: {
      read: {
        title: "Read",
        description: "Read an item.",
        input: z.object({ id: z.string().describe("Stable resource id.") }).strict(),
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
  appIcon: "ti ti-box",
  appAccent: "#000000",
  appDescription: "Demo",
  endpoint: "http://demo/api/_internal/capabilities/v1",
  manifest,
};
const user = buildProjectedUser({
  id: "11111111-1111-4111-8111-111111111111",
  provider: "local",
  profile: "user",
  uid: "reader",
  display_name: "Reader",
});
const authority: RequestAuthority = {
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  credentialKind: "session",
  scopes: [],
};
const params = {
  ref: { type: "demo.item", id: "a/b?c" },
  request: new Request("https://cloud.example/open/demo.item/a%2Fb%3Fc"),
  authority,
  locale: "de",
};

describe("resource permalink resolution", () => {
  test("dispatches the canonical reader under the session authority and selects the first open link", async () => {
    let invocation: CapabilityDispatchParams | undefined;
    const href = await resolveCloudResourceHref(params, {
      getCapability: async (id) => (id === "demo" ? app : null),
      dispatch: async (input) => {
        invocation = input;
        return Response.json({
          data: {},
          links: [
            { rel: "edit", href: "/edit" },
            { rel: "open", href: "/item" },
            { rel: "open", href: "/other" },
          ],
        });
      },
    });
    expect(href).toBe("/item");
    expect(invocation).toEqual({
      request: params.request,
      authority,
      locale: "de",
      origin: "http",
      kind: "queries",
      appId: "demo",
      capabilityId: "read",
      input: { id: "a/b?c" },
    });
  });

  test.each(["demo.hidden", "demo.unknown", "foreign.item", "bad type"])("does not dispatch an unreadable Type %s", async (type) => {
    let calls = 0;
    expect(
      await resolveCloudResourceHref(
        { ...params, ref: { ...params.ref, type } },
        {
          getCapability: async () => app,
          dispatch: async () => {
            calls++;
            return Response.json({ data: {}, links: [{ rel: "open", href: "/item" }] });
          },
        },
      ),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test("returns null for an offline app and surfaces a failed registry", async () => {
    expect(await resolveCloudResourceHref(params, { getCapability: async () => null })).toBeNull();
    await expect(
      resolveCloudResourceHref(params, {
        getCapability: async () => {
          throw new Error("Offline");
        },
      }),
    ).rejects.toThrow("Offline");
    expect(
      await resolveCloudResourceHref(params, { getCapability: async () => ({ ...app, manifest: { ...manifest, appId: "foreign" } }) }),
    ).toBeNull();
  });

  test.each([403, 404, 500])("hides reader errors with status %s", async (status) => {
    expect(
      await resolveCloudResourceHref(params, {
        getCapability: async () => app,
        dispatch: async () => Response.json({ code: "DENIED" }, { status }),
      }),
    ).toBeNull();
  });

  test.each([
    { data: {} },
    { data: {}, links: [{ rel: "open", href: "https://foreign.example" }] },
    { data: {}, links: [{ rel: "open", href: "//foreign.example" }] },
    { data: {}, links: [{ rel: "open", href: "/\\foreign.example" }] },
    { links: [{ rel: "open", href: "/item" }], unexpected: true },
  ])("returns null for a missing or invalid open result %j", async (body) => {
    expect(
      await resolveCloudResourceHref(params, { getCapability: async () => app, dispatch: async () => Response.json(body) }),
    ).toBeNull();
  });

  test("surfaces transport failures instead of answering not found", async () => {
    const dispatch = async (): Promise<Response> => {
      throw new Error("Offline");
    };
    await expect(resolveCloudResourceHref(params, { getCapability: async () => app, dispatch })).rejects.toThrow("Offline");
  });
});

test("older owning-app readers may still return only a validated edit link", async () => {
  expect(
    await resolveCloudResourceHref(params, {
      getCapability: async () => app,
      dispatch: async () => Response.json({ data: {}, links: [{ rel: "edit", href: "/edit" }] }),
    }),
  ).toBe("/edit");
  expect(
    await resolveCloudResourceHref(params, {
      getCapability: async () => app,
      dispatch: async () => Response.json({ data: {}, links: [{ rel: "edit", href: "https://foreign.example" }] }),
    }),
  ).toBeNull();
});

const liveApp: AppRegistryEntry = {
  id: "demo",
  name: "Demo",
  description: "Demo",
  icon: "ti ti-box",
  baseUrl: "http://demo",
  routes: ["/app/demo"],
};
const urlParams = { ...params, url: "/app/demo/item" };
const urlDependencies = {
  appUrl: async () => "https://cloud.example/path",
  listApps: async () => [liveApp],
  listCapabilities: async () => [{ ...app, manifest: { ...manifest, resourcePages: [{ type: "item", path: "/app/demo/:id" }] } }],
  getCapability: async () => app,
  dispatch: async () => Response.json({ data: {}, links: [{ rel: "open", href: "/item" }] }),
};

describe("pasted Cloud URL resolution", () => {
  test.each([
    "https://foreign.example/app/demo/item",
    "//cloud.example/app/demo/item",
    "javascript:alert(1)",
    "/".repeat(8193),
    "/app/demo/item another",
  ])("rejects a foreign or invalid URL before calling any app", async (url) => {
    let calls = 0;
    const unexpected = async (): Promise<never> => {
      calls++;
      throw new Error("Unexpected app lookup");
    };
    expect(
      await resolveCloudResourceUrl(
        { ...urlParams, url },
        { ...urlDependencies, listApps: unexpected, getCapability: unexpected, dispatch: unexpected },
      ),
    ).toBeNull();
    expect(calls).toBe(0);
  });

  test.each(["/app/demo/item", "https://cloud.example/app/demo/item", "/open/demo.item/~item", "/open/demo.item/~item?extra=yes#part"])(
    "reads the matched ref under the original authority: %s",
    async (url) => {
      let invocation: CapabilityDispatchParams | undefined;
      const result = await resolveCloudResourceUrl(
        { ...urlParams, url },
        {
          ...urlDependencies,
          dispatch: async (input) => {
            invocation = input;
            return Response.json({
              data: {},
              refs: [
                { type: "demo.item", id: "different", title: "Wrong", icon: "wrong" },
                { type: "demo.item", id: "item", title: "Current item", icon: "ti ti-file" },
              ],
              links: [
                { rel: "edit", href: "/edit" },
                { rel: "open", href: "/item" },
              ],
            });
          },
        },
      );
      expect(result).toEqual({ ref: { type: "demo.item", id: "item" }, title: "Current item", icon: "ti ti-file", href: "/item" });
      expect(invocation?.authority).toBe(authority);
      expect(invocation?.locale).toBe("de");
      expect(invocation?.input).toEqual({ id: "item" });
    },
  );

  test("falls back independently to the localized Type title and icon", async () => {
    const presented = {
      ...app,
      manifest: { ...manifest, types: manifest.types.map((type) => ({ ...type, icon: "ti ti-box" })) },
      presentation: { baseLocale: "en", translations: { de: { types: { item: { title: "Element" } } } } },
    };
    expect(await resolveCloudResourceUrl(urlParams, { ...urlDependencies, getCapability: async () => presented })).toEqual({
      ref: { type: "demo.item", id: "item" },
      title: "Element",
      icon: "ti ti-box",
      href: "/item",
    });
    expect(
      await resolveCloudResourceUrl(urlParams, {
        ...urlDependencies,
        getCapability: async () => presented,
        dispatch: async () =>
          Response.json({
            data: {},
            refs: [{ type: "demo.item", id: "item", title: "Custom" }],
            links: [{ rel: "edit", href: "/edit" }],
          }),
      }),
    ).toEqual({ ref: { type: "demo.item", id: "item" }, title: "Custom", icon: "ti ti-box", href: "/edit" });
  });

  test.each([403, 404, 500])("denied, missing and failed reads have the same null result: %s", async (status) => {
    expect(
      await resolveCloudResourceUrl(urlParams, {
        ...urlDependencies,
        dispatch: async () => Response.json({ message: "private" }, { status }),
      }),
    ).toBeNull();
  });

  test("transport and registry failures, missing links and invalid responses all return null", async () => {
    const offline = async (): Promise<never> => {
      throw new Error("private");
    };
    for (const override of [
      { dispatch: offline },
      { getCapability: offline },
      { listApps: offline },
      { listCapabilities: offline },
      { getCapability: async () => null },
      { dispatch: async () => new Response("not json") },
      { dispatch: async () => Response.json({ data: {} }) },
      { dispatch: async () => Response.json({ data: {}, links: [{ rel: "open", href: "https://foreign.example" }] }) },
    ])
      expect(await resolveCloudResourceUrl(urlParams, { ...urlDependencies, ...override })).toBeNull();
  });

  test("ignores stolen routes, Types without readers and ambiguous matches before dispatch", async () => {
    let calls = 0;
    for (const resourcePages of [
      [{ type: "item", path: "/app/foreign/:id" }],
      [{ type: "hidden", path: "/app/demo/:id" }],
      [
        { type: "item", path: "/app/demo/:id/:tail" },
        { type: "item", path: "/app/demo/:base/:id" },
      ],
    ]) {
      const url = resourcePages[0]?.path.includes("foreign")
        ? "/app/foreign/item"
        : resourcePages[0]?.type === "hidden"
          ? "/app/demo/item"
          : "/app/demo/item/other";
      expect(
        await resolveCloudResourceUrl(
          { ...urlParams, url },
          {
            ...urlDependencies,
            listCapabilities: async () => [{ ...app, manifest: { ...manifest, resourcePages } }],
            dispatch: async () => {
              calls++;
              return Response.json({ data: {} });
            },
          },
        ),
      ).toBeNull();
    }
    expect(calls).toBe(0);
  });
});

test("live ownership defeats ancestor page claims even when the descendant has no pages", async () => {
  let calls = 0;
  const descendant: AppRegistryEntry = { ...liveApp, id: "other", routes: ["/tools/specific"] };
  for (const url of ["/tools/specific/item", "/app/other/item"]) {
    expect(
      await resolveCloudResourceUrl(
        { ...urlParams, url },
        {
          ...urlDependencies,
          listApps: async () => [{ ...liveApp, routes: ["/"] }, descendant],
          listCapabilities: async () => [
            {
              ...app,
              manifest: {
                ...manifest,
                resourcePages: [
                  { type: "item", path: "/tools/specific/:id" },
                  { type: "item", path: "/app/other/:id" },
                ],
              },
            },
          ],
          dispatch: async () => {
            calls++;
            return Response.json({ data: {} });
          },
        },
      ),
    ).toBeNull();
  }
  expect(calls).toBe(0);
});

test("duplicate live route claims fail closed without dispatch", async () => {
  let calls = 0;
  expect(
    await resolveCloudResourceUrl(
      { ...urlParams, url: "/tools/id" },
      {
        ...urlDependencies,
        listApps: async () => [
          { ...liveApp, routes: ["/tools"] },
          { ...liveApp, id: "other", routes: ["/tools"] },
        ],
        listCapabilities: async () => [{ ...app, manifest: { ...manifest, resourcePages: [{ type: "item", path: "/tools/:id" }] } }],
        dispatch: async () => {
          calls++;
          return Response.json({ data: {} });
        },
      },
    ),
  ).toBeNull();
  expect(calls).toBe(0);
});
