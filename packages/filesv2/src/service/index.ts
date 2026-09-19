import { createHash } from "node:crypto";
import type { RequestActor } from "@k2b/cloud/server";
import { type AccountIdentityGroup, type AccountIdentityPage, type AccountIdentityUser, accountIdentities, accounts, coreSettings } from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import { Filegate, FilegateError, type Node, type RootClient, type RootInfo } from "@k2b/filegate";
import { z } from "zod";
import type {
  AdminResult,
  ArchiveDownload,
  Area,
  Availability,
  BaseKind,
  BaseSummary,
  BasesResult,
  ConfigurationInput,
  DirectoryResult,
  DownloadLease,
  EditorLaunch,
  EntriesResult,
  EntryResult,
  FileEntry,
  FileVersion,
  InventoryEntry,
  InventoryState,
  MarkedEntry,
  RootSummary,
  SearchResult,
  UploadLease,
  UploadSession,
} from "../contracts";
import { type Binding, bindings, type NewBinding } from "../data/bases";
import { favorites, recent } from "../data/marks";
import { operations } from "../data/operations";
import { persistedEntryRefId, resolveEntryRefId } from "../data/references";
import { uploads } from "../data/uploads";
import { type DocumentKind, documentExtension, editableExtension } from "../documents";
import { createPreviewResources } from "../preview-resource";
import { runFileBatch } from "./batches";
import { discoverEditor, signEditorToken, verifyEditorToken } from "./collabora";
import { readConfiguration, writeConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { createDirectoryLifecycle } from "./lifecycle";
import { joinPath, relativePath, userPath, validateConfiguration } from "./paths";
import { permits, type UnixIdentity } from "./posix";
import { createSharingService } from "./sharing";
import { createTrashLifecycle } from "./trash-lifecycle";

export { FilesError } from "./errors";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Group = Awaited<ReturnType<typeof accountIdentities.groups>>["items"][number];
type Identity = { id: string; name: string; uid: number | null; gid: number | null };
type Candidate = NewBinding & { name: string };
type Inspection = { summary: BaseSummary; candidate: Candidate; binding: Binding | null };
const PAGE_SIZE = 50;
/** Covers a tab left open overnight; every WOPI call re-checks permissions, the token only names user and file. */
const EDITOR_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
/** Collabora hands over whole documents; Cloud holds one in memory while forwarding it to Filegate. */
export const EDITOR_DOCUMENT_LIMIT = 256 * 1024 * 1024;
const EDITOR_TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;
/** Tree moves, recursive removes, index rebuilds and statistics walk whole roots. */
const SLOW_CALL_TIMEOUT_MS = 10 * 60 * 1000;
const PREVIEW_EXTENSIONS = new Set(["pdf"]);
const withWopiSrc = (action: string, wopiSrc: string) =>
  `${action}${action.endsWith("?") || action.endsWith("&") ? "" : action.includes("?") ? "&" : "?"}WOPISrc=${encodeURIComponent(wopiSrc)}`;
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
  z.string().max(8192).nullable(),
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
    publicOrigin: async () => publicCloudOrigin(await coreSettings.get<string>("app.url")),
    userById: (id: string) => accounts.users.get({ id }),
    /** Byte transfers between Filegate leases and Collabora; separate from the short-timeout API client. */
    transfer: fetch as typeof fetch,
    connect: (config: Config) =>
      new Filegate({
        baseUrl: config.url,
        token: config.token,
        fetch: Object.assign(
          // API calls get a short timeout; transfers and recursive removes may walk whole trees, byte streams bring their own signal.
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            const slow = init?.method === "DELETE" || /\/transfers(\?|$)/.test(url);
            return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(slow ? SLOW_CALL_TIMEOUT_MS : 10_000) });
          },
          { preconnect: fetch.preconnect },
        ),
      }),
  },
) {
  const { provisionCandidate, ...lifecycle } = createDirectoryLifecycle(deps);
  const preview = createPreviewResources();
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
  async function inspect(root: RootClient, item: Candidate, info: RootInfo, serverUrl: string, adopt = false): Promise<Inspection> {
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
      summary: { ...summary, status, reason, locationKey: createHash("sha256").update(JSON.stringify([serverUrl, item.root, item.path, binding?.id])).digest("hex") },
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
  async function authorized(actor: RequestActor, baseId: string, path: string, directory?: boolean, snapshot?: Awaited<ReturnType<typeof context>>) {
    const state = snapshot ?? await context(actor);
    const item = state.candidates.find((candidate) => `${candidate.area}:${candidate.kind}:${candidate.identity_id}` === baseId);
    if (!item) throw new FilesError("not_found", 404);
    const issue = issueFor(state.config, item.area, state.self.availability);
    if (issue) throw new FilesError(issue, 403);
    const root = deps.connect(state.config).root(item.root);
    const info = await root.info();
    let inspection = await inspect(root, item, info, state.config.url);
    if (inspection.summary.status === "missing" && item.area === "cloud" && state.config.cloud.autoCreate) {
      await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
      inspection = await inspect(root, item, info, state.config.url);
    }
    if (inspection.summary.status !== "existing") throw new FilesError(inspection.summary.reason ?? "forbidden", 403);
    const relative = userPath(path);
    const target = joinPath(item.path, relative);
    let node: Node;
    try {
      node = await root.stat(target);
    } catch (error) {
      // A missing leaf must not reveal itself to users who may not even traverse its parent.
      if (error instanceof FilegateError && error.status === 404 && item.area === "freeipa" && relative)
        await checkUnix(root, joinPath(item.path, relative.split("/").slice(0, -1).join("/")), state.unix, 1);
      throw error;
    }
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
  const ownershipFor = (current: { inspection: Inspection; state: { unix: UnixIdentity | null }; node: Node }, directory: boolean) => {
    const { candidate } = current.inspection;
    const mode = directory ? (candidate.kind === "groups" ? "2770" : "0700") : candidate.kind === "groups" ? "0660" : "0600";
    return candidate.area === "freeipa"
      ? { uid: current.state.unix!.uid, gid: current.node.gid, [directory ? "dirMode" : "mode"]: mode }
      : { [directory ? "dirMode" : "mode"]: mode };
  };
  async function canWriteDirectory(current: Awaited<ReturnType<typeof authorized>>) {
    if (current.inspection.candidate.area !== "freeipa") return true;
    return permits(current.node, await current.root.getACL(current.target, "access"), current.state.unix!, 3);
  }
  async function entryActions(current: Awaited<ReturnType<typeof authorized>>, node = current.node, target = current.target, parentWritable?: boolean): Promise<NonNullable<FileEntry["actions"]>> {
    if (current.inspection.candidate.area !== "freeipa") return { write: true, move: true, share: true };
    const acl = await current.root.getACL(target, "access");
    const readable = permits(node, acl, current.state.unix!, node.directory ? 5 : 4);
    let move = parentWritable;
    if (move === undefined) {
      const parent = target.split("/").slice(0, -1).join("/") || ".";
      move = permits(await current.root.stat(parent), await current.root.getACL(parent, "access"), current.state.unix!, 3);
    }
    return { write: readable && move && permits(node, acl, current.state.unix!, node.directory ? 3 : 2), move: readable && move, share: readable };
  }
  /** An existing entry the user may remove from its folder: readable itself, parent writable, never trash. */
  async function movable(actor: RequestActor, baseId: string, path: string) {
    const current = await authorized(actor, baseId, path);
    if (!current.relative) throw new FilesError("invalid_path");
    const parts = current.relative.split("/");
    const parentTarget = joinPath(current.inspection.candidate.path, parts.slice(0, -1).join("/"));
    if (current.inspection.candidate.area === "freeipa") await checkUnix(current.root, parentTarget, current.state.unix, 3);
    return { ...current, name: parts.at(-1)!, parentTarget };
  }
  const versionEntry = (version: { id: string; created: string; size: number; pinned: boolean; metadata?: Record<string, unknown> }): FileVersion => ({
    id: version.id,
    created: version.created,
    size: version.size,
    pinned: version.pinned,
    comment: typeof version.metadata?.comment === "string" ? version.metadata.comment : null,
    author: typeof version.metadata?.author === "string" ? version.metadata.author : null,
  });
  async function versionFile(actor: RequestActor, baseId: string, path: string, write: boolean) {
    const current = write ? await movable(actor, baseId, path) : await authorized(actor, baseId, path, false);
    if (current.node.directory) throw new FilesError("not_file");
    if (write && current.inspection.candidate.area === "freeipa") await checkUnix(current.root, current.target, current.state.unix, 2);
    if (!current.info.versioning.enabled) throw new FilesError("versioning_disabled");
    return current;
  }
  /** A file Collabora can open, with the write decision the editor and every WOPI call share. */
  async function editableFile(actor: RequestActor, baseId: string, path: string) {
    const current = await authorized(actor, baseId, path, false);
    const extension = editableExtension(current.relative.split("/").at(-1)!);
    if (!extension) throw new FilesError("editor_unsupported", 400);
    let canWrite = true;
    if (current.inspection.candidate.area === "freeipa") {
      const parentTarget = joinPath(current.inspection.candidate.path, current.relative.split("/").slice(0, -1).join("/"));
      try {
        await checkUnix(current.root, parentTarget, current.state.unix, 3);
        await checkUnix(current.root, current.target, current.state.unix, 2);
      } catch (error) {
        if (!(error instanceof FilesError && error.code === "forbidden")) throw error;
        canWrite = false;
      }
    }
    return { ...current, extension, canWrite };
  }
  /** Leases name Filegate's browser-facing address; Cloud itself always talks to Filegate at the configured backend URL. */
  const backendLease = (config: Config, url: string) => {
    const target = new URL(url);
    const backend = new URL(config.url);
    target.protocol = backend.protocol;
    target.host = backend.host;
    return target.href;
  };
  /** Whole-document writes from Cloud: a direct lease, one PUT, and the resulting node. */
  async function writeBytes(current: Awaited<ReturnType<typeof authorized>> & { target: string }, body: Blob, onConflict: "error" | "overwrite"): Promise<Node> {
    if (body.size > current.info.available) throw new FilesError("insufficient_space", 409);
    const capability = await current.root.directUpload(current.target, body.size, {
      onConflict,
      ownership: onConflict === "error" ? ownershipFor(current, false) : undefined,
    });
    const response = await deps.transfer(backendLease(current.state.config, capability.url), {
      method: "PUT",
      body,
      signal: AbortSignal.timeout(EDITOR_TRANSFER_TIMEOUT_MS),
    });
    if (!response.ok) throw new FilesError(response.status === 409 ? "path_conflict" : "unavailable", response.status === 409 ? 409 : 503);
    return current.root.stat(current.target);
  }
  /** Filegate builds archives as the daemon, so FreeIPA subtrees are checked here before any lease exists. */
  async function assertReadableTree(current: Awaited<ReturnType<typeof authorized>>) {
    if (current.inspection.candidate.area !== "freeipa" || !current.node.directory) return;
    let scanned = 0;
    const walk = async (path: string) => {
      let after: string | undefined;
      do {
        const page = await current.root.list(path, { after, limit: PAGE_SIZE });
        for (const node of page.items) {
          if (++scanned > SEARCH_SCAN_LIMIT) throw new FilesError("archive_limited", 409);
          const acl = await current.root.getACL(node.path, "access");
          if (!permits(node, acl, current.state.unix!, node.directory ? 5 : 4)) throw new FilesError("forbidden", 403);
          if (node.directory) await walk(node.path);
        }
        after = page.next ?? undefined;
      } while (after);
    };
    await walk(current.target);
  }
  const editorConfig = (config: Config) => {
    if (!config.collabora.url) throw new FilesError("editor_disabled", 403);
    return config.collabora;
  };
  /** WOPI calls carry only the editor token; user, file and rights are resolved fresh on every call. */
  async function wopiFile(token: string, id: string) {
    const payload = verifyEditorToken(token);
    const ref = await resolveEntryRefId(id);
    if (!payload || !ref || ref.baseId !== payload.baseId || ref.path !== payload.path) throw new FilesError("forbidden", 403);
    const user = await deps.userById(payload.userId);
    if (!user) throw new FilesError("forbidden", 403);
    const actor: RequestActor = { kind: "user", user };
    const current = await editableFile(actor, payload.baseId, payload.path);
    editorConfig(current.state.config);
    return { ...current, actor };
  }
  /** Pointers name a binding; only bases the user can still reach are returned, under their current name. */
  async function markedEntries(actor: RequestActor, rows: { base_id: string; path: string; name: string; directory: boolean; marked_at: Date }[]): Promise<MarkedEntry[]> {
    const state = await context(actor);
    const output: MarkedEntry[] = [];
    for (const row of rows) {
      const binding = await deps.bindings.byId(row.base_id);
      const item = binding && state.candidates.find((candidate) => sameBinding(binding, candidate));
      if (!item || !binding || binding.lifecycle !== "active") continue;
      const id = `${item.area}:${item.kind}:${item.identity_id}`;
      try {
        const current = await authorized(actor, id, row.path, undefined, state);
        if (current.inspection.binding?.id !== row.base_id) continue;
        output.push({ base: { id, name: item.name, area: item.area }, entry: fileEntry(current.relative, current.node), markedAt: row.marked_at.toISOString() });
      } catch (error) {
        if ((error instanceof FilesError && [403, 404, 409].includes(error.status)) || (error instanceof FilegateError && [403, 404].includes(error.status))) continue;
        throw error;
      }
    }
    return output;
  }
  const rememberOpened = (current: Awaited<ReturnType<typeof authorized>>) =>
    recent
      .touch({ user_id: current.state.self.user.id, base_id: current.inspection.binding!.id, path: current.relative, name: current.relative.split("/").at(-1)!, directory: current.node.directory })
      .catch(() => {});
  const forgetMarks = async (current: { state: { self: { user: { id: string } } }; inspection: Inspection }, relative: string) => {
    const binding = current.inspection.binding;
    if (!binding) return;
    await Promise.all([recent.forget(current.state.self.user.id, binding.id, relative), favorites.remove(current.state.self.user.id, binding.id, relative)]).catch(() => {});
  };
  const UPLOAD_LEASE_SECONDS = 300;
  function uploadResult(current: Awaited<ReturnType<typeof writableParent>>, row: Awaited<ReturnType<typeof uploads.get>> & object, node: Node): FileEntry {
    // Filegate may rename on conflict, but the result must remain in the authorized parent.
    if (node.root !== row.root || node.directory || node.size !== row.size || node.path.split("/").slice(0, -1).join("/") !== current.target) throw new FilesError("upload_changed", 409);
    relativePath(node.path, false);
    return fileEntry([...row.path.split("/").slice(0, -1), node.path.split("/").at(-1)!].join("/"), node);
  }
  function checkUploadSession(current: Awaited<ReturnType<typeof writableParent>>, row: Awaited<ReturnType<typeof uploads.get>> & object, session: Awaited<ReturnType<RootClient["session"]>>) {
    if (session.id !== row.id || session.root !== row.root || session.path !== joinPath(current.target, current.name) || session.size !== row.size) throw new FilesError("upload_changed", 409);
    if (session.result) uploadResult(current, row, session.result);
  }
  /** A commit whose response was lost is recognised from Filegate's session record; repeats are idempotent. */
  async function commitSession(current: Awaited<ReturnType<typeof writableParent>>, row: Awaited<ReturnType<typeof uploads.get>> & object): Promise<FileEntry> {
    const { root } = current;
    if (row.state === "committed" && row.result) return uploadResult(current, row, row.result);
    if (row.state === "aborted" || row.state === "expired") throw new FilesError("upload_closed", 409);
    const session = await root.session(row.id);
    checkUploadSession(current, row, session);
    if (session.state === "committed" && session.result) {
      const result = uploadResult(current, row, session.result);
      await uploads.finish(row.id, "committed", session.result);
      return result;
    }
    if (session.state === "aborted" || session.state === "expired") {
      await uploads.finish(row.id, session.state, null);
      throw new FilesError("upload_closed", 409);
    }
    if (session.state !== "open") throw new FilesError("upload_changed", 409);
    if (session.received !== session.size) throw new FilesError("upload_incomplete");
    const node = await root.commitSession(row.id);
    const result = uploadResult(current, row, node);
    await uploads.finish(row.id, "committed", node);
    return result;
  }
  /** Sessions are bound to the user that opened them; commit re-checks the target before Filegate publishes. */
  async function uploadRow(actor: RequestActor, baseId: string, id: string) {
    const state = await context(actor);
    const row = await uploads.get(id, state.self.user.id);
    if (!row) throw new FilesError("not_found", 404);
    const current = await writableParent(actor, baseId, row.path);
    if (current.inspection.binding?.id !== row.base_id || current.root.name !== row.root) throw new FilesError("not_found", 404);
    if (row.server_url !== current.state.config.url) throw new FilesError("configuration_changed", 409);
    await checkUploadTarget(current);
    return { row, current };
  }
  async function checkUploadTarget(current: Awaited<ReturnType<typeof writableParent>>) {
    // A file may have appeared or changed ownership since the session was opened.
    const target = joinPath(current.target, current.name);
    const existing = await current.root.stat(target).catch((error: unknown) => {
      if (error instanceof FilegateError && error.status === 404) return null;
      throw error;
    });
    if (existing?.directory) throw new FilesError("not_file", 409);
    if (existing && current.inspection.candidate.area === "freeipa") await checkUnix(current.root, target, current.state.unix, 2);
  }
  async function requireAdmin(actor: RequestActor) {
    // The public inventory contract performs the canonical admin check.
    await deps.identities.inventory(actor, { kind: "groups", provider: "local" });
    return deps.identities.self(actor);
  }
  const sharing = createSharingService<Awaited<ReturnType<typeof authorized>>>({
    authorized, writableParent, assertReadableTree, requireAdmin, ownershipFor,
    validateUploadTarget: (current, path) => checkUploadTarget({ ...current, relative: path, name: path.split("/").at(-1)! }),
    actorUserId: async (actor) => (await deps.identities.self(actor)).user.id,
    creatorActor: async (id) => {
      const user = await deps.userById(id);
      if (!user) throw new FilesError("not_found", 404);
      const actor: RequestActor = { kind: "user", user };
      await deps.identities.self(actor);
      return actor;
    },
    bindings: deps.bindings, readConfiguration: deps.readConfiguration, connect: deps.connect, publicOrigin: deps.publicOrigin,
  });
  const trashLifecycle = createTrashLifecycle(async (actor, baseId, path, access) => {
    const current = access === "move" ? await movable(actor, baseId, path)
      : access === "write-parent" ? await writableParent(actor, baseId, path)
      : await authorized(actor, baseId, path);
    const { candidate, binding } = current.inspection;
    return {
      root: current.root, rootName: candidate.root, serverUrl: current.state.config.url, basePath: candidate.path, bindingId: binding!.id,
      userId: current.state.self.user.id, base: current.inspection.summary, relative: current.relative, node: current.node,
      check: async (target, rights) => {
        if (candidate.area === "freeipa") await checkUnix(current.root, target, current.state.unix, rights);
      },
      ensureTrash: async () => {
        const target = joinPath(candidate.path, "trash");
        try {
          const node = await current.root.stat(candidate.path);
          await current.root.mkdir(target, { ownership: ownershipFor({ ...current, node }, true) });
        } catch (error) {
          if (!(error instanceof FilegateError && error.status === 409)) throw error;
          if (!(await current.root.stat(target)).directory) throw new FilesError("not_directory", 409);
        }
        if (candidate.area === "freeipa") await checkUnix(current.root, target, current.state.unix, 3);
      },
      forget: (relative) => forgetMarks(current, relative),
    };
  });
  return {
    ...lifecycle,
    ...sharing,
    ...trashLifecycle,
    async maintain(input: Parameters<typeof lifecycle.maintain>[0] = {}) {
      await sharing.reconcileInboxUploads(input);
      input.signal?.throwIfAborted();
      return lifecycle.maintain(input);
    },
    async bases(actor: RequestActor): Promise<BasesResult> {
      const state = await context(actor);
      const output: BasesResult = {
        items: [],
        issues: [],
        editor: state.config.collabora.url ? { documentFormat: state.config.collabora.documentFormat } : null,
      };
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
            let entry = await inspect(root, item, info, state.config.url);
            if (entry.summary.status === "missing" && area === "cloud" && state.config.cloud.autoCreate) {
              await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
              entry = await inspect(root, item, info, state.config.url);
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
      const create = await canWriteDirectory(current);
      for (const node of page.items) {
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (!node.path.startsWith(`${current.target}/`) || node.path.slice(current.target.length + 1).includes("/"))
          throw new FilesError("unavailable", 503);
        if (!relative || relative.split("/")[0] === "trash") continue;
        items.push({ ...fileEntry(relative, node), actions: await entryActions(current, node, node.path, create) });
      }
      return { base: current.inspection.summary, path: current.relative, items, next: page.next ?? null, actions: { create } };
    },
    async search(actor: RequestActor, input: { baseId: string; path?: string; q: string; after?: string; scope?: "folder" | "tree" }): Promise<SearchResult> {
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
            })().catch((error: unknown) => {
              if (error instanceof FilegateError && (error.status === 403 || error.status === 404)) return false;
              throw error;
            }),
          );
        return checked.get(key)!;
      };
      const items: FileEntry[] = [];
      for (const node of page.items) {
        if (!node.path.startsWith(`${current.target}/`)) continue;
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (relative.split("/")[0] === "trash") continue;
        if (input.scope === "folder" && node.path.slice(current.target.length + 1).includes("/")) continue;
        if (current.inspection.candidate.area === "freeipa") {
          const parts = node.path.slice(current.target.length + 1).split("/");
          let allowed = await readable(node.path, node.directory ? 5 : 4);
          for (let i = 1; allowed && i < parts.length; i++)
            allowed = await readable(`${current.target}/${parts.slice(0, i).join("/")}`, 1);
          if (!allowed) continue;
        }
        items.push({ ...fileEntry(relative, node), actions: await entryActions(current, node, node.path) });
      }
      return { base: current.inspection.summary, path: current.relative, query: input.q, scope: input.scope ?? "tree", items, next: page.next ?? null };
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
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new FilesError("invalid_size");
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
        // Replacing keeps the file's owner and mode; only new files take the uploader's ownership.
        ownership: existing ? undefined : ownershipFor(current, false),
        expiresIn: UPLOAD_LEASE_SECONDS,
        allowAbort: true,
      });
      await uploads.create({
        id: created.session.id,
        base_id: current.inspection.binding!.id,
        user_id: current.state.self.user.id,
        root: current.inspection.candidate.root,
        server_url: current.state.config.url,
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
      return { base: current.inspection.summary, entry: await commitSession(current, row) };
    },
    async rename(actor: RequestActor, input: { baseId: string; path: string; name: string }): Promise<EntryResult> {
      const source = await movable(actor, input.baseId, input.path);
      const relative = userPath(joinPath(source.relative.split("/").slice(0, -1).join("/"), input.name));
      if (relative.split("/").length !== source.relative.split("/").length) throw new FilesError("invalid_path");
      const node = await source.root.transfer(source.target, source.inspection.candidate.root, joinPath(source.inspection.candidate.path, relative), {
        move: true,
        onConflict: "error",
      });
      await forgetMarks(source, source.relative);
      return { base: source.inspection.summary, entry: fileEntry(relative, node) };
    },
    async move(actor: RequestActor, input: { baseId: string; paths: string[]; folder: string }): Promise<EntriesResult> {
      const prepare = async (path: string) => {
        const source = await movable(actor, input.baseId, path);
        const destination = await writableParent(actor, input.baseId, joinPath(input.folder, source.name));
        if (source.state.config.url !== destination.state.config.url || source.inspection.binding?.id !== destination.inspection.binding?.id) throw new FilesError("configuration_changed", 409);
        if (destination.target === source.target || destination.target.startsWith(`${source.target}/`)) throw new FilesError("move_into_self", 409);
        return { source, destination };
      };
      const base = (await authorized(actor, input.baseId, input.folder, true)).inspection.summary;
      const result = await runFileBatch(input.paths, prepare, async (_, path) => {
        const { source, destination } = await prepare(path);
        if (destination.relative === source.relative) return fileEntry(source.relative, source.node);
        const node = await source.root.transfer(source.target, source.root.name, joinPath(destination.target, source.name), { move: true, onConflict: "error" });
        await forgetMarks(source, source.relative);
        return fileEntry(destination.relative, node);
      });
      return { base, ...result };
    },
    // Copies may cross bases; moves never do.
    async copy(actor: RequestActor, input: { baseId: string; paths: string[]; targetBaseId: string; folder: string }): Promise<EntriesResult> {
      const prepare = async (path: string) => {
        const source = await authorized(actor, input.baseId, path);
        const name = source.relative.split("/").at(-1)!;
        const destination = await writableParent(actor, input.targetBaseId, joinPath(input.folder, name));
        if (source.state.config.url !== destination.state.config.url) throw new FilesError("configuration_changed", 409);
        if (source.root.name === destination.root.name && (destination.target === source.target || destination.target.startsWith(`${source.target}/`))) throw new FilesError("move_into_self", 409);
        await assertReadableTree(source);
        return { source, destination, name };
      };
      const base = (await authorized(actor, input.targetBaseId, input.folder, true)).inspection.summary;
      const result = await runFileBatch(input.paths, prepare, async (_, path) => {
        const { source, destination, name } = await prepare(path);
        const sameFolder = destination.target === source.target.slice(0, -(name.length + 1)) && input.targetBaseId === input.baseId;
        const node = await source.root.transfer(source.target, destination.root.name, joinPath(destination.target, name), {
          move: false, onConflict: sameFolder ? "rename" : "error", ownership: { ...ownershipFor(destination, true), ...ownershipFor(destination, false) },
        });
        return fileEntry(node.path.slice(destination.inspection.candidate.path.length + 1), node);
      });
      return { base, ...result };
    },
    async bundle(actor: RequestActor, input: { baseId: string; paths: string[] }): Promise<ArchiveDownload> {
      const state = await context(actor);
      const items: { root: string; path: string; archivePath: string }[] = [];
      for (const path of input.paths) {
        const current = await authorized(actor, input.baseId, path);
        await assertReadableTree(current);
        items.push({ root: current.inspection.candidate.root, path: current.target, archivePath: current.relative });
      }
      const lease = await deps.connect(state.config).archiveLease(items, 300);
      return { url: lease.url, method: "POST", expires: lease.expires, manifest: lease.manifest };
    },
    async versions(actor: RequestActor, input: { baseId: string; path: string }): Promise<FileVersion[]> {
      const current = await authorized(actor, input.baseId, input.path, false);
      if (!current.info.versioning.enabled) return [];
      return (await current.root.versions(current.target)).map(versionEntry);
    },
    async commentVersion(actor: RequestActor, input: { baseId: string; path: string; id: string; comment: string }): Promise<FileVersion> {
      const current = await versionFile(actor, input.baseId, input.path, true);
      const existing = (await current.root.versions(current.target)).find((version) => version.id === input.id);
      if (!existing) throw new FilesError("not_found", 404);
      const metadata = { ...existing.metadata, comment: input.comment || undefined, author: input.comment ? current.state.self.user.username : undefined };
      return versionEntry(await current.root.updateVersion(current.target, input.id, { pinned: existing.pinned, metadata }));
    },
    async restoreVersion(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<EntryResult> {
      const current = await versionFile(actor, input.baseId, input.path, true);
      const node = await current.root.restore(current.target, input.id);
      return { base: current.inspection.summary, entry: fileEntry(current.relative, node) };
    },
    /**
     * Filegate has no "restore a version to another path" yet. The file is snapshotted, restored, copied and put
     * back; every step is a native Filegate operation and no bytes pass through Cloud.
     */
    async restoreVersionAs(actor: RequestActor, input: { baseId: string; path: string; id: string; name: string }): Promise<EntryResult> {
      const current = await versionFile(actor, input.baseId, input.path, true);
      const relative = userPath(joinPath(current.relative.split("/").slice(0, -1).join("/"), input.name));
      if (relative.split("/").length !== current.relative.split("/").length || relative === current.relative) throw new FilesError("invalid_path");
      // The safety snapshot is pinned so retention cannot prune it; it is removed only once the file is back.
      const keep = await current.root.snapshot(current.target, { pinned: true, metadata: { reason: "restore-as-copy" } });
      try {
        await current.root.restore(current.target, input.id);
        const node = await current.root.transfer(current.target, current.inspection.candidate.root, joinPath(current.inspection.candidate.path, relative), {
          move: false,
          onConflict: "error",
          ownership: ownershipFor(current, false),
        });
        return { base: current.inspection.summary, entry: fileEntry(relative, node) };
      } finally {
        await current.root.restore(current.target, keep.id);
        await current.root.deleteVersion(current.target, keep.id).catch(() => {});
      }
    },
    async deleteVersion(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<void> {
      await requireAdmin(actor);
      const current = await versionFile(actor, input.baseId, input.path, true);
      await current.root.deleteVersion(current.target, input.id);
    },
    async versionDownload(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<DownloadLease> {
      const current = await versionFile(actor, input.baseId, input.path, false);
      const lease = await current.root.directVersionDownload(current.target, input.id, 60);
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async editor(actor: RequestActor, input: { baseId: string; path: string }): Promise<EditorLaunch> {
      const current = await editableFile(actor, input.baseId, input.path);
      const collabora = editorConfig(current.state.config);
      const action = await discoverEditor(
        { url: collabora.url, internalUrl: collabora.internalUrl, extension: current.extension, action: current.canWrite ? "edit" : "view" },
        deps.transfer,
      );
      const id = await persistedEntryRefId(input.baseId, current.relative);
      if (!id) throw new FilesError("invalid_path");
      void rememberOpened(current);
      const wopiSrc = `${collabora.wopiOrigin || (await deps.publicOrigin())}/api/filesv2/wopi/files/${id}`;
      const expiresAt = Date.now() + EDITOR_TOKEN_TTL_MS;
      return {
        base: current.inspection.summary,
        entry: fileEntry(current.relative, current.node),
        action: withWopiSrc(action, wopiSrc),
        token: signEditorToken({ userId: current.state.self.user.id, baseId: input.baseId, path: current.relative, expiresAt }),
        tokenTtl: expiresAt,
        canWrite: current.canWrite,
      };
    },
    /** A new document starts from an empty template in the administrator's format; the extension is appended here. */
    async createDocument(actor: RequestActor, input: { baseId: string; path: string; kind: DocumentKind }): Promise<EntryResult> {
      const current = await writableParent(actor, input.baseId, input.path);
      const extension = documentExtension(input.kind, editorConfig(current.state.config).documentFormat);
      const relative = `${current.relative}.${extension}`;
      const target = joinPath(current.target, `${current.name}.${extension}`);
      try {
        await current.root.stat(target);
        throw new FilesError("path_conflict", 409);
      } catch (error) {
        if (!(error instanceof FilegateError && error.status === 404)) throw error;
      }
      const template = Bun.file(new URL(`../templates/empty.${extension}`, import.meta.url));
      const node = await writeBytes({ ...current, target }, template, "error");
      return { base: current.inspection.summary, entry: fileEntry(relative, node) };
    },
    async editorFileInfo(token: string, id: string) {
      const current = await wopiFile(token, id);
      const user = current.actor.user;
      return {
        BaseFileName: current.relative.split("/").at(-1)!,
        Size: current.node.size,
        OwnerId: current.inspection.summary.id,
        UserId: user.id,
        UserFriendlyName: user.displayName || user.uid,
        UserCanWrite: current.canWrite,
        UserCanNotWriteRelative: true,
        LastModifiedTime: current.node.modified,
        PostMessageOrigin: await deps.publicOrigin(),
        EnableShare: false,
        HidePrintOption: true,
        HideExportOption: true,
        DisableAISettings: true,
        SupportsLocks: false,
        SupportsRename: false,
        EnableOwnerTermination: false,
      };
    },
    /** Bytes flow Filegate → Cloud → Collabora on the server side; the browser never sees a Filegate lease here. */
    async editorContent(token: string, id: string): Promise<Response> {
      const current = await wopiFile(token, id);
      const response = await current.root.contentRaw(current.target, AbortSignal.timeout(EDITOR_TRANSFER_TIMEOUT_MS));
      if (!response.ok || !response.body) throw new FilesError("unavailable", 503);
      return response;
    },
    /** Every save overwrites the file in place; Filegate's own versioning policy decides what becomes a version. */
    async editorSave(token: string, id: string, input: { read: () => Promise<Blob>; timestamp: string | null }): Promise<{ modified: string } | { conflict: true }> {
      const current = await wopiFile(token, id);
      if (!current.canWrite) throw new FilesError("forbidden", 403);
      if (input.timestamp && new Date(input.timestamp).getTime() !== new Date(current.node.modified).getTime()) return { conflict: true };
      // The body is read only for an authorized writer, so anonymous requests never buffer a document.
      const node = await writeBytes(current, await input.read(), "overwrite");
      return { modified: node.modified };
    },
    async abortUpload(actor: RequestActor, input: { baseId: string; id: string }): Promise<void> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state !== "open") return;
      try {
        await current.root.abortSession(row.id);
      } catch (error) {
        // An abort may race a commit. Only a retained terminal receipt proves the outcome.
        const receipt = await current.root.session(row.id);
        checkUploadSession(current, row, receipt);
        if (receipt.state === "committed" && receipt.result) {
          await uploads.finish(row.id, "committed", receipt.result);
          throw new FilesError("upload_closed", 409);
        }
        if (receipt.state !== "aborted" && receipt.state !== "expired") throw error;
        await uploads.finish(row.id, receipt.state, null);
        return;
      }
      await uploads.finish(row.id, "aborted", null);
    },
    async entry(actor: RequestActor, input: { baseId: string; path: string }): Promise<EntryResult> {
      if (!input.path) throw new FilesError("invalid_path");
      const current = await authorized(actor, input.baseId, input.path);
      const favorite = await favorites.has(current.state.self.user.id, current.inspection.binding!.id, current.relative);
      return { base: current.inspection.summary, entry: { ...fileEntry(current.relative, current.node), actions: await entryActions(current) }, favorite, resourceId: await persistedEntryRefId(input.baseId, current.relative) };
    },
    async recent(actor: RequestActor): Promise<MarkedEntry[]> {
      const self = await deps.identities.self(actor);
      return markedEntries(actor, await recent.list(self.user.id));
    },
    async favorites(actor: RequestActor): Promise<MarkedEntry[]> {
      const self = await deps.identities.self(actor);
      return markedEntries(actor, await favorites.list(self.user.id));
    },
    async setFavorite(actor: RequestActor, input: { baseId: string; path: string; favorite: boolean }): Promise<{ favorite: boolean }> {
      const self = await deps.identities.self(actor);
      const path = userPath(input.path);
      if (!path) throw new FilesError("invalid_path");
      if (!input.favorite) {
        // Removing one's own pointer needs no current access to the file or provider.
        const match = /^(cloud|freeipa):(users|groups):([0-9a-f-]{36})$/i.exec(input.baseId);
        if (!match) throw new FilesError("invalid_path");
        await favorites.removeByIdentity(self.user.id, match[1]!, match[2]!, match[3]!, path);
        return { favorite: false };
      }
      const current = await authorized(actor, input.baseId, path);
      await favorites.add({ user_id: self.user.id, base_id: current.inspection.binding!.id, path, name: path.split("/").at(-1)!, directory: current.node.directory });
      return { favorite: true };
    },
    /** First page of a PDF or office document as PNG through Collabora; nothing is stored beyond a small process cache. */
    async documentPreview(actor: RequestActor, input: { baseId: string; path: string }): Promise<ArrayBuffer> {
      const current = await authorized(actor, input.baseId, input.path, false);
      const collabora = editorConfig(current.state.config);
      const extension = current.relative.split(".").at(-1)?.toLowerCase() ?? "";
      if (!(editableExtension(current.relative) || PREVIEW_EXTENSIONS.has(extension))) throw new FilesError("preview_unsupported", 400);
      const converterUrl = `${(collabora.internalUrl || collabora.url).replace(/\/$/, "")}/cool/convert-to/png`;
      return preview({
        identity: { serverUrl: current.state.config.url, root: current.root.name, bindingId: current.inspection.binding!.id,
          basePath: current.inspection.candidate.path, path: current.relative, modified: current.node.modified, size: current.node.size, converterUrl },
        source: (signal) => current.root.contentRaw(current.target, signal),
        convert: (bytes, signal) => {
          const form = new FormData();
          form.set("data", new Blob([bytes]), current.relative.split("/").at(-1)!);
          return deps.transfer(converterUrl, { method: "POST", body: form, signal });
        },
      });
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
      void rememberOpened(current);
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
          const checked = await inspect(root, knownCandidate, info, config.url);
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
      // Nothing consumed before the deadline: hand the same position back instead of failing the page.
      if (cursor === undefined) {
        output.issue ??= "unavailable";
        cursor = input.after ?? "";
      }
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
      const result = await inspect(root, item, await root.info(), config.url, true);
      if (result.summary.status !== "existing") throw new FilesError(result.summary.reason ?? "binding_conflict", 409);
      return result.summary;
    },
  };
}
export const filesService = createFilesService();
