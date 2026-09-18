import type { RequestActor } from "@k2b/cloud/server";
import { type AccountIdentityGroup, type AccountIdentityPage, type AccountIdentityUser, accountIdentities } from "@k2b/cloud/services";
import { Filegate, FilegateError, type Node, type RootClient, type RootInfo } from "@k2b/filegate";
import { z } from "zod";
import type {
  FileEntry,
  AdminResult,
  Area,
  Availability,
  BaseKind,
  BaseSummary,
  BasesResult,
  ConfigurationInput,
  DirectoryResult,
  DownloadLease,
  EntryResult,
  InventoryEntry,
  InventoryState,
  RootSummary,
  SearchResult,
  UploadLease,
  UploadSession,
} from "../contracts";
import { type Binding, bindings, type NewBinding } from "../data/bases";
import { operations } from "../data/operations";
import { uploads } from "../data/uploads";
import { readConfiguration, writeConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { createDirectoryLifecycle } from "./lifecycle";
import { joinPath, relativePath, userPath, validateConfiguration } from "./paths";
import { permits, type UnixIdentity } from "./posix";

export { FilesError } from "./errors";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Group = Awaited<ReturnType<typeof accountIdentities.groups>>["items"][number];
type Identity = { id: string; name: string; uid: number | null; gid: number | null };
type Candidate = NewBinding & { name: string };
type Inspection = { summary: BaseSummary; candidate: Candidate; binding: Binding | null };
const PAGE_SIZE = 50;
/** Filesystem scans without an index stop here; Filegate answers 413 beyond it. */
const SEARCH_SCAN_LIMIT = 10_000;
const fileEntry = (relative: string, node: Node): FileEntry => ({
  name: relative.split("/").at(-1)!,
  path: relative,
  directory: node.directory,
  size: node.size,
  modified: node.modified,
});
const filesystemCursor = z.tuple([
  z.string().max(4096).nullable(),
  z
    .number()
    .int()
    .min(0)
    .max(PAGE_SIZE - 1),
]);
function readFilesystemCursor(value: string): [string | null, number] {
  if (value === "fs:") return [null, 0];
  try {
    return filesystemCursor.parse(JSON.parse(Buffer.from(value.slice(3), "base64url").toString()));
  } catch {
    throw new FilesError("invalid_cursor");
  }
}
const writeFilesystemCursor = (after: string | null, offset = 0) =>
  `fs:${Buffer.from(JSON.stringify([after, offset])).toString("base64url")}`;
const areaProvider = (area: Area) => (area === "cloud" ? ("local" as const) : ("ipa" as const));
const rootSummary = (info: RootInfo): RootSummary => ({
  name: info.name,
  indexEnabled: info.index.enabled,
  versioningEnabled: info.versioning.enabled,
  files: info.stats?.files ?? null,
  directories: info.stats?.directories ?? null,
  bytes: info.stats?.bytes ?? null,
  versions: info.versions,
  versionBytes: info.versionBytes,
  activeUploads: info.activeUploads,
  available: info.available,
  capacity: info.capacity,
});
const sameBinding = (binding: Binding, candidate: Candidate) =>
  binding.identity_id === candidate.identity_id &&
  binding.area === candidate.area &&
  binding.kind === candidate.kind &&
  binding.root === candidate.root &&
  binding.path === candidate.path &&
  binding.uid_number === candidate.uid_number &&
  binding.gid_number === candidate.gid_number;
const issueFor = (config: Config, area: Area, availability: Availability) =>
  !config[area].enabled
    ? "area_disabled"
    : area === "cloud" && !availability.localLinuxEnabled
      ? "local_linux_disabled"
      : area === "freeipa" && !availability.freeipaEnabled
        ? "freeipa_disabled"
        : !config.url || !config.token
          ? "not_configured"
          : null;

/** One service for API and SSR. Every operation resolves the acting identity again. */
export function createFilesService(
  deps = {
    identities: accountIdentities,
    bindings,
    readConfiguration,
    writeConfiguration,
    connect: (config: Config) =>
      new Filegate({
        baseUrl: config.url,
        token: config.token,
        fetch: Object.assign(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(10_000) }),
          { preconnect: fetch.preconnect },
        ),
      }),
  },
) {
  const { provisionCandidate, ...lifecycle } = createDirectoryLifecycle(deps);
  async function allGroups(actor: RequestActor): Promise<Group[]> {
    const result: Group[] = [];
    const deadline = Date.now() + 10_000;
    let after: string | undefined;
    do {
      if (Date.now() >= deadline) throw new FilesError("unavailable", 503);
      const page = await deps.identities.groups(actor, { after });
      result.push(...page.items);
      after = page.nextCursor ?? undefined;
    } while (after);
    return result;
  }
  function candidate(config: Config, area: Area, kind: BaseKind, identity: Identity): Candidate {
    const name = relativePath(identity.name, false);
    if (name.includes("/")) throw new FilesError("invalid_path");
    return {
      area,
      kind,
      identity_id: identity.id,
      identity_name: name,
      name,
      root: config[area].root,
      path: joinPath(config[area].prefix, kind === "users" ? config[area].homes : config[area].groups, name),
      uid_number: identity.uid,
      gid_number: identity.gid,
    };
  }
  async function inspect(root: RootClient, item: Candidate, info: RootInfo, adopt = false): Promise<Inspection> {
    const summary: BaseSummary = {
      id: `${item.area}:${item.kind}:${item.identity_id}`,
      area: item.area,
      kind: item.kind,
      name: item.name,
      status: "unknown",
      reason: null,
      indexEnabled: info.index.enabled,
      versioningEnabled: info.versioning.enabled,
    };
    const result = (status: BaseSummary["status"], reason: string | null, binding: Binding | null = null): Inspection => ({
      candidate: item,
      summary: { ...summary, status, reason },
      binding,
    });
    let existing = await deps.bindings.find(item);
    if (!existing.length && (await operations.retiredPath(item.root, item.path))) return result("retired", "retired");
    if (existing.some((binding) => !sameBinding(binding, item))) return result("conflict", "binding_conflict");
    if (existing.some((binding) => ["retired", "archived", "deleted"].includes(binding.lifecycle)))
      return result("retired", "retired", existing[0] ?? null);
    if (await operations.pending(item.root, item.path)) return result("unknown", "operation_pending", existing[0] ?? null);
    let node: Node;
    try {
      node = await root.stat(item.path);
    } catch (error) {
      if (error instanceof FilegateError && error.status === 404) return result("missing", "not_found");
      throw error;
    }
    if (!node.directory) return result("conflict", "not_directory");
    if (item.area === "freeipa") {
      if (item.gid_number === null || (item.kind === "users" && item.uid_number === null)) return result("unknown", "identity_incomplete");
      if (node.gid !== item.gid_number || (item.kind === "users" && node.uid !== item.uid_number))
        return result("conflict", "ownership_mismatch");
    }
    if (!existing.length && (item.area === "freeipa" || adopt)) existing = await deps.bindings.claim(item);
    if (!existing.length) return result("unassigned", "unassigned");
    if (existing.length !== 1 || !sameBinding(existing[0]!, item)) return result("conflict", "binding_conflict");
    return result("existing", null, existing[0]!);
  }
  async function context(actor: RequestActor) {
    const self = await deps.identities.self(actor);
    if (self.user.profile !== "user") throw new FilesError("forbidden", 403);
    const config = await deps.readConfiguration();
    const groups = await allGroups(actor);
    const unix: UnixIdentity | null =
      self.user.provider === "ipa" && self.user.posix
        ? {
            uid: self.user.posix.uidNumber,
            gids: new Set([
              self.user.posix.primaryGidNumber,
              ...groups.filter((group) => group.provider === "ipa" && group.gidNumber !== null).map((group) => group.gidNumber!),
            ]),
          }
        : null;
    const candidates: Candidate[] = [];
    const homeArea: Area = self.user.provider === "ipa" ? "freeipa" : "cloud";
    if (self.user.provider === "local" || self.user.provider === "ipa")
      candidates.push(
        candidate(config, homeArea, "users", {
          id: self.user.id,
          name: self.user.username,
          uid: homeArea === "freeipa" ? (self.user.posix?.uidNumber ?? null) : null,
          gid: homeArea === "freeipa" ? (self.user.posix?.primaryGidNumber ?? null) : null,
        }),
      );
    for (const group of groups)
      if (group.gidNumber !== null)
        candidates.push(
          candidate(config, group.provider === "ipa" ? "freeipa" : "cloud", "groups", {
            id: group.id,
            name: group.name,
            uid: null,
            gid: group.gidNumber,
          }),
        );
    return { self, config, unix, candidates };
  }
  async function checkUnix(root: RootClient, path: string, unix: UnixIdentity | null, leafRights: number) {
    if (!unix) throw new FilesError("identity_incomplete", 403);
    const parts = path.split("/");
    for (let i = 0; i <= parts.length; i++) {
      const current = i === 0 ? "." : parts.slice(0, i).join("/");
      const node = await root.stat(current);
      if (i < parts.length && !node.directory) throw new FilesError("not_directory", 403);
      const acl = await root.getACL(current, "access");
      if (!permits(node, acl, unix, i === parts.length ? leafRights : 1)) throw new FilesError("forbidden", 403);
    }
  }
  async function authorized(actor: RequestActor, baseId: string, path: string, directory?: boolean) {
    const state = await context(actor);
    const item = state.candidates.find((candidate) => `${candidate.area}:${candidate.kind}:${candidate.identity_id}` === baseId);
    if (!item) throw new FilesError("not_found", 404);
    const issue = issueFor(state.config, item.area, state.self.availability);
    if (issue) throw new FilesError(issue, 403);
    const root = deps.connect(state.config).root(item.root);
    const info = await root.info();
    let inspection = await inspect(root, item, info);
    if (inspection.summary.status === "missing" && item.area === "cloud" && state.config.cloud.autoCreate) {
      await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
      inspection = await inspect(root, item, info);
    }
    if (inspection.summary.status !== "existing") throw new FilesError(inspection.summary.reason ?? "forbidden", 403);
    const relative = userPath(path);
    const target = joinPath(item.path, relative);
    const node = await root.stat(target);
    if (item.area === "freeipa") await checkUnix(root, target, state.unix, node.directory ? 5 : 4);
    if (directory !== undefined && node.directory !== directory) throw new FilesError(directory ? "not_directory" : "not_file", 400);
    return { root, inspection, target, relative, state, node, info };
  }
  /** Parent folder of a new entry: authorized for reading, writable, and never inside trash. */
  async function writableParent(actor: RequestActor, baseId: string, path: string) {
    const relative = userPath(path);
    if (!relative) throw new FilesError("invalid_path");
    const parts = relative.split("/");
    const current = await authorized(actor, baseId, parts.slice(0, -1).join("/"), true);
    if (current.inspection.candidate.area === "freeipa") await checkUnix(current.root, current.target, current.state.unix, 3);
    return { ...current, relative, name: parts.at(-1)! };
  }
  const ownershipFor = (current: Awaited<ReturnType<typeof writableParent>>, directory: boolean) => {
    const { candidate } = current.inspection;
    const mode = directory ? (candidate.kind === "groups" ? "2770" : "0700") : candidate.kind === "groups" ? "0660" : "0600";
    return candidate.area === "freeipa"
      ? { uid: current.state.unix!.uid, gid: current.node.gid, [directory ? "dirMode" : "mode"]: mode }
      : { [directory ? "dirMode" : "mode"]: mode };
  };
  /** Filegate caps session leases at five minutes; clients renew through Cloud while a session stays open. */
  const UPLOAD_LEASE_SECONDS = 300;
  /** Sessions are bound to the user that opened them; commit re-checks the target before Filegate publishes. */
  async function uploadRow(actor: RequestActor, baseId: string, id: string) {
    const state = await context(actor);
    const row = await uploads.get(id, state.self.user.id);
    if (!row) throw new FilesError("not_found", 404);
    const current = await writableParent(actor, baseId, row.path);
    if (current.inspection.binding?.id !== row.base_id) throw new FilesError("not_found", 404);
    return { row, current };
  }
  async function requireAdmin(actor: RequestActor) {
    // The public inventory contract performs the canonical admin check.
    await deps.identities.inventory(actor, { kind: "groups", provider: "local" });
    return deps.identities.self(actor);
  }
  return {
    ...lifecycle,
    async bases(actor: RequestActor): Promise<BasesResult> {
      const state = await context(actor);
      const output: BasesResult = { items: [], issues: [] };
      for (const area of ["cloud", "freeipa"] as const) {
        const issue = issueFor(state.config, area, state.self.availability);
        if (issue) {
          output.issues.push({ area, code: issue });
          continue;
        }
        try {
          const root = deps.connect(state.config).root(state.config[area].root);
          const info = await root.info();
          for (const item of state.candidates.filter((item) => item.area === area)) {
            let entry = await inspect(root, item, info);
            if (entry.summary.status === "missing" && area === "cloud" && state.config.cloud.autoCreate) {
              await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
              entry = await inspect(root, item, info);
            }
            if (entry.summary.status === "existing" && area === "freeipa") {
              try {
                await checkUnix(root, item.path, state.unix, 5);
              } catch (error) {
                entry.summary.status = error instanceof FilesError && error.code === "forbidden" ? "conflict" : "unknown";
                entry.summary.reason = error instanceof FilesError ? error.code : "unavailable";
              }
            }
            output.items.push(entry.summary);
          }
        } catch {
          output.issues.push({ area, code: "unavailable" });
        }
      }
      return output;
    },
    async list(actor: RequestActor, input: { baseId: string; path?: string; after?: string }): Promise<DirectoryResult> {
      const current = await authorized(actor, input.baseId, input.path ?? "", true);
      const page = await current.root.list(current.target, { after: input.after, limit: PAGE_SIZE });
      const items: DirectoryResult["items"] = [];
      for (const node of page.items) {
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (!node.path.startsWith(`${current.target}/`) || node.path.slice(current.target.length + 1).includes("/"))
          throw new FilesError("unavailable", 503);
        if (!relative || relative.split("/")[0] === "trash") continue;
        items.push(fileEntry(relative, node));
      }
      return { base: current.inspection.summary, path: current.relative, items, next: page.next ?? null };
    },
    async search(actor: RequestActor, input: { baseId: string; path?: string; q: string; after?: string }): Promise<SearchResult> {
      const current = await authorized(actor, input.baseId, input.path ?? "", true);
      let page: Awaited<ReturnType<RootClient["search"]>>;
      try {
        page = await current.root.search(input.q, {
          path: current.target,
          after: input.after,
          limit: PAGE_SIZE,
          maxEntries: SEARCH_SCAN_LIMIT,
        });
      } catch (error) {
        if (error instanceof FilegateError && error.status === 413) throw new FilesError("search_limited");
        throw error;
      }
      // FreeIPA rights are checked per hit; directories between the searched folder and a hit are cached.
      const checked = new Map<string, Promise<boolean>>();
      const readable = (path: string, rights: number) => {
        const key = `${path}:${rights}`;
        if (!checked.has(key))
          checked.set(
            key,
            (async () => {
              const node = await current.root.stat(path);
              const acl = await current.root.getACL(path, "access");
              return permits(node, acl, current.state.unix!, rights);
            })().catch(() => false),
          );
        return checked.get(key)!;
      };
      const items: FileEntry[] = [];
      for (const node of page.items) {
        if (!node.path.startsWith(`${current.target}/`)) continue;
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (relative.split("/")[0] === "trash") continue;
        if (current.inspection.candidate.area === "freeipa") {
          const parts = node.path.slice(current.target.length + 1).split("/");
          let allowed = await readable(node.path, node.directory ? 5 : 4);
          for (let i = 1; allowed && i < parts.length; i++)
            allowed = await readable(`${current.target}/${parts.slice(0, i).join("/")}`, 1);
          if (!allowed) continue;
        }
        items.push(fileEntry(relative, node));
      }
      return { base: current.inspection.summary, path: current.relative, query: input.q, items, next: page.next ?? null };
    },
    async mkdir(actor: RequestActor, input: { baseId: string; path: string }): Promise<EntryResult> {
      const current = await writableParent(actor, input.baseId, input.path);
      const node = await current.root.mkdir(joinPath(current.target, current.name), { ownership: ownershipFor(current, true) });
      return { base: current.inspection.summary, entry: fileEntry(current.relative, node) };
    },
    async upload(
      actor: RequestActor,
      input: { baseId: string; path: string; size: number; onConflict: "error" | "overwrite" },
    ): Promise<UploadSession> {
      const current = await writableParent(actor, input.baseId, input.path);
      const target = joinPath(current.target, current.name);
      // Filegate only detects name conflicts at commit; checking now avoids transferring bytes that cannot be published.
      let existing: Node | null = null;
      try {
        existing = await current.root.stat(target);
      } catch (error) {
        if (!(error instanceof FilegateError && error.status === 404)) throw error;
      }
      if (existing && input.onConflict === "error") throw new FilesError("path_conflict", 409);
      if (existing?.directory) throw new FilesError("not_file", 409);
      if (existing && current.inspection.candidate.area === "freeipa") await checkUnix(current.root, target, current.state.unix, 2);
      if (input.size > current.info.available) throw new FilesError("insufficient_space", 409);
      const created = await current.root.createSession(target, input.size, {
        onConflict: input.onConflict,
        ownership: ownershipFor(current, false),
        expiresIn: UPLOAD_LEASE_SECONDS,
        allowAbort: true,
      });
      await uploads.create({
        id: created.session.id,
        base_id: current.inspection.binding!.id,
        user_id: current.state.self.user.id,
        root: current.inspection.candidate.root,
        path: current.relative,
        size: input.size,
      });
      return {
        id: created.session.id,
        path: current.relative,
        size: input.size,
        chunkSize: created.session.chunkSize,
        url: created.lease.url,
        expires: created.lease.expires,
      };
    },
    async uploadLease(actor: RequestActor, input: { baseId: string; id: string }): Promise<UploadLease> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state !== "open") throw new FilesError("upload_closed", 409);
      const lease = await current.root.sessionLease(row.id, { expiresIn: UPLOAD_LEASE_SECONDS, allowAbort: true });
      return { url: lease.url, expires: lease.expires };
    },
    async commitUpload(actor: RequestActor, input: { baseId: string; id: string }): Promise<EntryResult> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      const base = current.inspection.summary;
      if (row.state === "committed" && row.result) return { base, entry: fileEntry(row.path, row.result) };
      if (row.state === "aborted") throw new FilesError("upload_closed", 409);
      // A commit whose response was lost is recognised from Filegate's session record.
      const session = await current.root.session(row.id);
      if (session.state === "committed" && session.result) {
        await uploads.finish(row.id, "committed", session.result);
        return { base, entry: fileEntry(row.path, session.result) };
      }
      if (session.state !== "open") {
        await uploads.finish(row.id, "aborted", null);
        throw new FilesError("upload_closed", 409);
      }
      if (session.received !== session.size) throw new FilesError("upload_incomplete");
      const node = await current.root.commitSession(row.id);
      await uploads.finish(row.id, "committed", node);
      return { base, entry: fileEntry(row.path, node) };
    },
    async abortUpload(actor: RequestActor, input: { baseId: string; id: string }): Promise<void> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state !== "open") return;
      try {
        await current.root.abortSession(row.id);
      } catch (error) {
        if (!(error instanceof FilegateError && (error.status === 404 || error.status === 409))) throw error;
      }
      await uploads.finish(row.id, "aborted", null);
    },
    async entry(actor: RequestActor, input: { baseId: string; path: string }): Promise<EntryResult> {
      if (!input.path) throw new FilesError("invalid_path");
      const current = await authorized(actor, input.baseId, input.path);
      return { base: current.inspection.summary, entry: fileEntry(current.relative, current.node) };
    },
    async thumbnail(actor: RequestActor, input: { baseId: string; path: string; size: "small" | "large" }): Promise<DownloadLease> {
      if (!input.path) throw new FilesError("invalid_path");
      const current = await authorized(actor, input.baseId, input.path, false);
      const dimension = input.size === "large" ? 1024 : 320;
      const lease = await current.root.directThumbnail(current.target, { width: dimension, height: dimension, expiresIn: 60 });
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async download(actor: RequestActor, input: { baseId: string; path: string }): Promise<DownloadLease> {
      if (!input.path) throw new FilesError("not_file");
      const current = await authorized(actor, input.baseId, input.path, false);
      const lease = await current.root.directDownload(current.target, 60);
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async saveConfiguration(actor: RequestActor, input: ConfigurationInput) {
      const self = await requireAdmin(actor);
      validateConfiguration(input);
      if (input.cloud.enabled && !self.availability.localLinuxEnabled) throw new FilesError("local_linux_disabled");
      if (input.freeipa.enabled && !self.availability.freeipaEnabled) throw new FilesError("freeipa_disabled");
      const current = await deps.readConfiguration();
      const next = { ...input, token: input.token || current.token, tokenConfigured: Boolean(input.token || current.token) };
      if (input.cloud.enabled || input.freeipa.enabled) {
        if (!next.url || !next.token) throw new FilesError("not_configured");
        const client = deps.connect(next);
        for (const area of ["cloud", "freeipa"] as const)
          if (input[area].enabled) {
            const root = client.root(input[area].root);
            await root.info();
            const node = await root.stat(joinPath(input[area].prefix));
            if (!node.directory) throw new FilesError("not_directory");
          }
      }
      await deps.writeConfiguration(input);
    },
    async admin(
      actor: RequestActor,
      input: { area: Area; kind: BaseKind; after?: string; q?: string; status?: InventoryState; includeEntries?: "true" | "false" },
    ): Promise<AdminResult> {
      const self = await requireAdmin(actor);
      const config = await deps.readConfiguration();
      const { token: _token, ...configuration } = config;
      const output: AdminResult = { configuration, availability: self.availability, root: null, items: [], next: null, issue: null };
      const issue = issueFor(config, input.area, self.availability);
      if (issue) {
        output.issue = issue;
        return output;
      }
      const root = deps.connect(config).root(config[input.area].root);
      let info: RootInfo;
      try {
        info = await root.info();
        output.root = rootSummary(info);
      } catch {
        output.issue = "unavailable";
        return output;
      }
      if (input.includeEntries === "false") return output;
      // Leave response time within the HTTP idle window even when FreeIPA is slow.
      const deadline = Date.now() + 5_000;
      const signal = AbortSignal.timeout(5_000);
      const matchesSearch = (name: string, path: string) =>
        !input.q || `${name} ${path}`.toLocaleLowerCase().includes(input.q.toLocaleLowerCase());
      const include = (item: InventoryEntry) => {
        if (input.status && item.status !== input.status) return;
        if (!matchesSearch(item.name, item.path)) return;
        output.items.push(item);
      };
      const entry = async (name: string, identityId: string | null, knownCandidate: Candidate | null): Promise<InventoryEntry> => {
        const path = joinPath(
          config[input.area].prefix,
          input.kind === "users" ? config[input.area].homes : config[input.area].groups,
          name,
        );
        const binding = await deps.bindings.path(root.name, path);
        const proof = await deps.identities.reconcile(actor, {
          kind: input.kind,
          provider: areaProvider(input.area),
          name,
          identityId: binding?.identity_id,
          signal,
        });
        const node = await root.stat(path).catch((error) => {
          if (error instanceof FilegateError && error.status === 404) return null;
          throw error;
        });
        let status: InventoryState = node ? "unassigned" : "missing";
        let reason: string | null = null;
        if (proof.state === "unknown") {
          status = "unknown";
          reason = "identity_unknown";
        } else if (proof.state === "absent") {
          status = node ? "orphaned" : "missing";
          reason = "identity_missing";
        } else if (binding && proof.identity.id !== null && binding.identity_id !== proof.identity.id) {
          status = "conflict";
          reason = "binding_conflict";
        } else if (!proof.eligible) {
          status = input.area === "freeipa" ? "unknown" : node ? "orphaned" : "missing";
          reason = "identity_ineligible";
        } else if (node && !node.directory) {
          status = "conflict";
          reason = "not_directory";
        } else if (
          node &&
          input.area === "freeipa" &&
          (node.gid !== proof.identity.gidNumber || (input.kind === "users" && node.uid !== proof.identity.uidNumber))
        ) {
          status = "conflict";
          reason = "ownership_mismatch";
        } else if (knownCandidate) {
          const checked = await inspect(root, knownCandidate, info);
          status = checked.summary.status;
          reason = checked.summary.reason;
        } else if (node && proof.state === "present") {
          status = "existing";
          reason = null;
        }
        if (binding && status !== "conflict" && ["retired", "archived", "deleted"].includes(binding.lifecycle)) {
          status = "retired";
          reason = "retired";
        }
        if (!binding && status !== "conflict" && (await operations.retiredPath(root.name, path))) {
          status = "retired";
          reason = "retired";
        }
        const pending = await operations.pendingWithin(root.name, path);
        if (pending) {
          status = "unknown";
          reason = "operation_pending";
        }
        const safe = !pending && proof.state !== "unknown" && status !== "conflict";
        const adopt = input.area === "cloud" && status === "unassigned" && identityId !== null;
        return {
          area: input.area,
          kind: input.kind,
          identityId,
          name,
          path,
          status,
          reason,
          baseId: binding?.id ?? null,
          operationId: pending?.id ?? null,
          uid: node?.uid ?? null,
          gid: node?.gid ?? null,
          actions: {
            create: status === "missing" && identityId !== null && proof.state === "present" && proof.eligible,
            adopt,
            archive: Boolean(node?.directory && safe && binding?.lifecycle !== "archived" && binding?.lifecycle !== "deleted"),
            browse: Boolean(node?.directory),
            delete: Boolean(node && safe),
            retire: binding !== null && binding.lifecycle === "active" && safe,
          },
        };
      };
      // Fill a filtered page across both sources within the scan budget.
      // The cursor records every consumed row,
      // including filtered rows, so empty partial scans still make progress.
      let cursor: string | null | undefined = input.after;
      while (cursor !== null && output.items.length < PAGE_SIZE && Date.now() < deadline) {
        if (!cursor?.startsWith("fs:")) {
          const page: AccountIdentityPage<AccountIdentityUser | AccountIdentityGroup> =
            input.kind === "users"
              ? await deps.identities.inventory(actor, { kind: "users", provider: areaProvider(input.area), after: cursor })
              : await deps.identities.inventory(actor, { kind: "groups", provider: areaProvider(input.area), after: cursor });
          if (page.items.length === 0) cursor = page.nextCursor ?? "fs:";
          for (const [index, identity] of page.items.entries()) {
            if (Date.now() >= deadline || output.items.length >= PAGE_SIZE) break;
            cursor = index === page.items.length - 1 ? (page.nextCursor ?? "fs:") : identity.id;
            if (("gidNumber" in identity && identity.gidNumber === null) || ("profile" in identity && identity.profile !== "user"))
              continue;
            const item = candidate(
              config,
              input.area,
              input.kind,
              "username" in identity
                ? {
                    id: identity.id,
                    name: identity.username,
                    uid: input.area === "freeipa" ? (identity.posix?.uidNumber ?? null) : null,
                    gid: input.area === "freeipa" ? (identity.posix?.primaryGidNumber ?? null) : null,
                  }
                : { id: identity.id, name: identity.name, uid: null, gid: identity.gidNumber },
            );
            if (!matchesSearch(item.name, item.path)) continue;
            try {
              include(await entry(item.name, item.identity_id, item));
            } catch {
              include({
                area: input.area,
                kind: input.kind,
                identityId: item.identity_id,
                name: item.name,
                path: item.path,
                status: "unknown",
                reason: "unavailable",
                baseId: null,
                operationId: null,
                uid: null,
                gid: null,
                actions: { create: false, adopt: false, archive: false, browse: false, delete: false, retire: false },
              });
            }
          }
          continue;
        }
        const [after, offset] = readFilesystemCursor(cursor);
        const parent = joinPath(config[input.area].prefix, input.kind === "users" ? config[input.area].homes : config[input.area].groups);
        try {
          const page = await root.list(parent, { limit: PAGE_SIZE, after: after ?? undefined });
          if (page.items.length <= offset) cursor = page.next ? writeFilesystemCursor(page.next) : null;
          for (let index = offset; index < page.items.length; index++) {
            if (Date.now() >= deadline || output.items.length >= PAGE_SIZE) break;
            const node = page.items[index]!;
            if (!node.path.startsWith(`${parent}/`) || node.path.slice(parent.length + 1).includes("/"))
              throw new FilesError("unavailable", 503);
            const name = node.path.slice(parent.length + 1);
            const nextCursor =
              index === page.items.length - 1
                ? page.next
                  ? writeFilesystemCursor(page.next)
                  : null
                : writeFilesystemCursor(after, index + 1);
            if (!matchesSearch(name, node.path)) {
              cursor = nextCursor;
              continue;
            }
            const known =
              input.kind === "users"
                ? await deps.identities.inventory(actor, { kind: "users", provider: areaProvider(input.area), name })
                : await deps.identities.inventory(actor, { kind: "groups", provider: areaProvider(input.area), name });
            const identity = known.items[0];
            // Eligible Cloud identities were already inspected in the first phase.
            if (
              !identity ||
              !(("profile" in identity && identity.profile === "user") || ("gidNumber" in identity && identity.gidNumber !== null))
            )
              include(await entry(name, identity?.id ?? null, null));
            cursor = nextCursor;
          }
        } catch (error) {
          if (error instanceof FilegateError && error.status === 404) cursor = null;
          else output.issue = "unavailable";
          break;
        }
      }
      if (cursor === undefined) throw new FilesError("unavailable", 503);
      output.next = cursor;
      return output;
    },
    async adopt(actor: RequestActor, input: { area: Area; kind: BaseKind; identityId: string }) {
      const self = await requireAdmin(actor);
      const config = await deps.readConfiguration();
      const issue = issueFor(config, input.area, self.availability);
      if (issue) throw new FilesError(issue, 403);
      // Filled using public filtered inventory, never application reads of auth tables.
      const page =
        input.kind === "users"
          ? await deps.identities.inventory(actor, { kind: "users", provider: areaProvider(input.area), id: input.identityId })
          : await deps.identities.inventory(actor, { kind: "groups", provider: areaProvider(input.area), id: input.identityId });
      const identity = page.items.find((item) => item.id === input.identityId);
      if (!identity || ("gidNumber" in identity && identity.gidNumber === null) || ("profile" in identity && identity.profile !== "user"))
        throw new FilesError("not_found", 404);
      const item = candidate(
        config,
        input.area,
        input.kind,
        "username" in identity
          ? {
              id: identity.id,
              name: identity.username,
              uid: input.area === "freeipa" ? (identity.posix?.uidNumber ?? null) : null,
              gid: input.area === "freeipa" ? (identity.posix?.primaryGidNumber ?? null) : null,
            }
          : { id: identity.id, name: identity.name, uid: null, gid: identity.gidNumber },
      );
      const root = deps.connect(config).root(item.root);
      const result = await inspect(root, item, await root.info(), true);
      if (result.summary.status !== "existing") throw new FilesError(result.summary.reason ?? "binding_conflict", 409);
      return result.summary;
    },
  };
}
export const filesService = createFilesService();
