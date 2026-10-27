import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { accountIdentities } from "@k2b/cloud/services";
import type { RootInfo } from "@k2b/filegate";
import { testActor, testCall } from "../../test/files-call";
import { bindings } from "../data/bases";
import { operations } from "../data/operations";
import { connectFilegate } from "./filegate-facade";
import { createFilesService } from "./index";

const id = testActor.kind === "user" ? testActor.user.id : "";
const baseId = `freeipa:users:${id}`;
const info: RootInfo = {
  name: "freeipa",
  managed: false,
  stableIds: false,
  execution: true,
  index: { enabled: false, rebuilding: false, scanned: 0, lastBuilt: null, durationMs: 0 },
  stats: null,
  versioning: { enabled: true, keep: { last: 5, hourly: 0, daily: 0, weekly: 0, monthly: 0 } },
  cooldown: "1m",
  versions: 0,
  versionBytes: 0,
  filesystem: "ext4",
  capacity: 100,
  available: 50,
  activeUploads: 0,
  stagingBytes: 0,
};
afterEach(() => mock.restore());
function fixture(sourceWritable = true) {
  spyOn(operations, "pending").mockResolvedValue(null);
  const area = { enabled: true, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" };
  const config = {
    activityRetentionDays: 365,
    url: "http://filegate.test",
    token: "test",
    tokenConfigured: true,
    unreadable: false,
    cloud: { ...area, enabled: false, root: "cloud", autoCreate: true, autoArchive: true },
    freeipa: area,
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
  };
  const requests: string[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v1/roots/freeipa") return Response.json(info);
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname.endsWith("/acl")) {
        const readonly = path.endsWith("/readonly") || (!sourceWritable && path === "users/alice");
        return Response.json({
          entries: [
            { tag: "owner", permissions: readonly ? "r-x" : "rwx" },
            { tag: "owningGroup", permissions: "---" },
            { tag: "other", permissions: "---" },
          ],
        });
      }
      if (url.pathname.endsWith("/stat"))
        return Response.json({
          path,
          directory: !path.endsWith("/item.txt"),
          size: 0,
          modified: "2026-10-01T12:00:00Z",
          mode: 0o700,
          uid: 1001,
          gid: 2001,
        });
      throw new Error(`Unexpected Filegate request: ${url}`);
    },
    { preconnect: fetch.preconnect },
  );
  const claim = mock(async (): Promise<never> => {
    throw new Error("Preview must never claim a binding");
  });
  const service = createFilesService({
    identities: {
      ...accountIdentities,
      self: async () => ({
        user: {
          id,
          username: "alice",
          provider: "ipa" as const,
          profile: "user" as const,
          posix: { uidNumber: 1001, primaryGidNumber: 2001 },
        },
        availability: { localLinuxEnabled: true, freeipaEnabled: true },
      }),
      groups: async () => ({ items: [], nextCursor: null }),
    },
    bindings: { ...bindings, find: async (candidate) => [{ ...candidate, id: "binding", lifecycle: "active" as const }], claim },
    displayNames: async (entries) => entries.map((entry) => ({ ...entry, displayName: "Alice" })),
    readConfiguration: async () => config,
    writeConfiguration: async () => {},
    resetConfiguration: async () => {},
    publicOrigin: async () => "https://cloud.test",
    userById: async () => null,
    transfer: transport,
    connect: (configuration) => connectFilegate(configuration, transport),
  });
  return { service, requests, claim };
}
test("dry run reports versioning and writable/read-only targets without any writes", async () => {
  const f = fixture();
  const result = await f.service.destinationPreviews(testCall(testActor), {
    baseId,
    paths: ["item.txt"],
    copyOnly: false,
    targets: [
      { baseId, folder: "target" },
      { baseId, folder: "readonly" },
      { baseId: "freeipa:users:someone-else", folder: "" },
      { baseId, folder: "trash" },
    ],
  });
  expect(result).toMatchObject([
    { canWrite: true, copy: false, copyReason: null, versioningEnabled: true, access: { kind: "filesystem", owner: true } },
    { canWrite: false, copy: false, versioningEnabled: true },
    { canWrite: false, access: null },
    { canWrite: false, folder: "trash", access: null },
  ]);
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.requests.every((request) => request.startsWith("GET "))).toBe(true);
});
test("a source that cannot be removed becomes a copy, and explicit copy remains a copy", async () => {
  const f = fixture(false);
  const input = { baseId, paths: ["item.txt"], targets: [{ baseId, folder: "target" }], copyOnly: false };
  expect(await f.service.destinationPreviews(testCall(testActor), input)).toMatchObject([
    { canWrite: true, copy: true, copyReason: "source_read_only" },
  ]);
  expect(await f.service.destinationPreviews(testCall(testActor), { ...input, copyOnly: true })).toMatchObject([
    { copy: true, copyReason: "requested" },
  ]);
});
test("mixed source rights keep the existing partial move behavior", async () => {
  const f = fixture(false);
  expect(
    await f.service.destinationPreviews(testCall(testActor), {
      baseId,
      paths: ["item.txt", "writable/item.txt"],
      targets: [{ baseId, folder: "target" }],
      copyOnly: false,
    }),
  ).toMatchObject([{ sourceCount: 2, sourceMovableCount: 1, copy: false, copyReason: null }]);
});
test("a foreign source is rejected before Filegate reads", async () => {
  const f = fixture();
  await expect(
    f.service.destinationPreviews(testCall(testActor), {
      baseId: "freeipa:users:foreign",
      paths: ["item.txt"],
      copyOnly: false,
      targets: [{ baseId, folder: "target" }],
    }),
  ).rejects.toMatchObject({ status: 404 });
  expect(f.requests).toEqual([]);
});
