import { createHash } from "node:crypto";
import { type Principal, type RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import {
  type AccountIdentityGroup,
  type AccountIdentityPage,
  type AccountIdentityUser,
  accountIdentities,
  accounts,
  coreSettings,
} from "@k2b/cloud/services";
import { publicCloudOrigin } from "@k2b/cloud/shared";
import {
  type ExecutionContext,
  type ExecutionIdentity,
  Filegate,
  FilegateError,
  type Node,
  type RootClient,
  type RootInfo,
} from "@k2b/filegate";
import { z } from "zod";
import { readBoundedBody } from "../bounded-body";
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
  SearchResult,
  UploadLease,
  UploadSession,
} from "../contracts";
import { type Binding, bindings, type NewBinding } from "../data/bases";
import { favorites, recent } from "../data/marks";
import { operations, withRootLock, withUploadLock } from "../data/operations";
import { persistedEntryRefId, resolveEntryRefId } from "../data/references";
import { sameUploadExecution, sameUploadOptions, type Upload, uploadSessionId, uploads } from "../data/uploads";
import { isMarkdown, MARKDOWN_LIMIT, markdownRevision, TEMPLATE_LIMIT } from "../document-assets";
import { type DocumentKind, documentExtension, editableExtension } from "../documents";
import { normalizeSelection, runFileBatch } from "./batches";
import { type BrowseInput, browsePage } from "./browsing";
import { discoverEditor, signEditorToken, verifyEditorToken, wopiTimestamp } from "./collabora";
import { readConfiguration, writeConfiguration } from "./configuration";
import { documentTemplate } from "./document-template";
import { FilesError } from "./errors";
import { createDirectoryLifecycle } from "./lifecycle";
import { joinPath, relativePath, userPath, validateConfiguration } from "./paths";
import { permits, type UnixIdentity } from "./posix";
import { rootSummary } from "./root-summary";
import { createSharingService } from "./sharing";
import { uploadStreamChunks } from "./stream-chunks";
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
  revision: node.revision,
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
    displayNames: resolveDisplayNames,
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
        transferBaseUrl: config.url,
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
      managed: info.managed,
      executionEnabled: info.execution,
    };
    const result = (status: BaseSummary["status"], reason: string | null, binding: Binding | null = null): Inspection => ({
      candidate: item,
      summary: {
        ...summary,
        status,
        reason,
        locationKey: createHash("sha256")
          .update(JSON.stringify([serverUrl, item.root, item.path, binding?.id]))
          .digest("hex"),
      },
      binding,
    });
    if (item.area === "freeipa" && !info.execution) return result("unknown", "execution_disabled");
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
    // Personal Linux groups are not offered as group areas; links that already name such a base keep working.
    const personalGroupIds = new Set(groups.filter((group) => group.personal).map((group) => group.id));
    return { self, config, unix, candidates, personalGroupIds };
  }
  async function checkUnix(root: RootClient, path: string, unix: UnixIdentity | null, leafRights: number) {
    if (!unix) throw new FilesError("identity_incomplete", 403);
    // Every caller supplies an execution-scoped root. Filegate's kernel path resolution checks ancestor x bits;
    // metadata access does not require leaf read/write rights, so the requested leaf permission remains explicit.
    try {
      const node = await root.stat(path);
      const acl = await root.getACL(path, "access");
      if (!permits(node, acl, unix, leafRights)) throw new FilesError("forbidden", 403);
    } catch (error) {
      if (error instanceof FilegateError && error.status === 403) throw new FilesError("forbidden", 403);
      throw error;
    }
  }
  async function authorized(
    actor: RequestActor,
    baseId: string,
    path: string,
    directory?: boolean,
    snapshot?: Awaited<ReturnType<typeof context>>,
  ) {
    const state = snapshot ?? (await context(actor));
    const item = state.candidates.find((candidate) => `${candidate.area}:${candidate.kind}:${candidate.identity_id}` === baseId);
    if (!item) throw new FilesError("not_found", 404);
    const issue = issueFor(state.config, item.area, state.self.availability);
    if (issue) throw new FilesError(issue, 403);
    const client = deps.connect(state.config);
    let root = client.root(item.root);
    const info = await root.info();
    let inspection = await inspect(root, item, info, state.config.url);
    if (inspection.summary.status === "missing" && item.area === "cloud" && state.config.cloud.autoCreate) {
      await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
      inspection = await inspect(root, item, info, state.config.url);
    }
    if (inspection.summary.status !== "existing") throw new FilesError(inspection.summary.reason ?? "forbidden", 403);
    const execution = executionFor({ inspection, state });
    if (execution) root = root.as(execution);
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
  function executionFor(current: { inspection: Inspection; state: Awaited<ReturnType<typeof context>> }): ExecutionIdentity | null {
    if (current.inspection.candidate.area !== "freeipa") return null;
    const { unix, self } = current.state;
    if (!unix || !self.user.posix || unix.uid === 0) throw new FilesError("identity_incomplete", 403);
    const groups = [...unix.gids].filter((gid) => gid !== self.user.posix!.primaryGidNumber).sort((a, b) => a - b);
    if (groups.length > 64) throw new FilesError("identity_incomplete", 403);
    return { uid: unix.uid, gid: self.user.posix.primaryGidNumber, groups };
  }
  function targetExecution(current: Parameters<typeof executionFor>[0]): ExecutionContext {
    const identity = executionFor(current);
    return identity ? { mode: "unix", identity } : { mode: "service" };
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
  async function folderReadme(current: Awaited<ReturnType<typeof authorized>>): Promise<FileEntry | null> {
    const candidates: Node[] = [];
    let after: string | undefined;
    let pages = 0;
    do {
      const page = await current.root
        .list(current.target, { type: "files", sort: "name", order: "asc", limit: 1000, maxEntries: SEARCH_SCAN_LIMIT, after })
        .catch((error) => {
          if (error instanceof FilegateError && error.code === "limit_exceeded") return null;
          throw error;
        });
      if (!page) return null;
      for (const node of page.items) {
        const name = node.path.slice(current.target.length + 1);
        if (node.path.startsWith(`${current.target}/`) && !node.directory && name.toLowerCase() === "readme.md") candidates.push(node);
      }
      pages++;
      after = page.next ?? undefined;
    } while (after && pages < Math.ceil(SEARCH_SCAN_LIMIT / 1000));
    // Never choose from an incomplete observation.
    if (after) return null;
    const rank = (node: Node) => (node.path.split("/").at(-1) === "README.md" ? 0 : node.path.split("/").at(-1) === "readme.md" ? 1 : 2);
    candidates.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const node of candidates) {
      try {
        const actions = await entryActions(current, node, node.path);
        if (actions.share) return { ...fileEntry(node.path.slice(current.inspection.candidate.path.length + 1), node), actions };
      } catch (error) {
        if (!(error instanceof FilegateError && [403, 404].includes(error.status))) throw error;
      }
    }
    return null;
  }
  async function entryActions(
    current: Awaited<ReturnType<typeof authorized>>,
    node = current.node,
    target = current.target,
    parentWritable?: boolean,
  ): Promise<NonNullable<FileEntry["actions"]>> {
    if (current.inspection.candidate.area !== "freeipa") return { write: true, move: true, share: true };
    const acl = await current.root.getACL(target, "access");
    const readable = permits(node, acl, current.state.unix!, node.directory ? 5 : 4);
    let move = parentWritable;
    if (move === undefined) {
      const parent = target.split("/").slice(0, -1).join("/") || ".";
      move = permits(await current.root.stat(parent), await current.root.getACL(parent, "access"), current.state.unix!, 3);
    }
    return {
      write: readable && move && permits(node, acl, current.state.unix!, node.directory ? 3 : 2),
      move: readable && move,
      share: readable,
    };
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
  const versionEntry = (version: {
    id: string;
    created: string;
    size: number;
    pinned: boolean;
    metadata?: Record<string, unknown>;
  }): FileVersion => ({
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
  /** Whole-document writes from Cloud: a direct lease, one PUT, and the resulting node. */
  async function writeBytes(
    current: Awaited<ReturnType<typeof authorized>> & { target: string },
    body: Blob,
    onConflict: "error" | "overwrite",
  ): Promise<Node> {
    if (current.info.managed && onConflict === "overwrite" && !current.node.revision) throw new FilesError("write_conflict", 409);
    if (body.size > current.info.available) throw new FilesError("insufficient_space", 409);
    return current.root.put(
      current.target,
      body,
      {
        onConflict,
        ownership: onConflict === "error" ? ownershipFor(current, false) : undefined,
        precondition: current.info.managed
          ? onConflict === "error"
            ? { ifNoneMatch: true }
            : { ifMatch: current.node.revision! }
          : undefined,
      },
      AbortSignal.timeout(EDITOR_TRANSFER_TIMEOUT_MS),
    );
  }

  // Reuse the lifecycle lock: no expiry, no per-process mutex, and the same root
  // cannot be archived/trashed while a document publication is in progress.
  async function publish<T>(root: string, run: () => Promise<T>): Promise<T> {
    try {
      return await withRootLock(root, run);
    } catch (error) {
      if (error instanceof Error && error.message === "operation_busy") throw new FilesError("operation_busy", 503);
      throw error;
    }
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
  async function markedEntries(
    actor: RequestActor,
    rows: { base_id: string; path: string; name: string; directory: boolean; marked_at: Date }[],
  ): Promise<MarkedEntry[]> {
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
        output.push({
          base: { id, name: item.name, kind: item.kind, area: item.area },
          entry: fileEntry(current.relative, current.node),
          markedAt: row.marked_at.toISOString(),
        });
      } catch (error) {
        if (
          (error instanceof FilesError && [403, 404, 409].includes(error.status)) ||
          (error instanceof FilegateError && [403, 404].includes(error.status))
        )
          continue;
        throw error;
      }
    }
    return output;
  }
  const rememberOpened = (current: Awaited<ReturnType<typeof authorized>>) =>
    recent
      .touch({
        user_id: current.state.self.user.id,
        base_id: current.inspection.binding!.id,
        path: current.relative,
        name: current.relative.split("/").at(-1)!,
        directory: current.node.directory,
      })
      .catch(() => {});
  const forgetMarks = async (current: { state: { self: { user: { id: string } } }; inspection: Inspection }, relative: string) => {
    const binding = current.inspection.binding;
    if (!binding) return;
    await Promise.all([
      recent.forget(current.state.self.user.id, binding.id, relative),
      favorites.remove(current.state.self.user.id, binding.id, relative),
    ]).catch(() => {});
  };
  const UPLOAD_LEASE_SECONDS = 300;
  const UPLOAD_RECOVERY_MS = 7 * 24 * 60 * 60 * 1000;
  function uploadResult(
    current: Awaited<ReturnType<typeof writableParent>>,
    row: Awaited<ReturnType<typeof uploads.get>> & object,
    node: Node,
  ): FileEntry {
    // Private uploads never rename on conflict: a receipt must describe exactly the authorized target.
    if (node.root !== row.root || node.directory || node.size !== row.size || node.path !== joinPath(current.target, current.name))
      throw new FilesError("upload_changed", 409);
    relativePath(node.path, false);
    return fileEntry([...row.path.split("/").slice(0, -1), node.path.split("/").at(-1)!].join("/"), node);
  }
  function checkUploadSession(
    current: Awaited<ReturnType<typeof writableParent>>,
    row: Awaited<ReturnType<typeof uploads.get>> & object,
    session: Awaited<ReturnType<RootClient["session"]>>,
  ) {
    if (
      session.id !== uploadSessionId(row) ||
      session.root !== row.root ||
      session.path !== joinPath(current.target, current.name) ||
      session.size !== row.size ||
      !sameUploadOptions(session.options, row.write_options) ||
      !sameUploadExecution(session.execution ?? null, row.execution)
    )
      throw new FilesError("upload_changed", 409);
    if (session.result) uploadResult(current, row, session.result);
  }
  /** A commit whose response was lost is recognised from Filegate's session record; repeats are idempotent. */
  async function commitSession(
    current: Awaited<ReturnType<typeof writableParent>>,
    row: Awaited<ReturnType<typeof uploads.get>> & object,
    signal?: AbortSignal,
  ): Promise<FileEntry> {
    const { root } = current;
    if (row.state === "committed" && row.result) return uploadResult(current, row, row.result);
    if (row.state === "aborted" || row.state === "expired") throw new FilesError("upload_closed", 409);
    const sessionId = uploadSessionId(row);
    if (!sessionId) throw new FilesError("receipt_unknown", 409);
    const session = await privateReceipt(root, row, sessionId);
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
    if (row.expected_revision) {
      const node = await root.stat(joinPath(current.target, current.name));
      if (markdownRevision(node) !== row.expected_revision) throw new FilesError("write_conflict", 409);
    }
    if (session.received !== session.size) throw new FilesError("upload_incomplete");
    signal?.throwIfAborted();
    const node = await root.commitSession(sessionId);
    const result = uploadResult(current, row, node);
    await uploads.finish(row.id, "committed", node);
    return result;
  }
  /** Sessions are bound to the user that opened them; commit re-checks the target before Filegate publishes. */
  async function uploadRow(actor: RequestActor, baseId: string, id: string) {
    const state = await context(actor);
    let row = await uploads.get(id, state.self.user.id);
    if (!row || row.share_id) throw new FilesError("not_found", 404);
    const current = await writableParent(actor, baseId, row.path);
    if (current.inspection.binding?.id !== row.base_id || current.root.name !== row.root) throw new FilesError("not_found", 404);
    if (row.server_url !== current.state.config.url) throw new FilesError("configuration_changed", 409);
    if (!sameUploadExecution(row.execution, executionFor(current))) throw new FilesError("upload_changed", 409);
    await checkUploadTarget(current);
    if (row.state === "open" && !uploadSessionId(row)) row = await ensureUploadSession(current, row);
    return { row, current };
  }
  async function privateReceipt(root: RootClient, row: Upload, sessionId: string) {
    try {
      return await root.session(sessionId);
    } catch (error) {
      if (!(error instanceof FilegateError && error.status === 404)) throw error;
      await uploads.unresolved(row.id);
      throw new FilesError("receipt_unknown", 409);
    }
  }
  async function ensureUploadSession(current: Awaited<ReturnType<typeof writableParent>>, row: Upload): Promise<Upload> {
    if (!uploadSessionId(row)) {
      // Filegate retains creation keys for seven days. Never recreate an ambiguous old transfer after GC.
      if (Date.now() - row.created_at.getTime() >= UPLOAD_RECOVERY_MS || !row.write_options) throw new FilesError("receipt_unknown", 409);
      const created = await current.root.createSession(joinPath(current.target, current.name), row.size, {
        ...row.write_options,
        idempotencyKey: row.id,
        expiresIn: UPLOAD_LEASE_SECONDS,
        allowAbort: true,
      });
      checkUploadSession(current, { ...row, filegate_session_id: created.session.id }, created.session);
      await uploads.attachSession(row.id, created.session);
      row = { ...row, filegate_session_id: created.session.id };
    }
    return row;
  }
  async function openUpload(current: Awaited<ReturnType<typeof writableParent>>, row: Upload): Promise<UploadSession> {
    if (row.state !== "open")
      return {
        id: row.id,
        path: row.path,
        size: row.size,
        chunkSize: 0,
        state: row.state,
        expires: row.expires_at?.toISOString() ?? row.created_at.toISOString(),
      };
    row = await ensureUploadSession(current, row);
    const sessionId = uploadSessionId(row);
    if (!sessionId) throw new FilesError("receipt_unknown", 409);
    // A known missing receipt remains unknown; it is never a reason to create a new session.
    const session = await privateReceipt(current.root, row, sessionId);
    checkUploadSession(current, row, session);
    if (session.state !== "open") {
      if (session.state === "committed" && !session.result) throw new FilesError("upload_changed", 409);
      await uploads.finish(row.id, session.state, session.result ?? null);
      return { id: row.id, path: row.path, size: row.size, chunkSize: session.chunkSize, state: session.state, expires: session.expires };
    }
    const lease = await current.root.sessionLease(sessionId, { expiresIn: UPLOAD_LEASE_SECONDS, allowAbort: true });
    return {
      id: row.id,
      path: row.path,
      size: row.size,
      chunkSize: session.chunkSize,
      state: "open",
      url: lease.url,
      expires: lease.expires,
    };
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
    authorized,
    writableParent,
    executionFor,
    requireAdmin,
    ownershipFor,
    validateUploadTarget: (current, path) => checkUploadTarget({ ...current, relative: path, name: path.split("/").at(-1)! }),
    actorUserId: async (actor) => (await deps.identities.self(actor)).user.id,
    creatorActor: async (id) => {
      const user = await deps.userById(id);
      if (!user) throw new FilesError("not_found", 404);
      const actor: RequestActor = { kind: "user", user };
      await deps.identities.self(actor);
      return actor;
    },
    bindings: deps.bindings,
    readConfiguration: deps.readConfiguration,
    connect: deps.connect,
    publicOrigin: deps.publicOrigin,
  });
  const trashLifecycle = createTrashLifecycle(async (actor, baseId, path, access) => {
    const current =
      access === "move"
        ? await movable(actor, baseId, path)
        : access === "write-parent"
          ? await writableParent(actor, baseId, path)
          : await authorized(actor, baseId, path);
    const { candidate, binding } = current.inspection;
    return {
      root: current.root,
      rootName: candidate.root,
      serverUrl: current.state.config.url,
      basePath: candidate.path,
      bindingId: binding!.id,
      userId: current.state.self.user.id,
      base: current.inspection.summary,
      relative: current.relative,
      node: current.node,
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
        // An area the operator switched off is not a failure; only enabled areas report issues to users.
        if (!state.config[area].enabled) continue;
        // Candidates follow the account provider; an area without any is not this user's storage and stays silent.
        const items = state.candidates.filter(
          (item) => item.area === area && !(item.kind === "groups" && state.personalGroupIds.has(item.identity_id)),
        );
        if (!items.length) continue;
        const issue = issueFor(state.config, area, state.self.availability);
        if (issue) {
          output.issues.push({ area, code: issue });
          continue;
        }
        try {
          const root = deps.connect(state.config).root(state.config[area].root);
          const info = await root.info();
          for (const item of items) {
            let entry = await inspect(root, item, info, state.config.url);
            if (entry.summary.status === "missing" && area === "cloud" && state.config.cloud.autoCreate) {
              await provisionCandidate(state.config, item, state.self.user.id, state.self.user.username);
              entry = await inspect(root, item, info, state.config.url);
            }
            if (entry.summary.status === "existing" && area === "freeipa") {
              try {
                const execution = executionFor({ inspection: entry, state });
                if (!execution) throw new FilesError("identity_incomplete", 403);
                await checkUnix(root.as(execution), item.path, state.unix, 5);
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
    async list(actor: RequestActor, input: { baseId: string; path?: string } & BrowseInput): Promise<DirectoryResult> {
      const current = await authorized(actor, input.baseId, input.path ?? "", true);
      const page = await browsePage(input, JSON.stringify([current.inspection.summary.locationKey, current.target]), (options) =>
        current.root.list(current.target, { ...options, maxEntries: SEARCH_SCAN_LIMIT }),
      );
      const items: DirectoryResult["items"] = [];
      const create = await canWriteDirectory(current);
      for (const node of page.items) {
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (!node.path.startsWith(`${current.target}/`) || node.path.slice(current.target.length + 1).includes("/"))
          throw new FilesError("unavailable", 503);
        if (!relative || relative.split("/")[0] === "trash") continue;
        items.push({ ...fileEntry(relative, node), actions: await entryActions(current, node, node.path, create) });
      }
      return {
        base: current.inspection.summary,
        path: current.relative,
        items,
        next: page.next ?? null,
        actions: { create },
        readme: await folderReadme(current),
      };
    },
    async search(
      actor: RequestActor,
      input: { baseId: string; path?: string; q: string; scope?: "folder" | "tree" } & BrowseInput,
    ): Promise<SearchResult> {
      const current = await authorized(actor, input.baseId, input.path ?? "", true);
      let page: { items: Node[]; next: string | null };
      try {
        page = await browsePage(
          input,
          JSON.stringify([current.inspection.summary.locationKey, current.target, input.q, input.scope ?? "tree"]),
          (options) =>
            current.root.search(input.q, {
              ...options,
              path: current.target,
              maxEntries: SEARCH_SCAN_LIMIT,
            }),
        );
      } catch (error) {
        if (error instanceof FilegateError && error.status === 413) throw new FilesError("search_limited");
        throw error;
      }
      const items: FileEntry[] = [];
      for (const node of page.items) {
        if (!node.path.startsWith(`${current.target}/`)) continue;
        const relative = node.path.slice(current.inspection.candidate.path.length + 1);
        if (relative.split("/")[0] === "trash") continue;
        if (input.scope === "folder" && node.path.slice(current.target.length + 1).includes("/")) continue;
        const actions = await entryActions(current, node, node.path);
        if (current.inspection.candidate.area === "freeipa" && !actions.share) continue;
        items.push({ ...fileEntry(relative, node), actions });
      }
      return {
        base: current.inspection.summary,
        path: current.relative,
        query: input.q,
        scope: input.scope ?? "tree",
        items,
        next: page.next ?? null,
        readme: await folderReadme(current),
      };
    },
    async mkdir(actor: RequestActor, input: { baseId: string; path: string }): Promise<EntryResult> {
      const current = await writableParent(actor, input.baseId, input.path);
      const node = await current.root.mkdir(joinPath(current.target, current.name), { ownership: ownershipFor(current, true) });
      return { base: current.inspection.summary, entry: fileEntry(current.relative, node) };
    },
    async upload(
      actor: RequestActor,
      input: {
        baseId: string;
        path: string;
        size: number;
        onConflict: "error" | "overwrite";
        idempotencyKey: string;
        expectedRevision?: string;
      },
    ): Promise<UploadSession> {
      if (!Number.isSafeInteger(input.size) || input.size < 0) throw new FilesError("invalid_size");
      if (!z.string().uuid().safeParse(input.idempotencyKey).success) throw new FilesError("upload_changed", 409);
      const current = await writableParent(actor, input.baseId, input.path);
      const target = joinPath(current.target, current.name);
      const previous = await uploads.get(input.idempotencyKey, current.state.self.user.id);
      if (previous) {
        // A managed absent target is always create-only. Both conflict choices have the same effective intent.
        const onConflict = previous.write_options?.precondition?.ifNoneMatch ? "error" : input.onConflict;
        if (
          previous.expected_revision !== (input.expectedRevision ?? null) ||
          previous.share_id ||
          previous.base_id !== current.inspection.binding!.id ||
          previous.root !== current.root.name ||
          previous.server_url !== current.state.config.url ||
          previous.path !== current.relative ||
          previous.size !== input.size ||
          previous.write_options?.onConflict !== onConflict ||
          !sameUploadExecution(previous.execution, executionFor(current))
        )
          throw new FilesError("upload_changed", 409);
        await checkUploadTarget(current);
        return openUpload(current, previous);
      }
      // Filegate only detects name conflicts at commit; checking now avoids transferring bytes that cannot be published.
      let existing: Node | null = null;
      try {
        existing = await current.root.stat(target);
      } catch (error) {
        if (!(error instanceof FilegateError && error.status === 404)) throw error;
      }
      if (input.expectedRevision && (!existing || markdownRevision(existing) !== input.expectedRevision))
        throw new FilesError("write_conflict", 409);
      if (existing && input.onConflict === "error") throw new FilesError("path_conflict", 409);
      if (existing?.directory) throw new FilesError("not_file", 409);
      if (existing && current.inspection.candidate.area === "freeipa") await checkUnix(current.root, target, current.state.unix, 2);
      if (input.size > current.info.available) throw new FilesError("insufficient_space", 409);
      if (current.info.managed && existing && !existing.revision) throw new FilesError("upload_changed", 409);
      const writeOptions = {
        onConflict: current.info.managed && !existing ? ("error" as const) : input.onConflict,
        // Replacing keeps the file's owner and mode; only new files take the uploader's ownership.
        ownership: existing ? undefined : ownershipFor(current, false),
        precondition: current.info.managed ? (existing ? { ifMatch: existing.revision! } : { ifNoneMatch: true as const }) : undefined,
      };
      const row = await uploads.reservePrivate({
        id: input.idempotencyKey,
        base_id: current.inspection.binding!.id,
        user_id: current.state.self.user.id,
        root: current.inspection.candidate.root,
        server_url: current.state.config.url,
        path: current.relative,
        size: input.size,
        write_options: writeOptions,
        expected_revision: input.expectedRevision ?? null,
        execution: executionFor(current),
      });
      return openUpload(current, row);
    },
    async uploadLease(actor: RequestActor, input: { baseId: string; id: string }): Promise<UploadLease> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state !== "open") throw new FilesError("upload_closed", 409);
      const session = await openUpload(current, row);
      if (!session.url || session.state !== "open") throw new FilesError("upload_closed", 409);
      return { url: session.url, expires: session.expires };
    },
    async commitUpload(actor: RequestActor, input: { baseId: string; id: string }): Promise<EntryResult> {
      const { current } = await uploadRow(actor, input.baseId, input.id);
      return publish(current.root.name, async () => {
        const fresh = await uploadRow(actor, input.baseId, input.id);
        return { base: fresh.current.inspection.summary, entry: await commitSession(fresh.current, fresh.row) };
      });
    },
    async rename(actor: RequestActor, input: { baseId: string; path: string; name: string }): Promise<EntryResult> {
      const prepared = await movable(actor, input.baseId, input.path);
      return publish(prepared.root.name, async () => {
        const source = await movable(actor, input.baseId, input.path);
        const relative = userPath(joinPath(source.relative.split("/").slice(0, -1).join("/"), input.name));
        if (relative.split("/").length !== source.relative.split("/").length) throw new FilesError("invalid_path");
        const transferred = await source.root.transfer(
          source.target,
          source.inspection.candidate.root,
          joinPath(source.inspection.candidate.path, relative),
          {
            move: true,
            onConflict: "error",
          },
        );
        if (transferred.state !== "completed") throw new FilesError("operation_pending", 409);
        const node = transferred.node;
        if (!node || node.root !== source.root.name || !node.path.startsWith(`${source.inspection.candidate.path}/`))
          throw new FilesError("unavailable", 503);
        await forgetMarks(source, source.relative);
        return {
          base: source.inspection.summary,
          entry: fileEntry(userPath(node.path.slice(source.inspection.candidate.path.length + 1)), node),
        };
      });
    },
    async move(actor: RequestActor, input: { baseId: string; paths: string[]; folder: string }): Promise<EntriesResult> {
      const prepare = async (path: string) => {
        const source = await movable(actor, input.baseId, path);
        const destination = await writableParent(actor, input.baseId, joinPath(input.folder, source.name));
        if (
          source.state.config.url !== destination.state.config.url ||
          source.inspection.binding?.id !== destination.inspection.binding?.id
        )
          throw new FilesError("configuration_changed", 409);
        if (destination.target === source.target || destination.target.startsWith(`${source.target}/`))
          throw new FilesError("move_into_self", 409);
        return { source, destination };
      };
      const base = (await authorized(actor, input.baseId, input.folder, true)).inspection.summary;
      const result = await runFileBatch(input.paths, prepare, async (prepared, path) =>
        publish(prepared.source.root.name, async () => {
          const { source, destination } = await prepare(path);
          if (destination.relative === source.relative) return fileEntry(source.relative, source.node);
          const transferred = await source.root.transfer(source.target, source.root.name, joinPath(destination.target, source.name), {
            move: true,
            onConflict: "error",
          });
          if (transferred.state !== "completed") throw new FilesError("operation_pending", 409);
          const node = transferred.node;
          if (!node || node.root !== destination.root.name || !node.path.startsWith(`${destination.inspection.candidate.path}/`))
            throw new FilesError("unavailable", 503);
          await forgetMarks(source, source.relative);
          return fileEntry(userPath(node.path.slice(destination.inspection.candidate.path.length + 1)), node);
        }),
      );
      return { base, ...result };
    },
    // Copies may cross bases; moves never do.
    async copy(
      actor: RequestActor,
      input: { baseId: string; paths: string[]; targetBaseId: string; folder: string },
    ): Promise<EntriesResult> {
      const prepare = async (path: string) => {
        const source = await authorized(actor, input.baseId, path);
        const name = source.relative.split("/").at(-1)!;
        const destination = await writableParent(actor, input.targetBaseId, joinPath(input.folder, name));
        if (
          source.root.name === destination.root.name &&
          JSON.stringify(executionFor(source)) !== JSON.stringify(executionFor(destination))
        )
          throw new FilesError("configuration_changed", 409);
        if (source.state.config.url !== destination.state.config.url) throw new FilesError("configuration_changed", 409);
        if (
          source.root.name === destination.root.name &&
          (destination.target === source.target || destination.target.startsWith(`${source.target}/`))
        )
          throw new FilesError("move_into_self", 409);
        return { source, destination, name };
      };
      const base = (await authorized(actor, input.targetBaseId, input.folder, true)).inspection.summary;
      const result = await runFileBatch(input.paths, prepare, async (_, path) => {
        const { source, destination, name } = await prepare(path);
        const sameFolder = destination.target === source.target.slice(0, -(name.length + 1)) && input.targetBaseId === input.baseId;
        const transferred = await source.root.transfer(source.target, destination.root.name, joinPath(destination.target, name), {
          targetExecution: targetExecution(destination),
          move: false,
          onConflict: sameFolder ? "rename" : "error",
          ownership: { ...ownershipFor(destination, true), ...ownershipFor(destination, false) },
        });
        if (transferred.state !== "completed") throw new FilesError("operation_pending", 409);
        const node = transferred.node;
        if (!node || node.root !== destination.root.name || !node.path.startsWith(`${destination.inspection.candidate.path}/`))
          throw new FilesError("unavailable", 503);
        return fileEntry(userPath(node.path.slice(destination.inspection.candidate.path.length + 1)), node);
      });
      return { base, ...result };
    },
    async bundle(actor: RequestActor, input: { baseId: string; paths: string[] }): Promise<ArchiveDownload> {
      const state = await context(actor);
      let client = deps.connect(state.config);
      const items: { root: string; path: string; archivePath: string }[] = [];
      for (const path of normalizeSelection(input.paths)) {
        const current = await authorized(actor, input.baseId, path, undefined, state);
        const execution = executionFor(current);
        if (execution) client = deps.connect(state.config).as(execution);
        items.push({ root: current.inspection.candidate.root, path: current.target, archivePath: current.relative });
      }
      const lease = await client.archiveLease(items, 300);
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
      const metadata = {
        ...existing.metadata,
        comment: input.comment || undefined,
        author: input.comment ? current.state.self.user.username : undefined,
      };
      return versionEntry(await current.root.updateVersion(current.target, input.id, { pinned: existing.pinned, metadata }));
    },
    async restoreVersion(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<EntryResult> {
      const current = await versionFile(actor, input.baseId, input.path, true);
      return publish(current.root.name, async () => {
        const fresh = await versionFile(actor, input.baseId, input.path, true);
        const node = await fresh.root.restore(fresh.target, input.id);
        return { base: fresh.inspection.summary, entry: fileEntry(fresh.relative, node) };
      });
    },
    async restoreVersionAs(actor: RequestActor, input: { baseId: string; path: string; id: string; name: string }): Promise<EntryResult> {
      const current = await versionFile(actor, input.baseId, input.path, false);
      const relative = userPath(joinPath(current.relative.split("/").slice(0, -1).join("/"), input.name));
      if (relative.split("/").length !== current.relative.split("/").length || relative === current.relative)
        throw new FilesError("invalid_path");
      const destination = await writableParent(actor, input.baseId, relative);
      if (JSON.stringify(executionFor(current)) !== JSON.stringify(executionFor(destination)))
        throw new FilesError("configuration_changed", 409);
      if (
        current.state.config.url !== destination.state.config.url ||
        current.inspection.binding?.id !== destination.inspection.binding?.id
      )
        throw new FilesError("configuration_changed", 409);
      const node = await current.root.copyVersion(
        current.target,
        input.id,
        destination.root.name,
        joinPath(destination.target, destination.name),
        {
          onConflict: "error",
          ownership: ownershipFor(destination, false),
          targetExecution: targetExecution(destination),
        },
      );
      if (node.root !== destination.root.name || !node.path.startsWith(`${destination.inspection.candidate.path}/`))
        throw new FilesError("unavailable", 503);
      return {
        base: current.inspection.summary,
        entry: fileEntry(userPath(node.path.slice(destination.inspection.candidate.path.length + 1)), node),
      };
    },
    async deleteVersion(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<void> {
      await requireAdmin(actor);
      const current = await versionFile(actor, input.baseId, input.path, true);
      await current.root.deleteVersion(current.target, input.id);
    },
    async versionDownload(actor: RequestActor, input: { baseId: string; path: string; id: string }): Promise<DownloadLease> {
      const current = await versionFile(actor, input.baseId, input.path, false);
      const lease = await current.root.directVersionDownload(current.target, input.id, {
        expiresIn: 60,
        fileName: current.relative.split("/").at(-1)!,
      });
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async editor(actor: RequestActor, input: { baseId: string; path: string }): Promise<EditorLaunch> {
      if (isMarkdown(input.path)) {
        const current = await authorized(actor, input.baseId, input.path, false);
        if (current.node.directory) throw new FilesError("not_file");
        if (current.node.size > MARKDOWN_LIMIT) throw new FilesError("preview_too_large", 400);
        const actions = await entryActions(current, current.node, current.target);
        const lease = await current.root.directDownload(current.target, { expiresIn: 60 });
        return {
          kind: "markdown",
          managed: current.info.managed,
          base: current.inspection.summary,
          entry: fileEntry(current.relative, current.node),
          canWrite: actions.write,
          url: lease.url,
        };
      }

      const current = await editableFile(actor, input.baseId, input.path);
      const collabora = editorConfig(current.state.config);
      const action = await discoverEditor(
        {
          url: collabora.url,
          internalUrl: collabora.internalUrl,
          extension: current.extension,
          action: current.canWrite ? "edit" : "view",
        },
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
        managed: current.info.managed,
      };
    },
    /** Read a bounded independent catalog snapshot with the source actor's permissions. */
    async templateSource(actor: RequestActor, input: { baseId: string; path: string }) {
      const current = await authorized(actor, input.baseId, input.path, false);
      if (current.node.directory) throw new FilesError("not_file");
      if (current.node.size > TEMPLATE_LIMIT) throw new FilesError("preview_too_large", 400);
      const signal = AbortSignal.timeout(30_000);
      const bytes = await readBoundedBody(await current.root.contentRaw(current.target, signal), TEMPLATE_LIMIT, signal);
      return { bytes: new Uint8Array(bytes), filename: current.relative.split("/").at(-1)! };
    },
    async createFromBytes(
      actor: RequestActor,
      input: { baseId: string; path: string },
      bytes: Uint8Array<ArrayBuffer>,
    ): Promise<EntryResult> {
      if (bytes.byteLength > TEMPLATE_LIMIT) throw new FilesError("preview_too_large", 400);
      const current = await writableParent(actor, input.baseId, input.path);
      const target = joinPath(current.target, current.name);
      const node = await writeBytes({ ...current, target }, new Blob([bytes]), "error");
      return { base: current.inspection.summary, entry: fileEntry(current.relative, node) };
    },
    /** A new document starts in the administrator's format; the extension is appended here. */
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
      const node = await writeBytes({ ...current, target }, await documentTemplate(extension), "error");
      return { base: current.inspection.summary, entry: fileEntry(relative, node) };
    },
    async editorFileInfo(token: string, id: string) {
      const current = await wopiFile(token, id);
      const user = current.actor.user;
      const modified = wopiTimestamp(current.node.modified);
      if (!modified) throw new FilesError("unavailable", 503);
      return {
        BaseFileName: current.relative.split("/").at(-1)!,
        Size: current.node.size,
        OwnerId: current.inspection.summary.id,
        UserId: user.id,
        UserFriendlyName: user.displayName || user.uid,
        UserCanWrite: current.canWrite,
        UserCanNotWriteRelative: true,
        LastModifiedTime: modified,
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
    async editorSave(
      token: string,
      id: string,
      input: { read: () => Promise<Blob>; timestamp: string | null },
    ): Promise<{ modified: string } | { conflict: true }> {
      const current = await wopiFile(token, id);
      if (!current.canWrite) throw new FilesError("forbidden", 403);
      // Collabora deliberately omits the timestamp when the user confirms
      // "Overwrite". A present timestamp must retain its microsecond precision.
      const timestamp = wopiTimestamp(current.node.modified);
      if (!timestamp) throw new FilesError("unavailable", 503);
      if (input.timestamp !== null && wopiTimestamp(input.timestamp) !== timestamp) return { conflict: true };
      const body = await input.read();
      if (body.size > EDITOR_DOCUMENT_LIMIT) throw new FilesError("too_large", 400);
      return publish(current.root.name, async () => {
        const latest = await wopiFile(token, id);
        if (!latest.canWrite) throw new FilesError("forbidden", 403);
        if (
          latest.root.name !== current.root.name ||
          latest.target !== current.target ||
          latest.state.config.url !== current.state.config.url ||
          latest.node.modified !== current.node.modified ||
          markdownRevision(latest.node) !== markdownRevision(current.node)
        )
          return { conflict: true };
        try {
          const node = await writeBytes(latest, body, "overwrite");
          const modified = wopiTimestamp(node.modified);
          if (!modified) throw new FilesError("unavailable", 503);
          return { modified };
        } catch (error) {
          if ((error instanceof FilesError && error.code === "write_conflict") || (error instanceof FilegateError && error.status === 412))
            return { conflict: true };
          throw error;
        }
      });
    },
    async abortUpload(actor: RequestActor, input: { baseId: string; id: string }): Promise<void> {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state !== "open") return;
      const sessionId = uploadSessionId(row);
      if (!sessionId) throw new FilesError("receipt_unknown", 409);
      const before = await privateReceipt(current.root, row, sessionId);
      checkUploadSession(current, row, before);
      if (before.state !== "open") {
        if (before.state === "committed" && !before.result) throw new FilesError("upload_changed", 409);
        await uploads.finish(row.id, before.state, before.result ?? null);
        if (before.state === "committed") throw new FilesError("upload_closed", 409);
        return;
      }
      try {
        await current.root.abortSession(sessionId);
      } catch (error) {
        // An abort may race a commit. Only a retained terminal receipt proves the outcome.
        const receipt = await privateReceipt(current.root, row, sessionId);
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
      return {
        base: current.inspection.summary,
        entry: { ...fileEntry(current.relative, current.node), actions: await entryActions(current) },
        favorite,
        resourceId: await persistedEntryRefId(input.baseId, current.relative),
      };
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
      await favorites.add({
        user_id: self.user.id,
        base_id: current.inspection.binding!.id,
        path,
        name: path.split("/").at(-1)!,
        directory: current.node.directory,
      });
      return { favorite: true };
    },
    async thumbnail(actor: RequestActor, input: { baseId: string; path: string; size: "small" | "large" }): Promise<DownloadLease> {
      if (!input.path) throw new FilesError("invalid_path");
      const current = await authorized(actor, input.baseId, input.path, false);
      const dimension = input.size === "large" ? 1024 : 320;
      const lease = await current.root.directThumbnail(current.target, { width: dimension, height: dimension, expiresIn: 60 });
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async capabilityDownload(
      actor: RequestActor,
      input: { baseId: string; path: string; revision: string },
      signal: AbortSignal,
    ): Promise<Response> {
      const current = await authorized(actor, input.baseId, input.path, false);
      if (markdownRevision(current.node) !== input.revision) throw new FilesError("write_conflict", 409);
      const lease = await current.root.directDownload(current.target, { expiresIn: 60 });
      return deps.connect(current.state.config).downloadRaw(lease, signal);
    },
    async capabilityUploadStatus(actor: RequestActor, input: { baseId: string; id: string }) {
      const { row, current } = await uploadRow(actor, input.baseId, input.id);
      if (row.state === "committed" && row.result) return { state: "completed" as const, entry: uploadResult(current, row, row.result) };
      if (row.state === "aborted" || row.state === "expired") return { state: "aborted" as const };
      const sessionId = uploadSessionId(row);
      if (!sessionId) throw new FilesError("receipt_unknown", 409);
      const session = await privateReceipt(current.root, row, sessionId);
      checkUploadSession(current, row, session);
      if (session.state === "committed" && session.result)
        return { state: "completed" as const, entry: uploadResult(current, row, session.result) };
      if (session.state === "aborted" || session.state === "expired") return { state: "aborted" as const };
      return { state: "open" as const };
    },
    async capabilityUpload(
      actor: RequestActor,
      input: { baseId: string; id: string },
      body: ReadableStream<Uint8Array>,
      signal: AbortSignal,
    ): Promise<EntryResult> {
      return withUploadLock(input.id, async () => {
        signal.throwIfAborted();
        const { row, current } = await uploadRow(actor, input.baseId, input.id);
        const session = await openUpload(current, row);
        if (session.state !== "open") {
          await body.cancel();
          if (session.state !== "committed") throw new FilesError("upload_closed", 409);
          const committed = row.result ?? (await privateReceipt(current.root, row, uploadSessionId(row)!)).result;
          if (!committed) throw new FilesError("receipt_unknown", 409);
          return { base: current.inspection.summary, entry: uploadResult(current, row, committed) };
        }
        if (!session.url) throw new FilesError("receipt_unknown", 409);
        const direct = deps
          .connect(current.state.config)
          .directSession({ url: session.url, expires: session.expires, operations: ["write"] });
        await uploadStreamChunks(body, row.size, session.chunkSize, (index, chunk) => direct.put(index, new Blob([chunk]), signal));
        signal.throwIfAborted();
        return publish(current.root.name, async () => {
          const fresh = await uploadRow(actor, input.baseId, input.id);
          return { base: fresh.current.inspection.summary, entry: await commitSession(fresh.current, fresh.row, signal) };
        });
      }).catch((error) => {
        if (error instanceof Error && error.message === "operation_busy") throw new FilesError("operation_busy", 409);
        throw error;
      });
    },
    async download(actor: RequestActor, input: { baseId: string; path: string }): Promise<DownloadLease> {
      if (!input.path) throw new FilesError("not_file");
      const current = await authorized(actor, input.baseId, input.path, false);
      void rememberOpened(current);
      const lease = await current.root.directDownload(current.target, { expiresIn: 60, fileName: current.relative.split("/").at(-1)! });
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
            const info = await root.info();
            if (area === "freeipa" && !info.execution) throw new FilesError("execution_disabled");
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
      // Display names are presentation only; one batched lookup per identity page keeps search on them cheap.
      const names = new Map<string, string>();
      const resolveNames = async (ids: string[]) => {
        const missing = [...new Set(ids)].filter((id) => !names.has(id));
        if (missing.length === 0) return;
        const principal = (id: string): Principal =>
          input.kind === "users" ? { type: "user", userId: id } : { type: "group", groupId: id };
        for (const resolved of await deps.displayNames(missing.map((id) => ({ id, principal: principal(id) }))))
          names.set(resolved.id, resolved.displayName);
      };
      const matchesSearch = (name: string, path: string, identityId: string | null) =>
        !input.q ||
        `${name} ${(identityId && names.get(identityId)) || ""} ${path}`.toLocaleLowerCase().includes(input.q.toLocaleLowerCase());
      const include = (item: InventoryEntry) => {
        if (input.status && item.status !== input.status) return;
        if (!matchesSearch(item.name, item.path, item.identityId)) return;
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
          displayName: null,
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
          const eligible = (identity: AccountIdentityUser | AccountIdentityGroup) =>
            !(("gidNumber" in identity && identity.gidNumber === null) || ("profile" in identity && identity.profile !== "user"));
          await resolveNames(page.items.filter(eligible).map((identity) => identity.id));
          for (const [index, identity] of page.items.entries()) {
            if (Date.now() >= deadline || output.items.length >= PAGE_SIZE) break;
            cursor = index === page.items.length - 1 ? (page.nextCursor ?? "fs:") : identity.id;
            if (!eligible(identity)) continue;
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
            if (!matchesSearch(item.name, item.path, item.identity_id)) continue;
            try {
              include(await entry(item.name, item.identity_id, item));
            } catch {
              include({
                area: input.area,
                kind: input.kind,
                identityId: item.identity_id,
                name: item.name,
                displayName: null,
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
            if (!matchesSearch(name, node.path, null)) {
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
      // Filesystem-only rows with an ineligible identity were not part of an identity page.
      await resolveNames(output.items.flatMap((item) => (item.identityId ? [item.identityId] : [])));
      for (const item of output.items) item.displayName = (item.identityId && names.get(item.identityId)) || null;
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
