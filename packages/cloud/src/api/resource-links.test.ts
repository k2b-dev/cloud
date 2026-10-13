import { describe, expect, test } from "bun:test";
import { ok } from "@k2b/stdlib";
import { z } from "zod";
import { compileCapabilities } from "../_internal/capabilities";
import { defineCapabilities } from "../contracts/capabilities";
import type { CapabilityRegistryEntry } from "../contracts/registry";
import type { RequestAuthority } from "../server";
import { buildProjectedUser } from "../services/session/user";
import type { CapabilityDispatchParams } from "./capabilities";
import { resolveCloudResourceHref } from "./resource-links";

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
    expect(
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
    { data: {}, links: [{ rel: "edit", href: "/edit" }] },
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
    expect(resolveCloudResourceHref(params, { getCapability: async () => app, dispatch })).rejects.toThrow("Offline");
  });
});
