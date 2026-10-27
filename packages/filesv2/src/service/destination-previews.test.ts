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
function fixture(
  sourceWritable = true,
  options: {
    unreadable?: boolean;
    missing?: boolean;
    unbound?: boolean;
    autoCreate?: boolean;
    cloudEnabled?: boolean;
    missingCloud?: boolean;
    missingFreeipa?: boolean;
  } = {},
) {
  spyOn(operations, "retiredPath").mockResolvedValue(false);
  spyOn(operations, "pending").mockResolvedValue(null);
  const area = { enabled: true, root: "freeipa", prefix: "", homes: "users", groups: "groups", archive: "archive" };
  const config = {
    activityRetentionDays: 365,
    url: "http://filegate.test",
    token: "test",
    tokenConfigured: true,
    unreadable: false,
    cloud: {
      ...area,
      enabled: options.cloudEnabled ?? Boolean(options.autoCreate),
      root: "cloud",
      autoCreate: options.autoCreate ?? true,
      autoArchive: true,
    },
    freeipa: area,
    collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
  };
  const requests: string[] = [];
  const aclPaths: string[] = [];
  const transport: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v1/roots/freeipa") return Response.json(info);
      if (url.pathname === "/v1/roots/cloud") return Response.json({ ...info, name: "cloud" });
      const path = url.searchParams.get("path") ?? "";
      if (url.pathname.endsWith("/acl")) {
        aclPaths.push(path);
        const readonly = path.endsWith("/readonly") || (!sourceWritable && path === "users/alice");
        return Response.json({
          entries: [
            { tag: "owner", permissions: readonly ? "r-x" : "rwx" },
            { tag: "owningGroup", permissions: "---" },
            { tag: "other", permissions: "---" },
          ],
        });
      }
      if (url.pathname.endsWith("/stat")) {
        if (
          (options.missing && path.endsWith("/gone.txt")) ||
          ((options.autoCreate || options.missingCloud) && path === "groups/newgroup") ||
          (options.missingFreeipa && path === "groups/team")
        )
          return Response.json({ error: "not_found" }, { status: 404 });
        return Response.json({
          path,
          directory: !path.endsWith(".txt"),
          size: 0,
          modified: "2026-10-01T12:00:00Z",
          mode: path.endsWith(".txt") ? 0o600 : 0o700,
          uid: options.unreadable && path.endsWith("/private.txt") ? 9999 : 1001,
          gid: path === "groups/team" ? 3001 : 2001,
        });
      }
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
      groups: async () => ({
        items: [
          { id: "team", name: "team", provider: "ipa" as const, gidNumber: 3001, personal: false },
          { id: "newgroup", name: "newgroup", provider: "local" as const, gidNumber: 3002, personal: false },
        ],
        nextCursor: null,
      }),
    },
    bindings: {
      ...bindings,
      find: async (candidate) =>
        options.unbound && candidate.kind === "groups" ? [] : [{ ...candidate, id: "binding", lifecycle: "active" as const }],
      claim,
    },
    displayNames: async (entries) => entries.map((entry) => ({ ...entry, displayName: "Alice" })),
    readConfiguration: async () => config,
    writeConfiguration: async () => {},
    resetConfiguration: async () => {},
    publicOrigin: async () => "https://cloud.test",
    userById: async () => null,
    transfer: transport,
    connect: (configuration) => connectFilegate(configuration, transport),
  });
  return { service, requests, aclPaths, claim };
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
  expect(f.aclPaths.filter((path) => path === "users/alice/target")).toHaveLength(2);
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

test("an unreadable 0600 leaf does not stop previews for the readable selection", async () => {
  const f = fixture(true, { unreadable: true });
  expect(
    await f.service.destinationPreviews(testCall(testActor), {
      baseId,
      paths: ["private.txt", "item.txt"],
      copyOnly: false,
      targets: [{ baseId, folder: "target" }],
    }),
  ).toMatchObject([{ canWrite: true, sourceCount: 2, sourceMovableCount: 1, copy: false }]);
});
test("a deleted source is counted without stopping destination reads", async () => {
  const f = fixture(true, { missing: true });
  expect(
    await f.service.destinationPreviews(testCall(testActor), {
      baseId,
      paths: ["gone.txt", "item.txt"],
      copyOnly: false,
      targets: [{ baseId, folder: "target" }],
    }),
  ).toMatchObject([{ canWrite: true, sourceCount: 2, sourceMovableCount: 1, copy: false }]);
});
test("first-use FreeIPA and auto-created Cloud targets stay unknown without claiming or provisioning", async () => {
  const f = fixture(true, { unbound: true, autoCreate: true });
  expect(
    await f.service.destinationPreviews(testCall(testActor), {
      baseId,
      paths: ["item.txt"],
      copyOnly: false,
      targets: [
        { baseId: "freeipa:groups:team", folder: "" },
        { baseId: "cloud:groups:newgroup", folder: "" },
      ],
    }),
  ).toMatchObject([
    { canWrite: null, access: null },
    { canWrite: null, access: null },
  ]);
  expect(f.claim).not.toHaveBeenCalled();
  expect(f.requests.every((request) => request.startsWith("GET "))).toBe(true);
});

test("missing FreeIPA, disabled auto-creation, and unbound Cloud targets stay unavailable", async () => {
  for (const input of [
    { options: { missingFreeipa: true }, target: "freeipa:groups:team" },
    { options: { missingCloud: true, cloudEnabled: true, autoCreate: false }, target: "cloud:groups:newgroup" },
    { options: { unbound: true, cloudEnabled: true }, target: "cloud:groups:newgroup" },
  ]) {
    const f = fixture(true, input.options);
    expect(
      await f.service.destinationPreviews(testCall(testActor), {
        baseId,
        paths: ["item.txt"],
        copyOnly: false,
        targets: [{ baseId: input.target, folder: "" }],
      }),
    ).toMatchObject([{ canWrite: false, access: null }]);
    expect(f.claim).not.toHaveBeenCalled();
  }
});
