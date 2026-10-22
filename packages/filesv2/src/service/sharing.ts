import { randomBytes } from "node:crypto";
import type { RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { AccountIdentityError, audit } from "@k2b/cloud/services";
import { type ExecutionIdentity, FilegateError, type Node, type Ownership, type Session, type SessionCreated } from "@k2b/filegate";
import { sql, type TransactionSQL } from "bun";
import type { z } from "zod";
import type {
  ArchiveDownload,
  BaseSummary,
  CreateShareInputSchema,
  DownloadLease,
  PublicShare,
  SharePage,
  SharePageQuerySchema,
  ShareView,
  UploadLease,
  UploadSession,
} from "../contracts";
import { finishActivity, insertActivity } from "../data/activity";
import type { Binding, bindings, NewBinding } from "../data/bases";
import { recordShareAccess, type ShareAccessContext } from "../data/share-access";
import { type ShareRow, type ShareTarget, shares, shareTokenHash } from "../data/shares";
import { normalizeExecution, sameUploadExecution, sameUploadOptions, type Upload, uploadSessionId, uploads } from "../data/uploads";
import { type UserFilesCall, uploadAction, visitorCall } from "./activity";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import type { FilesFilegate, FilesRoot } from "./filegate-facade";
import { joinPath, relativePath, userPath } from "./paths";
import type { UnixIdentity } from "./posix";
import { hashSharePassword, requireSharePassword, unlockSharePassword } from "./share-password";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
export type SharingAccess = {
  root: FilesRoot;
  info: { stableIds?: boolean };
  node: Node;
  target: string;
  relative: string;
  inspection: { candidate: NewBinding & { name: string }; binding: Binding | null; summary: BaseSummary };
  state: { config: Config; unix: UnixIdentity | null; self: { user: { id: string; username: string } } };
};
export type SharingDependencies<T extends SharingAccess> = {
  /** Same current membership, traversal and leaf checks, without provisioning, adoption or observations. */
  readOnlyAuthorized(actor: RequestActor, baseId: string, path: string): Promise<T>;
  displayNames: typeof resolveDisplayNames;
  authorized(actor: RequestActor, baseId: string, path: string, directory?: boolean): Promise<T>;
  writableParent(actor: RequestActor, baseId: string, path: string): Promise<T>;
  executionFor(current: T): ExecutionIdentity | null;
  requireAdmin(actor: RequestActor): Promise<unknown>;
  actorUserId(actor: RequestActor): Promise<string>;
  creatorActor(id: string): Promise<RequestActor>;
  validateUploadTarget(current: T, path: string): Promise<void>;
  bindings: typeof bindings;
  readConfiguration: typeof readConfiguration;
  connect(config: Config): FilesFilegate;
  publicOrigin(): Promise<string>;
  ownershipFor(current: T, directory: boolean): Ownership;
};
const TTL = { "1d": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
export const shareState = (row: ShareRow): ShareView["state"] =>
  row.revoked_at ? "revoked" : row.expires_at && row.expires_at.getTime() <= Date.now() ? "expired" : "active";
const contains = (row: ShareRow, path: string) => row.items.some((item) => path === item || path.startsWith(`${item}/`));
const baseId = (binding: Binding) => `${binding.area}:${binding.kind}:${binding.identity_id}`;
const shareView = (row: ShareRow, binding: Binding | null, url: string | null = null): ShareView => ({
  id: row.id,
  passwordProtected: Boolean(row.password_hash),
  kind: row.kind,
  url,
  title: row.title,
  note: row.note,
  publicNote: row.public_note,
  base: { id: binding ? baseId(binding) : row.base_id, name: binding?.identity_name ?? row.base_path, kind: binding?.kind },
  scope: row.scope,
  items: row.items,
  createdBy: row.created_by_name,
  createdAt: row.created_at.toISOString(),
  expiresAt: row.expires_at?.toISOString() ?? null,
  state: shareState(row),
  accessCount: row.access_count,
  lastAccessedAt: row.last_accessed_at?.toISOString() ?? null,
  maxFileSize: row.max_file_size,
  maxTotalSize: row.max_total_size,
  showUploadNames: row.show_upload_names,
});

/** Postgres-only mutations commit their per-target history and security evidence together. */
async function recordShareActivity(tx: TransactionSQL, call: UserFilesCall, row: ShareRow, action: "share.create" | "share.revoke") {
  // Legacy rows retain their authoritative root/base_path/items, but never recorded server, ID or type.
  // The activity schema requires a boolean: false is a placeholder explicitly marked directory_unknown,
  // not evidence of a file. Do not inspect a now-hidden path or infer identity from a reused binding.
  const legacy = row.target_snapshots === null;
  const targets =
    row.target_snapshots ??
    (row.kind === "inbox" ? [row.scope] : row.items).map((path) => ({
      path: joinPath(row.base_path, path),
      directory: false,
      itemId: null,
    }));
  const batchId = targets.length > 1 ? Bun.randomUUIDv7() : null;
  for (const target of targets) {
    const id = await insertActivity(
      call,
      {
        action,
        serverUrl: row.server_url ?? "",
        root: row.root,
        baseId: row.base_id,
        itemId: target.itemId,
        directory: target.directory,
        name: target.path.split("/").at(-1) ?? "",
        pathBefore: target.path,
        shareId: row.id,
        batchId,
        ...(legacy ? { detail: { snapshot_unknown: true, directory_unknown: true, server_unknown: row.server_url === null } } : {}),
      },
      tx,
    );
    await finishActivity(tx, id, "done", async () => undefined);
  }
  const actor = call.actor.kind === "user" ? call.actor.user : call.actor.delegatedUser;
  await audit.record(
    {
      action: `filesv2.${action}`,
      outcome: "allowed",
      actor: { userId: actor?.id },
      target: { type: "filesv2.share", id: row.id },
      requestId: call.requestId,
      metadata: {
        via: call.via,
        calling_app: call.callingApp,
        origin: call.origin,
        invocation_id: call.invocationId,
        item_count: targets.length,
      },
    },
    tx,
  );
}

/** Public bearer links name a grant; the creator's current authority is checked before every new action. */
export function createSharingService<T extends SharingAccess>(deps: SharingDependencies<T>) {
  async function tokenShare(token: string, kind: ShareRow["kind"], access?: string) {
    const row = token.length >= 16 && token.length <= 256 ? await shares.byToken(token) : null;
    if (!row || row.kind !== kind) throw new FilesError("not_found", 404);
    await requireSharePassword(row, access);
    return row;
  }
  async function activeShare(token: string, kind: ShareRow["kind"], access?: string) {
    return activeRow(await tokenShare(token, kind, access));
  }
  async function activeRow(row: ShareRow) {
    const kind = row.kind;
    if (shareState(row) !== "active") throw new FilesError("not_found", 404);
    const binding = await deps.bindings.byId(row.base_id);
    if (!binding || binding.lifecycle !== "active" || binding.root !== row.root || binding.path !== row.base_path)
      throw new FilesError("not_found", 404);
    try {
      const actor = await deps.creatorActor(row.created_by);
      const current =
        kind === "inbox"
          ? await deps.writableParent(actor, baseId(binding), joinPath(row.scope, "placeholder"))
          : await deps.authorized(actor, baseId(binding), row.scope, true);
      if (
        current.inspection.binding?.id !== row.base_id ||
        current.inspection.candidate.path !== row.base_path ||
        current.inspection.candidate.root !== row.root
      )
        throw new FilesError("not_found", 404);
      return { row, binding, actor, current, root: current.root };
    } catch (error) {
      if (error instanceof AccountIdentityError) throw new FilesError("not_found", 404);
      if (error instanceof FilesError && error.status !== 503) throw new FilesError("not_found", 404);
      if (error instanceof FilegateError && [403, 404].includes(error.status)) throw new FilesError("not_found", 404);
      throw error;
    }
  }
  const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
  function uploadTarget(upload: Upload, share: ShareRow) {
    if (
      upload.share_id !== share.id ||
      upload.base_id !== share.base_id ||
      upload.root !== share.root ||
      !upload.path ||
      parentPath(upload.path) !== share.scope
    )
      throw new FilesError("upload_changed", 409);
    return joinPath(share.base_path, userPath(upload.path));
  }
  function validateSession(upload: Upload, share: ShareRow, session: Session) {
    if (session.state === "committed" && !session.result) throw new FilesError("upload_changed", 409);
    if (
      session.id !== uploadSessionId(upload) ||
      session.root !== upload.root ||
      session.size !== upload.size ||
      session.path !== uploadTarget(upload, share) ||
      (upload.write_options !== null && !sameUploadOptions(session.options, upload.write_options)) ||
      !sameUploadExecution(session.execution ?? null, upload.execution)
    )
      throw new FilesError("upload_changed", 409);
  }
  function published(upload: Upload, share: ShareRow, node: Node): { name: string; size: number } {
    if (
      node.root !== upload.root ||
      node.directory ||
      node.size !== upload.size ||
      parentPath(node.path) !== parentPath(uploadTarget(upload, share))
    )
      throw new FilesError("upload_changed", 409);
    try {
      relativePath(node.path, false);
    } catch {
      throw new FilesError("upload_changed", 409);
    }
    return { name: node.path.split("/").at(-1)!, size: node.size };
  }
  function validateActiveUpload(upload: Upload, share: ShareRow, current: T) {
    uploadTarget(upload, share);
    if (
      current.state.config.url !== upload.server_url ||
      current.root.name !== upload.root ||
      current.inspection.binding?.id !== upload.base_id ||
      current.target !== joinPath(share.base_path, share.scope) ||
      !sameUploadExecution(deps.executionFor(current), upload.execution) ||
      (upload.write_options !== null &&
        !sameUploadOptions(upload.write_options, {
          onConflict: "rename",
          ownership: deps.ownershipFor(current, false),
          metadata: upload.write_options.metadata,
        }))
    )
      throw new FilesError("upload_changed", 409);
  }
  const sessionRoot = (root: FilesRoot, upload: Upload) => (upload.execution ? root.as(upload.execution) : root);
  async function remember(upload: Upload, share: ShareRow, session: Session): Promise<Upload> {
    validateSession({ ...upload, filegate_session_id: uploadSessionId(upload) ?? session.id }, share, session);
    if (session.result) published(upload, share, session.result);
    await uploads.attachSession(upload.id, session);
    if (session.state === "committed" && session.result) await uploads.finish(upload.id, "committed", session.result);
    else if (session.state === "aborted" || session.state === "expired") await uploads.finish(upload.id, session.state, null);
    return (await uploads.getForShare(upload.id, upload.share_id!))!;
  }
  async function openReservation(upload: Upload, share: ShareRow, current: T): Promise<SessionCreated> {
    validateActiveUpload(upload, share, current);
    // A missing receipt must never turn into a second upload after Filegate discards its idempotency record.
    if (!upload.write_options || Date.now() - upload.created_at.getTime() >= 7 * 86_400_000) throw new FilesError("upload_uncertain", 409);
    await deps.validateUploadTarget(current, upload.path);
    const created = await uploadAction(upload.id, () =>
      current.root.createSession(uploadTarget(upload, share), upload.size, {
        ...upload.write_options,
        idempotencyKey: upload.id,
        expiresIn: 300,
        allowAbort: true,
      }),
    );
    await remember(upload, share, created.session);
    return created;
  }
  async function reconcile(root: FilesRoot, upload: Upload, config: Config): Promise<Upload> {
    await uploads.history(upload.id);
    if (upload.state !== "open") return upload;
    if (!upload.server_url || upload.server_url !== config.url) {
      await uploads.unresolved(upload.id, "storage_changed");
      return { ...upload, error_code: "storage_changed" };
    }
    try {
      const share = await shares.get(upload.share_id!);
      if (!share) throw new FilesError("upload_changed", 409);
      const id = uploadSessionId(upload);
      if (!id) {
        // Replaying create can still create a session, so it requires a currently active creator and grant.
        const active = await activeRow(share);
        await openReservation(upload, share, active.current);
        return (await uploads.getForShare(upload.id, share.id))!;
      }
      return await remember(upload, share, await sessionRoot(root, upload).session(id));
    } catch (error) {
      // A missing receipt proves neither failure nor success. Its quota remains reserved.
      await uploads.unresolved(upload.id);
      if (error instanceof FilesError && error.code === "upload_changed") throw error;
      if (
        error instanceof FilesError ||
        error instanceof AccountIdentityError ||
        (error instanceof FilegateError && [403, 404, 409].includes(error.status))
      )
        return { ...upload, error_code: "receipt_unknown" };
      throw error;
    }
  }
  async function management(actor: RequestActor, id: string, admin = false) {
    const userId = await deps.actorUserId(actor);
    if (admin) await deps.requireAdmin(actor);
    const row = await shares.get(id);
    if (!row || (!admin && row.created_by !== userId)) throw new FilesError("not_found", 404);
    return { row, userId, binding: await deps.bindings.byId(row.base_id) };
  }
  return {
    async unlockShare(token: string, kind: "download" | "inbox", password: string, context?: ShareAccessContext) {
      if (password.length < 1 || password.length > 256) throw new FilesError("share_password_invalid", 403);
      const row = token.length >= 16 && token.length <= 256 ? await shares.byToken(token) : null;
      if (!row || row.kind !== kind) throw new FilesError("not_found", 404);
      await activeRow(row);
      try {
        return await unlockSharePassword(row, password);
      } catch (error) {
        if (error instanceof FilesError && error.code === "share_password_invalid")
          await recordShareAccess(row.id, "password_failed", context);
        throw error;
      }
    },
    async createShare(
      call: UserFilesCall,
      input: z.input<typeof CreateShareInputSchema> & { baseId: string },
    ): Promise<ShareView & { url: string }> {
      const actor = call.actor;
      const { CreateShareInputSchema } = await import("../contracts");
      const parsed = CreateShareInputSchema.parse(input);
      if (parsed.maxFileSize > parsed.maxTotalSize) throw new FilesError("inbox_invalid_limits");
      let current: T;
      let scope: string;
      let items: string[] = [];
      const selected: T[] = [];
      let targets: ShareTarget[];
      if (parsed.kind === "inbox") {
        current = await deps.writableParent(actor, input.baseId, joinPath(parsed.folder, "placeholder"));
        scope = current.relative.split("/").slice(0, -1).join("/");
        targets = [{ path: current.target, directory: true, itemId: current.node.id ?? null }];
      } else {
        if (!parsed.paths.length) throw new FilesError("invalid_path");
        for (const path of parsed.paths) {
          const item = await deps.authorized(actor, input.baseId, path);
          items.push(item.relative);
          selected.push(item);
        }
        items = [...new Set(items)].filter((path, _, all) => !all.some((parent) => parent !== path && path.startsWith(`${parent}/`)));
        const segments = items.map((path) => path.split("/").slice(0, -1));
        let depth = 0;
        while (depth < segments[0]!.length && segments.every((parts) => parts[depth] === segments[0]![depth])) depth++;
        scope = segments[0]!.slice(0, depth).join("/");
        current = await deps.authorized(actor, input.baseId, scope, true);
        targets = items.map((path) => {
          const item = selected.find((entry) => entry.relative === path)!;
          return { path: item.target, directory: item.node.directory, itemId: item.node.id ?? null };
        });
      }
      const token = randomBytes(24).toString("base64url");
      const { candidate, binding } = current.inspection;
      // Each authorization may read configuration/binding afresh. A grant must never combine snapshots
      // from different servers or bindings, including the final common-folder authorization.
      if (
        !binding ||
        [current, ...selected].some(
          (item) =>
            item.state.config.url !== current.state.config.url ||
            item.root.name !== candidate.root ||
            item.node.root !== candidate.root ||
            item.inspection.binding?.id !== binding.id ||
            item.inspection.binding.root !== candidate.root ||
            item.inspection.binding.path !== candidate.path ||
            item.inspection.candidate.root !== candidate.root ||
            item.inspection.candidate.path !== candidate.path,
        )
      )
        throw new FilesError("storage_changed", 409);
      const passwordHash = parsed.password ? await hashSharePassword(parsed.password) : null;
      const origin = await deps.publicOrigin();
      const row = await sql.begin(async (tx) => {
        const created = await shares.create(
          {
            token_hash: shareTokenHash(token),
            password_hash: passwordHash,
            kind: parsed.kind,
            base_id: binding.id,
            root: candidate.root,
            base_path: candidate.path,
            server_url: current.state.config.url,
            target_snapshots: targets,
            scope,
            items,
            title: parsed.title,
            note: parsed.note || null,
            public_note: parsed.publicNote || null,
            owner_uid: candidate.area === "freeipa" ? current.state.unix!.uid : null,
            owner_gid: candidate.area === "freeipa" ? current.node.gid : null,
            created_by: current.state.self.user.id,
            created_by_name: current.state.self.user.username,
            expires_at: parsed.expiresIn === "unlimited" ? null : new Date(Date.now() + TTL[parsed.expiresIn]),
            max_file_size: parsed.maxFileSize,
            max_total_size: parsed.maxTotalSize,
            show_upload_names: parsed.showUploadNames,
          },
          tx,
        );
        await recordShareActivity(tx, call, created, "share.create");
        return created;
      });
      const url = `${origin}/share/filesv2/${row.kind === "inbox" ? "inbox" : "s"}/${token}`;
      return { ...shareView(row, binding), url };
    },
    async listShares(call: UserFilesCall, input: z.input<typeof SharePageQuerySchema> & { admin?: boolean } = {}): Promise<SharePage> {
      const actor = call.actor;
      const userId = await deps.actorUserId(actor);
      if ((input.baseId === undefined) !== (input.path === undefined)) throw new FilesError("invalid_path");
      // Scoped detail reads discover administration on the server once, never once per share.
      let admin = input.admin === true;
      if (admin) await deps.requireAdmin(actor);
      else if (input.baseId !== undefined) {
        try {
          await deps.requireAdmin(actor);
          admin = true;
        } catch (error) {
          if (!((error instanceof AccountIdentityError || error instanceof FilesError) && [403, 404].includes(error.status))) throw error;
        }
      }
      const current = input.baseId !== undefined ? await deps.readOnlyAuthorized(actor, input.baseId, userPath(input.path!)) : null;
      const binding = current?.inspection.binding;
      if (
        current &&
        (!binding ||
          binding.lifecycle !== "active" ||
          binding.root !== current.inspection.candidate.root ||
          binding.path !== current.inspection.candidate.path ||
          current.target !== joinPath(binding.path, current.relative) ||
          current.node.path !== current.target ||
          current.node.root !== binding.root ||
          current.inspection.summary.id !== input.baseId)
      )
        throw new FilesError("storage_changed", 409);
      const page = await shares.list({
        ownerId: admin ? undefined : userId,
        after: input.after,
        ...(current && binding
          ? {
              item: {
                bindingId: binding.id,
                serverUrl: current.state.config.url,
                root: binding.root,
                basePath: binding.path,
                path: current.relative,
                target: current.target,
                directory: current.node.directory,
                itemId: current.info.stableIds === true ? (current.node.id ?? null) : null,
              },
            }
          : {}),
      });
      if (!current || !binding)
        return {
          items: await Promise.all(page.items.map(async (row) => shareView(row, await deps.bindings.byId(row.base_id)))),
          next: page.next,
        };
      const names = await deps.displayNames(
        [...new Set(page.items.map((row) => row.created_by))].map((id) => ({ principal: { type: "user" as const, userId: id } })),
      );
      const byId = new Map(
        names.flatMap((row) => (row.principal.type === "user" ? [[row.principal.userId, row.displayName ?? ""] as const] : [])),
      );
      return {
        items: page.items.map((row) => ({
          ...shareView(row, binding),
          base: { id: current.inspection.summary.id, name: current.inspection.summary.name, kind: binding.kind },
          createdBy: byId.get(row.created_by) ?? "",
          managementMode: row.created_by === userId ? "creator" : "admin",
        })),
        next: page.next,
      };
    },
    async revokeShare(call: UserFilesCall, input: { id: string; admin?: boolean }): Promise<ShareView> {
      const actor = call.actor;
      const { row, userId, binding } = await management(actor, input.id, input.admin);
      const revoked = await sql.begin(async (tx) => {
        const changed = await shares.revoke(row.id, userId, tx);
        if (changed) await recordShareActivity(tx, call, changed, "share.revoke");
        return changed ?? (await shares.get(row.id, tx))!;
      });
      return shareView(revoked, binding);
    },
    async publicShare(
      token: string,
      kind: "download" | "inbox",
      input: { path?: string; after?: string } = {},
      access?: string,
      context?: ShareAccessContext,
    ): Promise<PublicShare> {
      const active = await activeShare(token, kind, access);
      const { row, actor, binding } = active;
      const path = userPath(input.path ?? "");
      const result: PublicShare = {
        kind,
        title: row.title,
        note: row.public_note,
        expiresAt: row.expires_at?.toISOString() ?? null,
        items: [],
        path,
        next: null,
        maxFileSize: row.max_file_size,
        maxTotalSize: row.max_total_size,
        showUploadNames: row.show_upload_names,
        uploadedNames: [],
      };
      if (kind === "inbox") {
        if (row.show_upload_names) {
          const page = await uploads.names(row.id, input.after);
          result.uploadedNames = page.items;
          result.next = page.next;
        }
      } else if (path) {
        if (!contains(row, path)) throw new FilesError("not_found", 404);
        const current = await deps.authorized(actor, baseId(binding), path, true);
        const page = await current.root.list(current.target, { after: input.after, limit: 50 });
        for (const node of page.items) {
          const relative = joinPath(path, node.path.split("/").at(-1)!);
          try {
            const entry = await deps.authorized(actor, baseId(binding), relative);
            result.items.push({
              path: relative,
              name: relative.split("/").at(-1)!,
              directory: entry.node.directory,
              size: entry.node.size,
            });
          } catch (error) {
            if (
              !(error instanceof FilesError && [403, 404].includes(error.status)) &&
              !(error instanceof FilegateError && [403, 404].includes(error.status))
            )
              throw error;
          }
        }
        result.next = page.next ?? null;
      } else {
        for (const relative of row.items) {
          try {
            const current = await deps.authorized(actor, baseId(binding), relative);
            result.items.push({
              path: relative,
              name: relative.split("/").at(-1)!,
              directory: current.node.directory,
              size: current.node.size,
            });
          } catch (error) {
            if (
              !(error instanceof FilesError && [403, 404].includes(error.status)) &&
              !(error instanceof FilegateError && [403, 404].includes(error.status))
            )
              throw error;
          }
        }
      }
      await recordShareAccess(row.id, "page", context);
      await shares.touch(row.id);
      return result;
    },
    async publicShareDownload(token: string, path: string, access?: string, context?: ShareAccessContext): Promise<DownloadLease> {
      const { row, actor, binding } = await activeShare(token, "download", access);
      const relative = userPath(path);
      if (!contains(row, relative)) throw new FilesError("not_found", 404);
      const current = await deps.authorized(actor, baseId(binding), relative, false);
      const lease = await current.root.directDownload(current.target, { expiresIn: 60 });
      await recordShareAccess(row.id, "download", context);
      await shares.touch(row.id);
      return { url: lease.url, method: "GET", expires: lease.expires };
    },
    async publicShareArchive(token: string, access?: string, context?: ShareAccessContext): Promise<ArchiveDownload> {
      const { row, actor, binding, current } = await activeShare(token, "download", access);
      for (const relative of row.items) await deps.authorized(actor, baseId(binding), relative);
      const client = deps.connect(current.state.config);
      const execution = deps.executionFor(current);
      const lease = await (execution ? client.as(execution) : client).archiveLease(
        row.items.map((relative) => ({ root: row.root, path: joinPath(row.base_path, relative), archivePath: relative })),
        300,
      );
      await recordShareAccess(row.id, "download", context);
      await shares.touch(row.id);
      return { url: lease.url, method: "POST", expires: lease.expires, manifest: lease.manifest };
    },
    async publicInboxUpload(
      token: string,
      input: { name: string; size: number; idempotencyKey: string },
      access?: string,
      requestId: string | null = null,
    ): Promise<UploadSession> {
      const initial = await activeShare(token, "inbox", access);
      const deadline = Date.now() + 10_000;
      for (const pending of await uploads.pendingForShare(initial.row.id)) {
        if (Date.now() >= deadline) break;
        await reconcile(deps.connect(initial.current.state.config).root(initial.row.root), pending, initial.current.state.config);
      }
      const { row, root, current } = await activeShare(token, "inbox", access);
      const relative = userPath(joinPath(row.scope, input.name));
      if (relative.split("/").length !== row.scope.split("/").filter(Boolean).length + 1) throw new FilesError("invalid_path");
      const reservation = await uploads.reserve(
        {
          id: input.idempotencyKey,
          base_id: row.base_id,
          user_id: row.created_by,
          root: row.root,
          path: relative,
          size: input.size,
          share_id: row.id,
          server_url: current.state.config.url,
          write_options: {
            onConflict: "rename",
            ownership: deps.ownershipFor(current, false),
          },
          execution: normalizeExecution(deps.executionFor(current)),
        },
        { call: visitorCall(row.id, requestId), target: joinPath(row.base_path, relative), previous: null },
      );
      try {
        let created: SessionCreated;
        const id = uploadSessionId(reservation);
        if (id) {
          validateActiveUpload(reservation, row, current);
          const session = await root.session(id);
          await remember(reservation, row, session);
          await deps.validateUploadTarget(current, reservation.path);
          created = {
            session,
            ...(session.state === "open" ? { lease: await root.sessionLease(id, { expiresIn: 300, allowAbort: true }) } : {}),
          };
        } else {
          created = await openReservation(reservation, row, current);
        }
        await shares.touch(row.id);
        return {
          id: reservation.id,
          path: relative,
          size: input.size,
          state: created.session.state,
          chunkSize: created.session.chunkSize,
          url: created.lease?.url,
          expires: created.lease?.expires ?? created.session.expires,
        };
      } catch (error) {
        await uploads.unresolved(reservation.id, "session_creation_unknown");
        throw error;
      }
    },
    async publicInboxLease(token: string, id: string, access?: string): Promise<UploadLease> {
      const { row, root, current } = await activeShare(token, "inbox", access);
      const upload = await uploads.getForShare(id, row.id);
      const reconciled = upload ? await reconcile(root, upload, current.state.config) : null;
      if (!upload || !reconciled || reconciled.state !== "open" || reconciled.error_code || !uploadSessionId(reconciled))
        throw new FilesError("upload_closed", 409);
      validateActiveUpload(reconciled, row, current);
      await deps.validateUploadTarget(current, reconciled.path);
      const lease = await root.sessionLease(uploadSessionId(reconciled)!, { expiresIn: 300, allowAbort: true });
      return { url: lease.url, expires: lease.expires };
    },
    async publicInboxCommit(token: string, id: string, access?: string): Promise<{ name: string; size: number }> {
      // Terminal receipts remain queryable after expiry/revocation; publishing a new result still needs a live grant.
      const row = await tokenShare(token, "inbox", access);
      let upload = await uploads.getForShare(id, row.id);
      if (!upload) throw new FilesError("not_found", 404);
      const config = await deps.readConfiguration();
      if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
      const root = deps.connect(config).root(row.root);
      upload = await reconcile(root, upload, config);
      if (upload.state === "committed" && upload.result) return published(upload, row, upload.result);
      const active = await activeShare(token, "inbox", access);
      const sessionId = uploadSessionId(upload);
      validateActiveUpload(upload, row, active.current);
      if (upload.error_code) throw new FilesError("upload_uncertain", 409);
      if (upload.state !== "open" || !sessionId) throw new FilesError("upload_closed", 409);
      await deps.validateUploadTarget(active.current, upload.path);
      const session = await active.root.session(sessionId);
      validateSession(upload, row, session);
      if (session.received !== session.size) throw new FilesError("upload_incomplete", 409);
      try {
        const node = await uploadAction(upload.id, () => active.root.commitSession(sessionId));
        const result = published(upload, row, node);
        await uploads.finish(upload.id, "committed", node);
        return result;
      } catch (error) {
        const recovered = await reconcile(root, upload, config);
        if (recovered.state === "committed" && recovered.result) return published(recovered, row, recovered.result);
        throw error;
      }
    },
    async publicInboxAbort(token: string, id: string, access?: string): Promise<void> {
      const row = await tokenShare(token, "inbox", access);
      const upload = await uploads.getForShare(id, row.id);
      if (!upload || upload.state !== "open") return;
      const config = await deps.readConfiguration();
      if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
      const root = deps.connect(config).root(row.root);
      const reconciled = await reconcile(root, upload, config);
      if (reconciled.state !== "open" || reconciled.error_code) return;
      const sessionId = uploadSessionId(reconciled);
      if (!sessionId) return;
      try {
        await uploadAction(upload.id, () => sessionRoot(root, reconciled).abortSession(sessionId));
      } catch (error) {
        await reconcile(root, upload, config);
        if (!(error instanceof FilegateError && [404, 409].includes(error.status))) throw error;
        return;
      }
      // A successful abort is authoritative; 404/409 responses above are deliberately not treated as one.
      await uploads.finish(upload.id, "aborted", null);
    },
    async reconcileInboxUploads(
      options: { signal?: AbortSignal; heartbeat?: () => Promise<unknown> } = {},
    ): Promise<{ processed: number; unresolved: number }> {
      const config = await deps.readConfiguration();
      if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
      let processed = 0;
      let unresolved = 0;
      const deadline = Date.now() + 20_000;
      for (const upload of await uploads.pending()) {
        if (options.signal?.aborted || Date.now() >= deadline) break;
        await options.heartbeat?.();
        if (options.signal?.aborted) break;
        try {
          const result = await reconcile(deps.connect(config).root(upload.root), upload, config);
          if (result.state === "open" && result.error_code) unresolved++;
        } catch {
          unresolved++;
        }
        processed++;
      }
      return { processed, unresolved };
    },
    async adminUploadReservations(call: UserFilesCall, input: { after?: string } = {}) {
      const actor = call.actor;
      await deps.requireAdmin(actor);
      const page = await uploads.uncertain(input.after);
      return {
        items: page.items.map((row) => ({
          id: row.id,
          shareId: row.share_id,
          path: row.path,
          size: row.size,
          state: row.state,
          error: row.error_code,
          updatedAt: row.updated_at.toISOString(),
        })),
        next: page.next,
      };
    },
  };
}
