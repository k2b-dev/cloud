import { expect, mock, test } from "bun:test";
import type { RequestActor } from "@k2b/cloud/server";
import { AccountIdentityError, accountIdentities } from "@k2b/cloud/services";
import { testCall } from "../../test/files-call";
import { bindings } from "../data/bases";
import { createFilesService } from "./index";

const actor: RequestActor = {
  kind: "user",
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    uid: "admin",
    provider: "local",
    profile: "user",
    roles: ["user", "admin"],
    givenname: "Test",
    sn: "Admin",
    displayName: "Test Admin",
    mail: null,
    avatarHash: null,
    ipa: null,
    accountExpires: null,
    lastLoginLocal: null,
    memberofGroup: [],
    memberofGroupIds: [],
    manages: [],
    managesGroupIds: [],
  },
};
function fixture(admin = true) {
  const area = { enabled: false, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
  const input = {
    activityRetentionDays: 365,
    url: "http://filegate.test",
    cloud: { ...area, autoCreate: false, autoArchive: true },
    freeipa: { ...area, root: "freeipa" },
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
  };
  const config = { ...input, token: "", tokenConfigured: false, unreadable: true };
  const write = mock(async () => {});
  const reset = mock(async () => {});
  const connect = mock((): never => {
    throw new Error("Must not connect to Filegate");
  });
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      self: async () => ({
        user: {
          id: "00000000-0000-4000-8000-000000000001",
          username: "admin",
          provider: "local" as const,
          profile: "user" as const,
          posix: null,
        },
        availability: { localLinuxEnabled: true, freeipaEnabled: true },
      }),
      inventory: async () => {
        if (!admin) throw new AccountIdentityError("admin_required", 403);
        return { items: [], nextCursor: null };
      },
      groups: async () => ({ items: [], nextCursor: null }),
    },
    bindings,
    displayNames: async (entries) => entries.map((entry) => ({ ...entry, displayName: "Test" })),
    readConfiguration: async () => config,
    writeConfiguration: write,
    resetConfiguration: reset,
    publicOrigin: async () => "https://cloud.test",
    userById: async () => null,
    transfer: fetch,
    connect,
  });
  return { service, input, config, write, reset, connect };
}
test("saving unreadable configuration without a token fails before connection tests or writes", async () => {
  const { service, input, write, connect } = fixture();
  await expect(service.saveConfiguration(testCall(actor), { ...input, cloud: { ...input.cloud, enabled: true } })).rejects.toMatchObject({
    code: "configuration_unreadable",
    status: 409,
  });
  expect(write).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
});
test("a new token allows the explicit full replacement", async () => {
  const { service, input, write } = fixture();
  await service.saveConfiguration(testCall(actor), { ...input, token: "new-token" });
  expect(write).toHaveBeenCalledWith({ ...input, token: "new-token" }, testCall(actor));
});
test("administration reports unreadable before area disabled and does not connect", async () => {
  const { service, connect } = fixture();
  const result = await service.admin(testCall(actor), { area: "cloud", kind: "users" });
  expect(result.issue).toBe("configuration_unreadable");
  expect(result.configuration.unreadable).toBe(true);
  expect(result.configuration).not.toHaveProperty("token");
  expect(connect).not.toHaveBeenCalled();
});
test("reset requires the canonical admin permission", async () => {
  const allowed = fixture();
  await allowed.service.resetConfiguration(testCall(actor));
  expect(allowed.reset).toHaveBeenCalledTimes(1);
  const denied = fixture(false);
  await expect(denied.service.resetConfiguration(testCall(actor))).rejects.toMatchObject({ status: 403 });
  expect(denied.reset).not.toHaveBeenCalled();
});
test("user bases report unreadable and lifecycle refuses it before Filegate access", async () => {
  const { service, connect } = fixture();
  const result = await service.bases(testCall(actor));
  expect(result.issues).toContainEqual(expect.objectContaining({ code: "configuration_unreadable" }));
  await expect(service.refreshRoot(testCall(actor), "cloud")).rejects.toMatchObject({ code: "configuration_unreadable" });
  expect(connect).not.toHaveBeenCalled();
});
