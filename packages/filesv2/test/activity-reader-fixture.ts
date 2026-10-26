import type { resolveDisplayNames } from "@k2b/cloud/server";
import type { ACL, Node } from "@k2b/filegate";
import type { ActivityCandidate, CandidateInput } from "../src/data/activity-reader";
import type { Binding } from "../src/data/bases";
import { type ActivityReaderDependencies, createActivityReader } from "../src/service/activity-reader";
import { FilesError } from "../src/service/errors";
import { connectFilegate } from "../src/service/filegate-facade";
import { permits } from "../src/service/posix";
export const actorId = "10000000-0000-4000-8000-000000000001";
export const otherId = "10000000-0000-4000-8000-000000000002";
export const baseId = "20000000-0000-4000-8000-000000000001";
const batchId = "30000000-0000-4000-8000-000000000001";
const timestamp = new Date("2030-05-15T12:00:00.000Z");
export const home = "users/alice";
export const publicBaseId = `cloud:users:${actorId}`;
const area = { enabled: true, root: "cloud", prefix: "", homes: "users", groups: "groups", archive: "archive" };
const config = {
  url: "http://filegate.test",
  token: "test-only-token",
  tokenConfigured: true,
  unreadable: false,
  activityRetentionDays: 365,
  cloud: { ...area, autoCreate: true, autoArchive: false },
  freeipa: { ...area, root: "freeipa" },
  collabora: { url: "", internalUrl: "", wopiOrigin: "", documentFormat: "odf" as const },
};
export const historyBinding: Binding = {
  id: baseId,
  area: "cloud",
  kind: "users",
  identity_id: actorId,
  identity_name: "alice",
  root: "cloud",
  path: home,
  lifecycle: "active",
  uid_number: null,
  gid_number: null,
};
export function candidate(index = 1, patch: Partial<ActivityCandidate> = {}): ActivityCandidate {
  return {
    id: `40000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    started_at: timestamp,
    finished_at: timestamp,
    effective_time: timestamp.toISOString(),
    state: "done",
    action: "item.move",
    server_url: config.url,
    root: "cloud",
    root_after: null,
    base_id: baseId,
    base_after_id: null,
    item_id: "stable-a",
    item_after_id: "stable-a",
    directory: true,
    metadataUnknown: false,
    share_expires_at: null,
    path_before: `${home}/old`,
    path_after: `${home}/new`,
    size: "123",
    revision_before: "revision-old",
    revision_after: "revision-new",
    version_id: "version-private",
    actor_kind: "user",
    actor_user_id: otherId,
    via: "web",
    calling_app: "assistant",
    origin: "assistant",
    invocation_id: "invocation-ref",
    request_id: "request-ref",
    batch_id: batchId,
    observed_before: { exists: false, private: "must-not-return" },
    observed_after: { exists: true, id: "stable-a", path: "private-location", token: "private-token" },
    ...patch,
  };
}
export function historyFixture(rows: ActivityCandidate[] = [candidate()]) {
  const nodes = new Map<string, Node>();
  const denied = new Set<string>();
  const requests: string[] = [];
  const statFailures = new Map<string, number>();
  const authorized: string[] = [];
  const database: CandidateInput[] = [];
  let admin = false;
  let member = true;
  let stableIds = true;
  let serverUrl = config.url;
  const names = new Map([[otherId, "Live name"]]);
  const node = (path: string, id?: string, directory = true): Node => ({
    root: "cloud",
    path,
    id,
    directory,
    size: 123,
    modified: timestamp.toISOString(),
    uid: 1000,
    gid: 1000,
    mode: "0700",
  });
  nodes.set(home, node(home, "base-stable"));
  nodes.set(`${home}/new`, node(`${home}/new`, "stable-a"));
  const transport: typeof fetch = Object.assign(
    async (request: Parameters<typeof fetch>[0]) => {
      const url = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url);
      requests.push(url.pathname + url.search);
      const path = url.searchParams.get("path");
      if (url.pathname === "/v1/roots/cloud" || url.pathname.endsWith("/info")) return Response.json({ stableIds });
      if (url.pathname.endsWith("/stat")) {
        const failure = statFailures.get(path ?? "");
        if (failure) return Response.json({ error: failure === 403 ? "forbidden" : "unavailable" }, { status: failure });
        const found = nodes.get(path ?? "");
        return found ? Response.json(found) : Response.json({ error: "not_found" }, { status: 404 });
      }
      if (url.pathname.includes("/resolve")) {
        const id = url.searchParams.get("id") ?? decodeURIComponent(url.pathname.split("/").at(-1)!);
        const found = [...nodes.values()].find((value) => value.id === id);
        return found ? Response.json(found) : Response.json({ error: "not_found" }, { status: 404 });
      }
      throw new Error(`Unexpected Filegate request: ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );
  const displayNames: typeof resolveDisplayNames = async (entries) =>
    entries.map((entry) => ({
      ...entry,
      ...(entry.principal.type === "user" && names.has(entry.principal.userId) ? { displayName: names.get(entry.principal.userId) } : {}),
    }));
  async function authorize(publicId: string, path: string) {
    authorized.push(path);
    if (!member || publicId !== publicBaseId) throw new FilesError("not_found", 404);
    const target = path ? `${home}/${path}` : home;
    const found = nodes.get(target);
    if (!found) throw new FilesError("not_found", 404);
    const acl: ACL = { entries: [{ tag: "owner", permissions: denied.has(path) ? "---" : "rwx" }] };
    if (!permits(found, acl, { uid: 1000, gids: new Set([1000]) }, found.directory ? 5 : 4)) throw new FilesError("forbidden", 403);
    return {
      state: { config: { url: serverUrl } },
      inspection: { binding: historyBinding, summary: { id: publicBaseId } },
      target,
      node: found,
      info: { stableIds },
    };
  }
  const deps: ActivityReaderDependencies = {
    connect: (configuration, signal) => connectFilegate(configuration, transport, signal),
    requestContext: async () => ({
      userId: actorId,
      admin,
      config: { ...config, url: serverUrl },
      allowedBindingIds: member ? [baseId] : [],
      historyAvailable: true,
      readOnlyAuthorized: async (publicId, path) => authorize(publicId, path),
    }),
    bindings: { byId: async (id) => (id === baseId ? historyBinding : null) },
    displayNames,
    requireAdmin: async () => {
      if (!admin) throw new FilesError("forbidden", 403);
    },
    canReadShare: async (_actor, creatorId) => creatorId === actorId || admin,
    shares: { get: async () => null },

    data: {
      activityBases: async () => ({ items: [historyBinding], next: null }),
      candidates: async (input) => {
        database.push(input);
        return rows
          .filter((row) => {
            if (input.batch && (row.batch_id !== input.batch.id || row.id === input.batch.anchorId)) return false;
            if (
              !input.scope.admin &&
              !input.scope.bindingIds.includes(row.base_id ?? "") &&
              !input.scope.bindingIds.includes(row.base_after_id ?? "")
            )
              return false;
            if (!input.scope.admin && row.server_url !== input.scope.serverUrl) return false;
            if (![row.base_id, row.base_after_id].includes(baseId)) return false;
            if (input.baseId && ![row.base_id, row.base_after_id].some((id) => id === baseId && input.baseId === publicBaseId))
              return false;
            if (input.from && Date.parse(row.effective_time) < Date.parse(input.from)) return false;
            if (input.to && Date.parse(row.effective_time) > Date.parse(input.to)) return false;
            if (input.chain) {
              const chain = input.chain;
              const touches = (path: string | null) =>
                path !== null &&
                (path === chain.path || ((row.directory || row.metadataUnknown) && (path === "" || chain.path.startsWith(path + "/"))));
              const before =
                row.root === chain.root &&
                row.base_id === chain.baseId &&
                touches(row.path_before) &&
                ![
                  "folder.create",
                  "item.copy",
                  "file.upload",
                  "file.overwrite",
                  "file.create",
                  "file.edit",
                  "version.comment",
                  "version.restore",
                  "version.restore_copy",
                  "version.delete",
                  "share.create",
                  "share.revoke",
                  "item.restore",
                  "place.provision",
                  "admin.read",
                  "item.differs",
                  "item.elsewhere",
                  "item.missing",
                ].includes(row.action);
              const afterRoot = row.root_after ?? row.root;
              const afterBase = row.base_after_id ?? (afterRoot === row.root ? row.base_id : null);
              const after =
                afterRoot === chain.root &&
                afterBase === chain.baseId &&
                touches(row.path_after) &&
                [
                  "folder.create",
                  "file.create",
                  "file.upload",
                  "file.overwrite",
                  "item.copy",
                  "item.restore",
                  "version.restore_copy",
                  "place.provision",
                  "item.rename",
                  "item.move",
                  "place.archive",
                  "place.restore",
                ].includes(row.action);
              if (row.state !== "done" || row.server_url !== chain.serverUrl || !(before || after)) return false;
            }
            const order = input.position
              ? row.effective_time.localeCompare(input.position.time) || row.id.localeCompare(input.position.id)
              : 0;
            return !input.position || (input.direction === "asc" ? order > 0 : order < 0);
          })
          .sort(
            (a, b) => (a.effective_time.localeCompare(b.effective_time) || a.id.localeCompare(b.id)) * (input.direction === "asc" ? 1 : -1),
          )
          .slice(0, input.limit);
      },
      byId: async (id) => rows.find((row) => row.id === id) ?? null,
      shareAccess: async (input) => ({
        pageNetworks: 0,
        from: input.from,
        to: input.to,
        timeline: { items: [], next: null },
        pages: 5,
        downloads: 2,
        passwordFailed: 1,
        networks: { known: 0, incomplete: false, overflow: false, items: [], next: null, rolledUp: false },
      }),
    },
  };
  return {
    deps,
    reader: createActivityReader(deps),
    nodes,
    denied,
    requests,
    statFailures,
    authorized,
    database,
    names,
    node,
    setAdmin: (value: boolean) => {
      admin = value;
    },
    setMember: (value: boolean) => {
      member = value;
    },
    setStableIds: (value: boolean) => {
      stableIds = value;
    },
    setServer: (value: string) => {
      serverUrl = value;
    },
  };
}
