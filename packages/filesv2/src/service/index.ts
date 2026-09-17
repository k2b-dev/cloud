import type { RequestActor } from "@k2b/cloud/server";
import { accountIdentities } from "@k2b/cloud/services";
import { Filegate, FilegateError, type Node, type RootClient, type RootInfo } from "@k2b/filegate";
import type {
  AdminResult,
  Area,
  Availability,
  BaseKind,
  BaseSummary,
  BasesResult,
  ConfigurationInput,
  DirectoryResult,
  DownloadLease,
  RootSummary,
} from "../contracts";
import { type Binding, bindings, type NewBinding } from "../data/bases";
import { readConfiguration, writeConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { joinPath, relativePath, userPath, validateConfiguration } from "./paths";
import { permits, type UnixIdentity } from "./posix";

export { FilesError } from "./errors";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Group = Awaited<ReturnType<typeof accountIdentities.groups>>["items"][number];
type Identity = { id: string; name: string; uid: number | null; gid: number | null };
type Candidate = NewBinding & { name: string };
type Inspection = { summary: BaseSummary; candidate: Candidate; binding: Binding | null };
const PAGE_SIZE = 50;
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
    if (existing.some((binding) => !sameBinding(binding, item))) return result("conflict", "binding_conflict");
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
  async function authorized(actor: RequestActor, baseId: string, path: string, directory: boolean) {
    const state = await context(actor);
    const item = state.candidates.find((candidate) => `${candidate.area}:${candidate.kind}:${candidate.identity_id}` === baseId);
    if (!item) throw new FilesError("not_found", 404);
    const issue = issueFor(state.config, item.area, state.self.availability);
    if (issue) throw new FilesError(issue, 403);
    const root = deps.connect(state.config).root(item.root);
    const info = await root.info();
    const inspection = await inspect(root, item, info);
    if (inspection.summary.status !== "existing") throw new FilesError(inspection.summary.reason ?? "forbidden", 403);
    const relative = userPath(path);
    const target = joinPath(item.path, relative);
    if (item.area === "freeipa") await checkUnix(root, target, state.unix, directory ? 5 : 4);
    const node = await root.stat(target);
    if (node.directory !== directory) throw new FilesError(directory ? "not_directory" : "not_file", 400);
    return { root, inspection, target, relative, state };
  }
  async function requireAdmin(actor: RequestActor) {
    // The public inventory contract performs the canonical admin check.
    await deps.identities.inventory(actor, { kind: "groups", provider: "local" });
    return deps.identities.self(actor);
  }
  return {
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
            const entry = await inspect(root, item, info);
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
        items.push({
          name: relative.split("/").at(-1)!,
          path: relative,
          directory: node.directory,
          size: node.size,
          modified: node.modified,
        });
      }
      return { base: current.inspection.summary, path: current.relative, items, next: page.next ?? null };
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
    async admin(actor: RequestActor, input: { area: Area; kind: BaseKind; after?: string }): Promise<AdminResult> {
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
      const after = input.after;
      if (!after?.startsWith("fs:")) {
        const page =
          input.kind === "users"
            ? await deps.identities.inventory(actor, { kind: "users", provider: areaProvider(input.area), after })
            : await deps.identities.inventory(actor, { kind: "groups", provider: areaProvider(input.area), after });
        for (const identity of page.items) {
          if (("gidNumber" in identity && identity.gidNumber === null) || ("profile" in identity && identity.profile !== "user")) continue;
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
          try {
            const inspected = await inspect(root, item, info);
            output.items.push({
              area: input.area,
              kind: input.kind,
              identityId: item.identity_id,
              name: item.name,
              path: item.path,
              status: inspected.summary.status,
              reason: inspected.summary.reason,
              canAdopt: input.area === "cloud" && inspected.summary.status === "unassigned",
            });
          } catch {
            output.items.push({
              area: input.area,
              kind: input.kind,
              identityId: item.identity_id,
              name: item.name,
              path: item.path,
              status: "unknown",
              reason: "unavailable",
              canAdopt: false,
            });
          }
        }
        output.next = page.nextCursor ?? "fs:";
        return output;
      }
      const parent = joinPath(config[input.area].prefix, input.kind === "users" ? config[input.area].homes : config[input.area].groups);
      try {
        const page = await root.list(parent, { limit: PAGE_SIZE, after: after.slice(3) || undefined });
        for (const node of page.items) {
          const binding = await deps.bindings.path(config[input.area].root, node.path);
          const name = node.path.split("/").at(-1)!;
          const known =
            input.kind === "users"
              ? await deps.identities.inventory(actor, { kind: "users", provider: areaProvider(input.area), name })
              : await deps.identities.inventory(actor, { kind: "groups", provider: areaProvider(input.area), name });
          if (known.items.length) {
            const current = known.items[0]!;
            if (("gidNumber" in current && current.gidNumber === null) || ("profile" in current && current.profile !== "user")) {
              output.items.push({
                area: input.area,
                kind: input.kind,
                identityId: current.id,
                name,
                path: node.path,
                status: "conflict",
                reason: "identity_ineligible",
                canAdopt: false,
              });
            }
            continue;
          }
          if (binding) {
            output.items.push({
              area: input.area,
              kind: input.kind,
              identityId: binding.identity_id,
              name,
              path: node.path,
              status: input.area === "freeipa" ? "unknown" : "unassigned",
              reason: "identity_missing",
              canAdopt: false,
            });
            continue;
          }
          output.items.push({
            area: input.area,
            kind: input.kind,
            identityId: null,
            name: node.path.split("/").at(-1)!,
            path: node.path,
            status: input.area === "freeipa" ? "unknown" : "unassigned",
            reason: "identity_unknown",
            canAdopt: false,
          });
        }
        output.next = page.next ? `fs:${page.next}` : null;
      } catch (error) {
        if (!(error instanceof FilegateError && error.status === 404)) output.issue = "unavailable";
      }
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
