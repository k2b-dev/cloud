import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as catalog from "@k2b/cloud/capabilities/server";
import { UserSchema } from "@k2b/cloud/contracts";
import { auth } from "@k2b/cloud/server";
import { useUnitClients } from "../../../../scripts/fixtures/unit-clients";
import { createCodeAuthoringRoutes } from "../api/code-authoring";
import * as access from "./access";
import { codeOwnerCatalogFixture } from "./owner-registration.fixture";
import { createCode } from "./store";

useUnitClients();
afterEach(() => mock.restore());
const user = UserSchema.parse({
  id: "11111111-1111-4111-8111-111111111111",
  uid: "owner",
  provider: "local",
  profile: "user",
  roles: ["user"],
  displayName: "Owner",
  givenname: "Owner",
  sn: "Fixture",
  mail: null,
  avatarHash: null,
  ipa: null,
  accountExpires: null,
  lastLoginLocal: null,
  memberofGroup: [],
  memberofGroupIds: [],
  manages: [],
  managesGroupIds: [],
});
const context = {
  authority: {
    actor: { kind: "user", user },
    accessSubject: { type: "user", userId: user.id },
    credentialKind: "session",
    scopes: [],
  },
  locale: "de",
} satisfies access.CodeContext;
const owner = { kind: "resource" as const, ref: { type: "inventory.item", id: "Item01" } };
const app = codeOwnerCatalogFixture("inventory", "item");
const { manifest } = app;
const stopped = new Error("Owner permission check reached; no persistence permitted in this unit test");

test.each([undefined, { owners: [] }, { owners: ["other"] }, { owners: ["inventory.item"] }])(
  "creation refuses a resource absent from the app's local code.owners (%j)",
  async (code) => {
    const lookup = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
      ok: true,
      data: { ...app, manifest: { ...manifest, code: code ? { owners: [...code.owners] } : undefined } },
    });
    const reader = spyOn(access, "readCodeOwner").mockRejectedValue(stopped);
    await expect(createCode({ owner, title: "Delivery slip" }, context)).rejects.toMatchObject({
      code: "BAD_INPUT",
      message: "Für diesen Ort kann kein Code angelegt werden.",
    });
    expect(lookup).toHaveBeenCalledWith("inventory", "de", context.authority);
    expect(reader).not.toHaveBeenCalled();
  },
);

test("a declared resource still needs live owner administration", async () => {
  spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: app });
  const reader = spyOn(access, "readCodeOwner").mockResolvedValue({ title: "Item", admin: false });
  await expect(createCode({ owner, title: "Delivery slip" }, context)).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(reader).toHaveBeenCalledWith(owner, context);
});

test("a declared resource reaches its existing creation path", async () => {
  spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: app });
  spyOn(access, "readCodeOwner").mockRejectedValue(stopped);
  await expect(createCode({ owner, title: "Delivery slip" }, context)).rejects.toBe(stopped);
});

test("catalog outages stay retryable and a missing app stays not found", async () => {
  const lookup = spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({
    ok: false,
    error: { code: "APP_UNAVAILABLE", message: "Offline", status: 503 },
  });
  const reader = spyOn(access, "readCodeOwner").mockRejectedValue(stopped);
  await expect(createCode({ owner, title: "Delivery slip" }, context)).rejects.toBeInstanceOf(access.CodeOwnerUnavailableError);
  lookup.mockResolvedValue({ ok: true, data: null });
  await expect(createCode({ owner, title: "Delivery slip" }, context)).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(reader).not.toHaveBeenCalled();
});

test.each(["de", "en"])("HTTP init returns a translated unsupported-owner refusal in %s", async (locale) => {
  spyOn(catalog, "getCapabilityCatalogApp").mockResolvedValue({ ok: true, data: { ...app, manifest: { ...manifest, code: undefined } } });
  spyOn(access, "readCodeOwner").mockRejectedValue(stopped);
  spyOn(auth, "requireRole").mockReturnValue(async (_c, next) => next());
  spyOn(auth, "requireOAuthScope").mockReturnValue(async (_c, next) => next());
  spyOn(auth, "getAuthority").mockReturnValue(context.authority);
  const response = await createCodeAuthoringRoutes().request("/init", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud-locale": locale },
    body: JSON.stringify({ owner, title: "Delivery slip" }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    version: 1,
    error: {
      code: "BAD_INPUT",
      message: locale === "de" ? "Für diesen Ort kann kein Code angelegt werden." : "Code cannot be created for this place.",
      details: null,
    },
  });
});
