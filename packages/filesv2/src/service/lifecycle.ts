import type { RequestActor } from "@k2b/cloud/server";
import { type accountIdentities, audit } from "@k2b/cloud/services";
import { type DirectoryOptions, FilegateError, type Node, type TransferResult } from "@k2b/filegate";
import { sql } from "bun";
import type {
  AdminBrowseResult,
  AdminLocator,
  ArchiveEntry,
  ArchivePage,
  Area,
  BaseKind,
  DirectoryMaintenanceResult,
  DirectoryTarget,
  OperationResult,
  RootSummary,
} from "../contracts";
import { finishActivity, insertActivity } from "../data/activity";
import type { bindings, NewBinding } from "../data/bases";
import { type NewOperation, type Operation, operations, withRootLock } from "../data/operations";
import {
  type FilesCall,
  fileAction,
  filegateException,
  journalAction,
  type LifecycleMkdir,
  systemCall,
  type UserFilesCall,
} from "./activity";
import { createActivityObservations } from "./activity-observations";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import type { FilesFilegate, FilesRoot } from "./filegate-facade";
import { joinPath, relativePath } from "./paths";
import { rootSummary as summary } from "./root-summary";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Dependencies = {
  identities: typeof accountIdentities;
  bindings: typeof bindings;
  readConfiguration: typeof readConfiguration;
  connect: (config: Config) => FilesFilegate;
};
const provider = (area: Area) => (area === "cloud" ? ("local" as const) : ("ipa" as const));
const PAGE_SIZE = 50;
const strictName = (value: string) => {
  const name = relativePath(value, false);
  if (name.includes("/")) throw new FilesError("invalid_path");
  return name;
};
const basePath = (config: Config, input: DirectoryTarget) =>
  joinPath(
    config[input.area].prefix,
    input.kind === "users" ? config[input.area].homes : config[input.area].groups,
    strictName(input.name),
  );
const within = (path: string, parent: string) => path === parent || path.startsWith(`${parent}/`);
const result = (operation: Operation): OperationResult => ({
  id: operation.id,
  state: operation.state === "pending" ? "pending" : "complete",
  path: operation.target ?? operation.source,
});
async function stat(root: FilesRoot, path: string): Promise<Node | null> {
  try {
    return await root.stat(path);
  } catch (error) {
    if (error instanceof FilegateError && error.status === 404) return null;
    throw error;
  }
}
/** Compares ids only when both sides have one: Filegate 7 omits them outside stable-id roots. */
const unchanged = (before: Node | null, now: Node) =>
  before !== null &&
  before.directory === now.directory &&
  before.uid === now.uid &&
  before.gid === now.gid &&
  before.mode === now.mode &&
  (before.id && now.id ? before.id === now.id : before.modified === now.modified && before.size === now.size);
async function serviceUid(root: FilesRoot, parent: string): Promise<number> {
  return filegateException("lifecycle.probe", async () => {
    // The root directory owner may differ from the daemon. Only remove a probe
    // whose creation succeeded; no existing directory is ever chowned here.
    const probe = joinPath(parent, `.filesv2-owner-${crypto.randomUUID()}`);
    let made = false;
    try {
      const node = await root.mkdir(probe, { ownership: { dirMode: "0700" } });
      made = true;
      return node.uid;
    } finally {
      if (made) await root.remove(probe);
    }
  });
}
const privateDirectory = async (root: FilesRoot, path: string) => {
  const node = await root.stat(path);
  const owner = await serviceUid(root, path.split("/").slice(0, -1).join("/") || ".");
  if (!node.directory || node.uid !== owner || (Number.parseInt(node.mode, 8) & 0o077) !== 0)
    throw new FilesError("archive_not_private", 409);
};
async function ensureParents(root: FilesRoot, path: string, mode: string) {
  const parts = path === "." ? [] : relativePath(path, false).split("/");
  for (let i = 1; i <= parts.length; i++) {
    const current = parts.slice(0, i).join("/");
    let node = await stat(root, current);
    if (!node) {
      try {
        node = await root.mkdir(current, { ownership: { dirMode: mode } });
      } catch (error) {
        if (!(error instanceof FilegateError && error.status === 409)) throw error;
        node = await root.stat(current);
      }
    }
    if (!node.directory) throw new FilesError("not_directory", 409);
  }
}
const creationOptions = (base: NewBinding, daemonUid?: number): DirectoryOptions => {
  const entries =
    base.kind === "groups" && base.area === "freeipa"
      ? [
          { tag: "owner" as const, permissions: "rwx" as const },
          { tag: "owningGroup" as const, permissions: "rwx" as const },
          { tag: "other" as const, permissions: "---" as const },
        ]
      : [
          { tag: "owner" as const, permissions: "rwx" as const },
          { tag: "owningGroup" as const, permissions: "---" as const },
          { tag: "other" as const, permissions: "---" as const },
        ];
  return {
    ownership:
      base.area === "cloud"
        ? { dirMode: "0700" }
        : base.kind === "users"
          ? { uid: base.uid_number!, gid: base.gid_number!, dirMode: "0700" }
          : { uid: daemonUid!, gid: base.gid_number!, dirMode: "2770" },
    acl: { access: { entries }, default: { entries } },
  };
};
async function verifyCreation(root: FilesRoot, node: Node, base: NewBinding, daemonUid?: number) {
  const expected = creationOptions(base, daemonUid);
  if (
    !node.directory ||
    Number.parseInt(node.mode, 8) !== Number.parseInt(expected.ownership!.dirMode!, 8) ||
    (base.area === "freeipa" &&
      (node.gid !== base.gid_number ||
        (base.kind === "users" && node.uid !== base.uid_number) ||
        (base.kind === "groups" && node.uid !== daemonUid)))
  )
    throw new FilesError("ownership_mismatch", 409);
  const normalize = (entries: { tag: string; id?: number; permissions: string }[]) =>
    entries
      .map((e) => `${e.tag}:${e.id ?? ""}:${e.permissions}`)
      .sort()
      .join("|");
  for (const scope of ["access", "default"] as const) {
    const acl = await root.getACL(node.path, scope);
    if (normalize(acl.entries) !== normalize(expected.acl![scope]!.entries)) throw new FilesError("ownership_mismatch", 409);
  }
}

export function createDirectoryLifecycle(deps: Dependencies) {
  async function admin(actor: RequestActor, area: Area) {
    await deps.identities.inventory(actor, { kind: "groups", provider: "local" });
    const self = await deps.identities.self(actor);
    const config = await deps.readConfiguration();
    if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
    checkArea(config, area, self.availability);
    return { config, root: deps.connect(config).root(config[area].root), actorId: self.user.id, actorName: self.user.username };
  }
  function checkArea(config: Config, area: Area, availability: { localLinuxEnabled: boolean; freeipaEnabled: boolean }) {
    if (!config[area].enabled) throw new FilesError("area_disabled", 403);
    if (area === "cloud" && !availability.localLinuxEnabled) throw new FilesError("local_linux_disabled", 403);
    if (area === "freeipa" && !availability.freeipaEnabled) throw new FilesError("freeipa_disabled", 403);
    if (!config.url || !config.token) throw new FilesError("not_configured", 503);
  }
  async function locked<T>(root: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await withRootLock(root, fn);
    } catch (error) {
      if (error instanceof Error && error.message === "operation_busy") throw new FilesError("operation_busy", 409);
      throw error;
    }
  }
  function archiveParent(config: Config, area: Area, path: string): string {
    const relative = relativePath(path, false);
    for (const active of [config[area].homes, config[area].groups])
      if (within(relative, active) || within(active, relative)) throw new FilesError("overlapping_paths");
    return joinPath(config[area].prefix, relative);
  }
  function archiveTargetContained(config: Config, area: Area, target: string): boolean {
    const prefix = config[area].prefix;
    if (prefix && !target.startsWith(`${prefix}/`)) return false;
    const relative = prefix ? target.slice(prefix.length + 1) : target;
    try {
      archiveParent(config, area, relative.split("/").slice(0, -2).join("/"));
      return true;
    } catch {
      return false;
    }
  }
  function operationContained(config: Config, op: NewOperation) {
    const active = basePath(config, { area: op.area, kind: op.kind, name: op.name });
    if (op.root !== config[op.area].root || op.server_url !== config.url) throw new FilesError("configuration_changed", 409);
    if (op.action === "create" && op.source !== active) throw new FilesError("configuration_changed", 409);
    if (op.action === "archive" && (op.source !== active || !op.target || !archiveTargetContained(config, op.area, op.target)))
      throw new FilesError("configuration_changed", 409);
    if (op.action === "restore" && (op.target !== active || !archiveTargetContained(config, op.area, op.source)))
      throw new FilesError("configuration_changed", 409);
    if (op.action === "delete" && !within(op.source, active) && !op.archive_id) throw new FilesError("configuration_changed", 409);
  }
  async function creationBinding(operation: NewOperation): Promise<NewBinding> {
    const [row] = await sql<{ uid_number: number | null; gid_number: number | null }[]>`
      SELECT uid_number::float8 AS uid_number,gid_number::float8 AS gid_number
      FROM filesv2.bases WHERE id=${operation.base_id}::uuid`;
    if (!row) throw new FilesError("binding_conflict", 409);
    return {
      area: operation.area,
      kind: operation.kind,
      identity_id: "",
      identity_name: operation.name,
      root: operation.root,
      path: operation.source,
      ...row,
    };
  }
  async function nearestParent(root: FilesRoot, path: string): Promise<string> {
    let parent = path.split("/").slice(0, -1).join("/") || ".";
    for (;;) {
      const node = await stat(root, parent);
      if (node) {
        if (!node.directory) throw new FilesError("not_directory", 409);
        return parent;
      }
      if (parent === ".") throw new FilesError("not_found", 404);
      parent = parent.split("/").slice(0, -1).join("/") || ".";
    }
  }
  async function resetRefusedPublication(operation: Operation, error: unknown) {
    // mkdir publishes only after preparing permissions; same-root move is an atomic rename.
    // Parents may already exist from this attempt, so retain the pending history and original scope.
    if (
      (error instanceof FilesError && ["activity_scope_missing", "activity_scope_mismatch"].includes(error.code)) ||
      (error instanceof FilegateError &&
        ([400, 403, 404, 412].includes(error.status) ||
          (error.status === 409 && error.code === "path_conflict") ||
          (error.status === 501 && ["acl_not_supported", "unsupported_storage_layout"].includes(error.code))))
    )
      await operations.refusedEffect(operation.id);
  }
  async function plannedMkdirs(root: FilesRoot, operation: NewOperation): Promise<LifecycleMkdir[]> {
    if (operation.action === "delete") return [];
    const path = operation.action === "create" ? operation.source : operation.target!;
    const mode = operation.action === "archive" || operation.area === "cloud" ? "0700" : "0755";
    const parts = path.split("/");
    const mkdirs: LifecycleMkdir[] = parts.slice(0, -1).map((_, index) => ({
      path: parts.slice(0, index + 1).join("/"),
      options: { ownership: { dirMode: mode } },
    }));
    if (operation.action === "create") {
      const base = await creationBinding(operation);
      // The existing named probe exception is not user data. Probe an existing
      // ancestor so every parent and target write can be bound before it begins.
      const uid = base.area === "freeipa" && base.kind === "groups" ? await serviceUid(root, await nearestParent(root, path)) : undefined;
      mkdirs.push({ path, options: creationOptions(base, uid) });
    }
    return mkdirs;
  }
  async function perform(config: Config, root: FilesRoot, operation: Operation, allowCreate = true): Promise<OperationResult> {
    operationContained(config, operation);
    if (operation.archive_id) {
      const archived = await operations.get(operation.archive_id);
      if (!archived || archived.action !== "archive") throw new FilesError("not_found", 404);
      operationContained(config, archived);
      if (operation.action === "delete" && !within(operation.source, archived.target!)) throw new FilesError("configuration_changed", 409);
    }
    const activity = await operations.history(
      operation.id,
      operation.activity_recorded || operation.state !== "pending" ? undefined : await plannedMkdirs(root, operation),
    );
    if (operation.state !== "pending") return result(operation);
    if (!activity) throw new FilesError("activity_scope_missing", 500);
    return journalAction(activity.id, () => performOperation(config, root, operation, allowCreate, activity.mkdirs ?? []), {
      heartbeat: allowCreate,
    });
  }
  async function performOperation(
    config: Config,
    root: FilesRoot,
    operation: Operation,
    allowCreate: boolean,
    mkdirs: LifecycleMkdir[],
  ): Promise<OperationResult> {
    if (operation.error_code === "transfer_pending") throw new FilesError("transfer_pending", 409);
    try {
      let receipt = operation.receipt;
      if (operation.action === "create") {
        const base = await creationBinding(operation);
        const path = operation.source;
        const uid = mkdirs.find((entry) => entry.path === path)?.options.ownership?.uid;
        if (base.area === "freeipa" && base.kind === "groups" && uid === undefined) throw new FilesError("activity_scope_missing", 500);
        const existing = await stat(root, path);
        // An ordinary target has no operation identity. Even an identical
        // directory is only an observation after a lost mkdir response.
        if (!receipt) {
          if (existing || operation.effect_started) throw new FilesError("operation_unresolved", 409);
          if (!allowCreate) return result(operation);
          await ensureParents(root, path.split("/").slice(0, -1).join("/"), operation.area === "cloud" ? "0700" : "0755");
          await operations.beginEffect(operation.id);
          try {
            receipt = await root.mkdir(path, creationOptions(base, uid));
          } catch (error) {
            await resetRefusedPublication(operation, error);
            throw error;
          }
          if (receipt.root !== operation.root || receipt.path !== path) throw new FilesError("operation_unresolved", 409);
          await operations.recordReceipt(operation.id, receipt);
        }
        if ("deleted" in receipt) throw new FilesError("operation_unresolved", 409);
        const node = existing ?? (await root.stat(path));
        if (!unchanged(receipt, node)) throw new FilesError("source_changed", 409);
        await verifyCreation(root, node, base, uid);
      } else if (operation.action === "archive" || operation.action === "restore") {
        const source = await stat(root, operation.source);
        const target = await stat(root, operation.target!);
        if (source && target) throw new FilesError("path_conflict", 409);
        if (!source && !target) throw new FilesError("not_found", 409);
        if (!receipt) {
          if (!source) {
            // Only the UUID archive namespace is operation-bound evidence.
            // A restored directory uses an ordinary path and proves nothing.
            if (operation.action !== "archive" || !operation.target?.endsWith(`/${operation.id}/contents`))
              throw new FilesError("operation_unresolved", 409);
            if (!target || !unchanged(operation.snapshot, target)) throw new FilesError("source_changed", 409);
            await privateDirectory(root, operation.target.split("/").slice(0, -1).join("/"));
            receipt = target;
            await operations.recordReceipt(operation.id, receipt);
          } else {
            if (!unchanged(operation.snapshot, source)) throw new FilesError("source_changed", 409);
            if (operation.effect_started) throw new FilesError("operation_unresolved", 409);
            if (!allowCreate) return result(operation);
            const parent = operation.target!.split("/").slice(0, -1).join("/");
            await ensureParents(root, parent, operation.action === "archive" || operation.area === "cloud" ? "0700" : "0755");
            if (operation.action === "archive") await privateDirectory(root, parent);
            await operations.beginEffect(operation.id);
            let moved: TransferResult | undefined;
            try {
              moved = await root.transfer(operation.source, operation.root, operation.target!, { move: true, onConflict: "error" });
            } catch (error) {
              await resetRefusedPublication(operation, error);
              if (operation.action !== "archive" || !operation.target?.endsWith(`/${operation.id}/contents`)) throw error;
              const target = await stat(root, operation.target);
              if ((await stat(root, operation.source)) || !target || !unchanged(operation.snapshot, target)) throw error;
              await privateDirectory(root, parent);
              receipt = target;
            }
            if (moved) {
              if (moved.state !== "completed") throw new FilesError("transfer_pending", 409);
              if (!moved.node || moved.node.root !== operation.root || moved.node.path !== operation.target)
                throw new FilesError("operation_unresolved", 409);
              receipt = moved.node;
            }
            if (!receipt) throw new FilesError("operation_unresolved", 409);
            await operations.recordReceipt(operation.id, receipt);
          }
        }
        if ("deleted" in receipt) throw new FilesError("operation_unresolved", 409);
        const moved = await root.stat(operation.target!);
        if (!unchanged(operation.snapshot, moved) || !unchanged(receipt, moved)) throw new FilesError("source_changed", 409);
        if (operation.action === "archive") await privateDirectory(root, operation.target!.split("/").slice(0, -1).join("/"));
      } else if (!receipt) {
        const node = await stat(root, operation.source);
        // Missing source never proves deletion; never remove a replacement.
        if (!node) throw new FilesError("operation_unresolved", 409);
        if (!unchanged(operation.snapshot, node)) throw new FilesError("source_changed", 409);
        if (operation.effect_started) throw new FilesError("operation_unresolved", 409);
        if (!allowCreate) return result(operation);
        await operations.beginEffect(operation.id);
        await root.remove(operation.source, true);
        receipt = { deleted: true };
        await operations.recordReceipt(operation.id, receipt);
      }
      await operations.finish(operation, root);
      return result({ ...operation, state: "complete" });
    } catch (error) {
      await sql`UPDATE filesv2.operations SET error_code=${error instanceof FilesError ? error.code : "unavailable"},updated_at=now() WHERE id=${operation.id}::uuid AND state='pending'`;
      throw error;
    }
  }
  async function newOperation(config: Config, root: FilesRoot, input: Omit<NewOperation, "id">, call: FilesCall): Promise<OperationResult> {
    const pending = await operations.pending(input.root, input.source);
    if (pending) {
      if (pending.action !== input.action || pending.target !== input.target) throw new FilesError("operation_pending", 409);
      return perform(config, root, pending);
    }
    const value = { id: crypto.randomUUID(), ...input };
    operationContained(config, value);
    const operation = await operations.insert(value, call, await plannedMkdirs(root, value));
    return perform(config, root, operation);
  }
  async function provisionCandidate(
    config: Config,
    base: NewBinding,
    actorId: string | null,
    actorName: string | null,
    call: FilesCall = systemCall("automatic-provision", actorId ? { userId: actorId, uid: actorName } : undefined),
  ): Promise<OperationResult> {
    return locked(base.root, async () => {
      const root = deps.connect(config).root(base.root);
      const found = await deps.bindings.find(base);
      if (!found.length && (await operations.retiredPath(base.root, base.path))) throw new FilesError("retired", 409);
      if (
        found.some(
          (row) =>
            row.identity_id !== base.identity_id ||
            row.path !== base.path ||
            row.root !== base.root ||
            row.uid_number !== base.uid_number ||
            row.gid_number !== base.gid_number,
        )
      )
        throw new FilesError("binding_conflict", 409);
      if (found.some((row) => ["retired", "archived", "deleted"].includes(row.lifecycle))) throw new FilesError("retired", 409);
      const pending = await operations.pending(base.root, base.path);
      if (pending) {
        if (pending.action !== "create") throw new FilesError("operation_pending", 409);
        return perform(config, root, pending);
      }
      const existingNode = await stat(root, base.path);
      if (existingNode) {
        const [receipt] = await sql<
          Operation[]
        >`SELECT * FROM filesv2.operations WHERE root=${base.root} AND source=${base.path} AND base_id=${found[0]?.id ?? null}::uuid AND action='create' AND state='complete' ORDER BY created_at DESC LIMIT 1`;
        if (!receipt) throw new FilesError("path_conflict", 409);
        operationContained(config, receipt);
        const uid =
          base.area === "freeipa" && base.kind === "groups"
            ? await serviceUid(root, base.path.split("/").slice(0, -1).join("/"))
            : undefined;
        await verifyCreation(root, existingNode, base, uid);
        return result(receipt);
      }
      if (base.area === "freeipa" && (base.gid_number === null || (base.kind === "users" && base.uid_number === null)))
        throw new FilesError("identity_incomplete", 409);
      const claimed = await deps.bindings.claim(base);
      const binding = claimed.find((row) => row.identity_id === base.identity_id && row.path === base.path);
      if (!binding) throw new FilesError("binding_conflict", 409);
      await sql`UPDATE filesv2.bases SET lifecycle='provisioning' WHERE id=${binding.id}::uuid`;
      return newOperation(
        config,
        root,
        {
          area: base.area,
          kind: base.kind,
          root: base.root,
          server_url: config.url,
          name: base.identity_name,
          action: "create",
          source: base.path,
          target: null,
          base_id: binding.id,
          archive_id: null,
          actor_id: actorId,
          actor_name: actorName,
          snapshot: null,
        },
        call,
      );
    });
  }
  async function bindKnown(call: UserFilesCall, config: Config, input: DirectoryTarget, node: Node) {
    const actor = call.actor;
    const proof = await deps.identities.reconcile(actor, {
      kind: input.kind,
      provider: provider(input.area),
      name: input.name,
      signal: AbortSignal.timeout(5_000),
    });
    if (proof.state === "unknown") throw new FilesError("identity_unknown", 409);
    if (proof.state !== "present") return null;
    const page =
      input.kind === "users"
        ? await deps.identities.inventory(actor, { kind: "users", provider: provider(input.area), name: input.name })
        : await deps.identities.inventory(actor, { kind: "groups", provider: provider(input.area), name: input.name });
    const identity = page.items[0];
    if (!identity) return null;
    if (
      input.area === "freeipa" &&
      (node.gid !== proof.identity.gidNumber || (input.kind === "users" && node.uid !== proof.identity.uidNumber))
    )
      return null;
    const candidate: NewBinding = {
      area: input.area,
      kind: input.kind,
      identity_id: identity.id,
      identity_name: input.name,
      root: config[input.area].root,
      path: basePath(config, input),
      uid_number: input.area === "freeipa" ? proof.identity.uidNumber : null,
      gid_number: input.area === "freeipa" || input.kind === "groups" ? proof.identity.gidNumber : null,
    };
    const rows = await deps.bindings.claim(candidate, call);
    if (rows.length !== 1 || rows[0]!.identity_id !== identity.id || rows[0]!.path !== candidate.path)
      throw new FilesError("binding_conflict", 409);
    return rows[0]!;
  }
  async function archiveDirectory(call: UserFilesCall, input: DirectoryTarget & { archivePath?: string }) {
    const actor = call.actor;
    const state = await admin(actor, input.area);
    archiveParent(state.config, input.area, input.archivePath ?? state.config[input.area].archive);
    return locked(state.root.name, async () => {
      const source = basePath(state.config, input);
      let binding = await deps.bindings.path(state.root.name, source);
      if (binding && ["archived", "deleted"].includes(binding.lifecycle)) {
        const [receipt] = await sql<
          Operation[]
        >`SELECT * FROM filesv2.operations WHERE base_id=${binding.id}::uuid AND action='archive' AND state='complete' ORDER BY created_at DESC LIMIT 1`;
        if (receipt && !(await stat(state.root, source))) return result(receipt);
        throw new FilesError("retired", 409);
      }
      const identity = await deps.identities.reconcile(actor, {
        kind: input.kind,
        provider: provider(input.area),
        name: input.name,
        identityId: binding?.identity_id,
        signal: AbortSignal.timeout(5_000),
      });
      if (identity.state === "unknown") throw new FilesError("identity_unknown", 409);
      if (binding && identity.state === "present" && identity.identity.id !== null && identity.identity.id !== binding.identity_id)
        throw new FilesError("binding_conflict", 409);
      const pending = await operations.pending(state.root.name, source);
      if (pending) {
        if (pending.action !== "archive") throw new FilesError("operation_pending", 409);
        if (
          input.archivePath &&
          pending.target !== joinPath(archiveParent(state.config, input.area, input.archivePath), pending.id, "contents")
        )
          throw new FilesError("operation_pending", 409);
        return perform(state.config, state.root, pending);
      }
      if (!binding) {
        const node = await stat(state.root, source);
        if (node) binding = await bindKnown(call, state.config, input, node);
      }
      return archiveBound(state.config, state.root, input, binding?.id ?? null, state.actorId, state.actorName, call);
    });
  }
  async function archiveBound(
    config: Config,
    root: FilesRoot,
    input: DirectoryTarget & { archivePath?: string },
    baseId: string | null,
    actorId: string | null,
    actorName: string | null,
    call: FilesCall,
  ) {
    const source = basePath(config, input);
    const node = await stat(root, source);
    if (!node?.directory) throw new FilesError("not_directory", 409);
    const id = crypto.randomUUID();
    const target = joinPath(archiveParent(config, input.area, input.archivePath ?? config[input.area].archive), id, "contents");
    const value: NewOperation = {
      id,
      area: input.area,
      kind: input.kind,
      root: root.name,
      server_url: config.url,
      name: input.name,
      action: "archive",
      source,
      target,
      base_id: baseId,
      archive_id: null,
      actor_id: actorId,
      actor_name: actorName,
      snapshot: node,
    };
    const operation = await operations.insert(value, call, await plannedMkdirs(root, value));
    return perform(config, root, operation);
  }
  async function archiveById(actor: RequestActor, id: string) {
    const op = await operations.get(id);
    if (!op || op.action !== "archive") throw new FilesError("not_found", 404);
    const state = await admin(actor, op.area);
    operationContained(state.config, op);
    return { ...state, op };
  }
  async function location(actor: RequestActor, input: AdminLocator) {
    const state = await admin(actor, input.area);
    const relative = relativePath(input.path);
    let base: string;
    let name: string;
    let kind: BaseKind;
    let archiveId: string | null = null;
    if (input.archiveId) {
      const op = await operations.get(input.archiveId);
      if (!op || op.action !== "archive" || op.area !== input.area || op.state !== "complete") throw new FilesError("not_found", 404);
      operationContained(state.config, op);
      base = op.target!;
      name = op.name;
      kind = op.kind;
      archiveId = op.id;
    } else {
      if (!input.kind || !input.name) throw new FilesError("invalid_path");
      kind = input.kind;
      name = strictName(input.name);
      base = basePath(state.config, { area: input.area, kind, name });
    }
    return { ...state, base, target: joinPath(base, relative), relative, name, kind, archiveId };
  }
  async function recordAdminRead(
    call: UserFilesCall,
    loc: Awaited<ReturnType<typeof location>>,
    node: Node,
    operation: "list" | "download" | "versions",
  ) {
    const binding = await deps.bindings.path(loc.root.name, loc.base);
    const archive = loc.archiveId ? await operations.get(loc.archiveId) : null;
    await sql.begin(async (tx) => {
      const id = await insertActivity(
        call,
        {
          action: "admin.read",
          serverUrl: loc.config.url,
          root: loc.root.name,
          baseId: archive?.base_id ?? binding?.id ?? null,
          directory: node.directory,
          name: node.path.split("/").at(-1)!,
          pathBefore: loc.target,
          itemId: node.id,
          size: node.size,
          revisionBefore: node.revision,
          detail: { operation },
        },
        tx,
      );
      await finishActivity(tx, id, "done", async () => {
        await audit.record(
          {
            action: "filesv2.admin.read",
            outcome: "allowed",
            actor: { userId: loc.actorId, uid: loc.actorName },
            target: { type: "filesv2.item", id: node.id ?? loc.target, label: loc.target },
            requestId: call.requestId,
            metadata: { operation, historyId: id },
          },
          tx,
        );
      });
    });
  }
  return {
    provisionCandidate,
    async provision(call: UserFilesCall, input: { area: Area; kind: BaseKind; identityId: string }) {
      const actor = call.actor;
      const state = await admin(actor, input.area);
      const page =
        input.kind === "users"
          ? await deps.identities.inventory(actor, { kind: "users", provider: provider(input.area), id: input.identityId })
          : await deps.identities.inventory(actor, { kind: "groups", provider: provider(input.area), id: input.identityId });
      const record = page.items[0];
      if (!record) throw new FilesError("not_found", 404);
      const name = "username" in record ? record.username : record.name;
      const current = await deps.identities.reconcile(actor, {
        kind: input.kind,
        provider: provider(input.area),
        name,
        signal: AbortSignal.timeout(5_000),
      });
      if (current.state !== "present" || !current.eligible) throw new FilesError("identity_incomplete", 409);
      const base: NewBinding = {
        area: input.area,
        kind: input.kind,
        identity_id: record.id,
        identity_name: name,
        root: state.root.name,
        path: basePath(state.config, { area: input.area, kind: input.kind, name }),
        uid_number: input.area === "freeipa" ? current.identity.uidNumber : null,
        gid_number: input.area === "freeipa" || input.kind === "groups" ? current.identity.gidNumber : null,
      };
      return provisionCandidate(state.config, base, state.actorId, state.actorName, call);
    },
    archive: (call: UserFilesCall, input: DirectoryTarget & { archivePath?: string }) => archiveDirectory(call, input),
    async retire(call: UserFilesCall, input: DirectoryTarget): Promise<OperationResult> {
      const actor = call.actor;
      const state = await admin(actor, input.area);
      return locked(state.root.name, async () => {
        const path = basePath(state.config, input);
        const binding = await deps.bindings.path(state.root.name, path);
        if (!binding) throw new FilesError("unassigned", 409);
        if (await operations.pending(state.root.name, path)) throw new FilesError("operation_pending", 409);
        await sql.begin(async (tx) => {
          const changed =
            await tx`UPDATE filesv2.bases SET lifecycle='retired' WHERE id=${binding.id}::uuid AND lifecycle='active' RETURNING id`;
          if (!changed.length) return;
          const id = await insertActivity(
            call,
            {
              action: "place.retire",
              serverUrl: state.config.url,
              root: state.root.name,
              baseId: binding.id,
              directory: true,
              name: binding.identity_name,
              pathBefore: path,
            },
            tx,
          );
          await finishActivity(tx, id, "done", async () => {
            await audit.record(
              {
                action: "filesv2.retire",
                outcome: "allowed",
                actor: { userId: state.actorId, uid: state.actorName },
                target: { type: "filesv2.directory", id: binding.id, label: path },
                requestId: call.requestId,
                metadata: { historyId: id },
              },
              tx,
            );
          });
        });
        return { id: binding.id, path, state: "complete" };
      });
    },
    async archives(call: UserFilesCall, input: { area: Area; after?: string; q?: string }): Promise<ArchivePage> {
      const actor = call.actor;
      const state = await admin(actor, input.area);
      const q = input.q?.trim() ?? "";
      const rows = await sql<
        Operation[]
      >`SELECT * FROM filesv2.operations WHERE action='archive' AND area=${input.area} AND root=${state.root.name} AND state IN ('pending','complete') AND (${input.after ?? null}::uuid IS NULL OR id>${input.after ?? null}::uuid) AND (${q}='' OR strpos(lower(name),lower(${q}))>0 OR strpos(lower(source),lower(${q}))>0) ORDER BY id LIMIT ${PAGE_SIZE + 1}`;
      const items: ArchiveEntry[] = [];
      for (const op of rows.slice(0, PAGE_SIZE)) {
        let valid = true;
        try {
          operationContained(state.config, op);
        } catch {
          valid = false;
        }
        const pending = op.state === "pending" ? op : await operations.pendingWithin(op.root, op.target!);
        items.push({
          id: op.id,
          area: op.area,
          kind: op.kind,
          name: op.name,
          originalPath: op.source,
          path: op.target!,
          state: op.state === "pending" ? "pending" : "archived",
          createdAt: new Date(op.created_at).toISOString(),
          operationId: pending?.id ?? null,
          canRetry: valid && pending !== null,
          canRestore: valid && op.state === "complete" && !pending,
          canDelete: valid && op.state === "complete" && !pending,
        });
      }
      return { items, next: rows.length > PAGE_SIZE ? rows[PAGE_SIZE - 1]!.id : null };
    },
    async restore(call: UserFilesCall, id: string, input: { confirmPath: string }): Promise<OperationResult> {
      const actor = call.actor;
      const state = await archiveById(actor, id);
      if (input.confirmPath !== state.op.source) throw new FilesError("confirmation_mismatch");
      return locked(state.root.name, async () => {
        const archive = await operations.get(id);
        if (!archive || !["complete", "restored"].includes(archive.state)) throw new FilesError("operation_pending", 409);
        if (archive.state === "restored") return result(archive);
        const current = await deps.identities.reconcile(actor, {
          kind: archive.kind,
          provider: provider(archive.area),
          name: archive.name,
          identityId: archive.base_id ? (await deps.bindings.path(archive.root, archive.source))?.identity_id : undefined,
          signal: AbortSignal.timeout(5_000),
        });
        if (current.state === "unknown") throw new FilesError("identity_unknown", 409);
        if (archive.base_id && current.state === "present" && current.identity.id !== null) {
          const binding = await deps.bindings.path(archive.root, archive.source);
          if (binding && binding.identity_id !== current.identity.id) throw new FilesError("binding_conflict", 409);
        }
        if (current.state !== "present" || !current.eligible) throw new FilesError("identity_incomplete", 409);
        if (
          archive.area === "freeipa" &&
          archive.snapshot &&
          (archive.snapshot.gid !== current.identity.gidNumber ||
            (archive.kind === "users" && archive.snapshot.uid !== current.identity.uidNumber))
        )
          throw new FilesError("ownership_mismatch", 409);
        const pending = await operations.pending(archive.root, archive.target!);
        if (pending) {
          if (pending.action !== "restore") throw new FilesError("operation_pending", 409);
          return perform(state.config, state.root, pending);
        }
        if (await stat(state.root, archive.source)) throw new FilesError("path_conflict", 409);
        return newOperation(
          state.config,
          state.root,
          {
            area: archive.area,
            kind: archive.kind,
            root: archive.root,
            server_url: state.config.url,
            name: archive.name,
            action: "restore",
            source: archive.target!,
            target: archive.source,
            base_id: archive.base_id,
            archive_id: archive.id,
            actor_id: state.actorId,
            actor_name: state.actorName,
            snapshot: await stat(state.root, archive.target!),
          },
          call,
        );
      });
    },
    async adminList(call: UserFilesCall, input: AdminLocator & { after?: string }): Promise<AdminBrowseResult> {
      const actor = call.actor;
      const loc = await location(actor, input);
      const node = await loc.root.stat(loc.target);
      if (!node.directory) throw new FilesError("not_directory");
      const page = await loc.root.list(loc.target, { limit: PAGE_SIZE, after: input.after });
      if (page.items.some((node) => !node.path.startsWith(`${loc.target}/`) || node.path.slice(loc.target.length + 1).includes("/")))
        throw new FilesError("unavailable", 503);
      const versioningEnabled = (await loc.root.info()).versioning.enabled;
      await recordAdminRead(call, loc, node, "list");
      return {
        versioningEnabled,
        area: input.area,
        kind: loc.kind,
        name: loc.name,
        archiveId: loc.archiveId,
        basePath: loc.base,
        path: loc.relative,
        items: page.items.map((node) => ({
          name: node.path.split("/").at(-1)!,
          path: node.path.slice(loc.base.length + 1),
          directory: node.directory,
          size: node.size,
          modified: node.modified,
        })),
        next: page.next ?? null,
      };
    },
    async adminDownload(call: UserFilesCall, input: AdminLocator) {
      const actor = call.actor;
      const loc = await location(actor, input);
      const node = await loc.root.stat(loc.target);
      if (node.directory) throw new FilesError("not_file");
      const lease = await loc.root.directDownload(loc.target, { expiresIn: 60 });
      await recordAdminRead(call, loc, node, "download");
      return { url: lease.url, method: "GET" as const, expires: lease.expires };
    },
    async adminVersions(call: UserFilesCall, input: AdminLocator) {
      const actor = call.actor;
      const loc = await location(actor, input);
      const node = await loc.root.stat(loc.target);
      if (node.directory) throw new FilesError("not_file");
      const versions = (await loc.root.info()).versioning.enabled ? await loc.root.versions(loc.target) : [];
      await recordAdminRead(call, loc, node, "versions");
      return versions.map((version) => ({
        id: version.id,
        created: version.created,
        size: version.size,
        pinned: version.pinned,
        comment: typeof version.metadata?.comment === "string" ? version.metadata.comment : null,
        author: typeof version.metadata?.author === "string" ? version.metadata.author : null,
      }));
    },
    async adminDeleteVersion(call: UserFilesCall, input: AdminLocator & { id: string; confirmPath: string }) {
      const actor = call.actor;
      const loc = await location(actor, input);
      if (input.confirmPath !== loc.target) throw new FilesError("confirmation_mismatch");
      const node = await loc.root.stat(loc.target);
      if (node.directory) throw new FilesError("not_file");
      const info = await loc.root.info();
      if (!info.versioning.enabled) throw new FilesError("versioning_disabled");
      const binding = await deps.bindings.path(loc.root.name, loc.base);
      await fileAction(
        call,
        {
          action: "version.delete",
          serverUrl: loc.config.url,
          root: loc.root.name,
          baseId: binding?.id ?? null,
          itemId: info.stableIds ? node.id : null,
          directory: false,
          name: loc.target.split("/").at(-1)!,
          pathBefore: loc.target,
          pathAfter: loc.target,
          size: node.size,
          revisionBefore: node.revision,
          versionId: input.id,
        },
        () => loc.root.deleteVersion(loc.target, input.id),
        async (tx) => {
          await audit.record(
            {
              action: "filesv2.version.delete",
              outcome: "allowed",
              actor: { userId: loc.actorId },
              target: { type: "filesv2.version", id: input.id, label: loc.target },
              requestId: call.requestId,
              metadata: { root: loc.root.name },
            },
            tx,
          );
        },
      );
      return { deleted: true };
    },
    async adminDelete(call: UserFilesCall, input: AdminLocator & { confirmPath: string }): Promise<OperationResult> {
      const actor = call.actor;
      const loc = await location(actor, input);
      if (input.confirmPath !== loc.target) throw new FilesError("confirmation_mismatch");
      return locked(loc.root.name, async () => {
        let binding = await deps.bindings.path(loc.root.name, loc.base);
        const pending = await operations.pending(loc.root.name, loc.target);
        if (pending) {
          if (pending.action !== "delete") throw new FilesError("operation_pending", 409);
          return perform(loc.config, loc.root, pending);
        }
        const node = await stat(loc.root, loc.target);
        if (!node) throw new FilesError("not_found", 404);
        if (!binding && !loc.archiveId && loc.target === loc.base && node.directory)
          binding = await bindKnown(call, loc.config, { area: input.area, kind: loc.kind, name: loc.name }, node);
        let baseId = binding?.id ?? null;
        if (loc.archiveId) {
          const archived = await operations.get(loc.archiveId);
          baseId = archived?.base_id ?? null;
        }
        return newOperation(
          loc.config,
          loc.root,
          {
            area: input.area,
            kind: loc.kind,
            root: loc.root.name,
            server_url: loc.config.url,
            name: loc.name,
            action: "delete",
            source: loc.target,
            target: null,
            base_id: baseId,
            archive_id: loc.archiveId,
            actor_id: loc.actorId,
            actor_name: loc.actorName,
            snapshot: node,
          },
          call,
        );
      });
    },
    async deleteDirectory(call: UserFilesCall, input: DirectoryTarget & { confirmPath: string }) {
      return this.adminDelete(call, { ...input, path: "", confirmPath: input.confirmPath });
    },
    async deleteArchive(call: UserFilesCall, id: string, input: { confirmPath: string }) {
      const actor = call.actor;
      const state = await archiveById(actor, id);
      return this.adminDelete(call, { area: state.op.area, archiveId: id, path: "", confirmPath: input.confirmPath });
    },
    async retry(call: UserFilesCall, id: string): Promise<OperationResult> {
      const actor = call.actor;
      const operation = await operations.get(id);
      if (!operation) throw new FilesError("not_found", 404);
      const state = await admin(actor, operation.area);
      return locked(operation.root, async () => {
        const current = await operations.get(id);
        if (!current) throw new FilesError("not_found", 404);
        operationContained(state.config, current);
        if (current.state !== "pending") return perform(state.config, state.root, current);
        const binding = await deps.bindings.path(
          current.root,
          basePath(state.config, { area: current.area, kind: current.kind, name: current.name }),
        );
        const identity = await deps.identities.reconcile(actor, {
          kind: current.kind,
          provider: provider(current.area),
          name: current.name,
          identityId: binding?.identity_id,
          signal: AbortSignal.timeout(5_000),
        });
        if (identity.state === "unknown") throw new FilesError("identity_unknown", 409);
        if (binding && identity.state === "present" && identity.identity.id !== null && identity.identity.id !== binding.identity_id)
          throw new FilesError("binding_conflict", 409);
        if (current.action === "create" || current.action === "restore") {
          if (identity.state !== "present" || !identity.eligible) throw new FilesError("identity_incomplete", 409);
          if (
            current.area === "freeipa" &&
            binding &&
            (binding.gid_number !== identity.identity.gidNumber ||
              (current.kind === "users" && binding.uid_number !== identity.identity.uidNumber))
          )
            throw new FilesError("ownership_mismatch", 409);
        }
        const completed = await perform(state.config, state.root, current);
        await audit.recordResultAfterSideEffect({
          action: "filesv2.retry",
          actor: { userId: state.actorId, uid: state.actorName },
          target: { type: "filesv2.operation", id: current.id, label: current.source },
          result: { ok: true, data: completed },
        });
        return completed;
      });
    },
    async refreshRoot(call: UserFilesCall, area: Area): Promise<RootSummary> {
      const actor = call.actor;
      const state = await admin(actor, area);
      await state.root.refreshStats(100_000, AbortSignal.timeout(10 * 60 * 1000));
      await audit.recordResultAfterSideEffect({
        action: "filesv2.refresh_statistics",
        actor: { userId: state.actorId, uid: state.actorName },
        target: { type: "filegate.root", id: state.root.name },
        result: { ok: true, data: { area } },
      });
      return summary(await state.root.info());
    },
    async rebuildRoot(call: UserFilesCall, area: Area): Promise<RootSummary> {
      const actor = call.actor;
      const state = await admin(actor, area);
      if (!(await state.root.info()).index.enabled) throw new FilesError("index_disabled", 409);
      await state.root.rebuild(AbortSignal.timeout(10 * 60 * 1000));
      // Reuse the due-evidence queue and root locks. At most 50 comparisons; the cadence drains the rest.
      await createActivityObservations(deps).maintain({ root: { serverUrl: state.config.url, root: state.root.name } });
      await audit.recordResultAfterSideEffect({
        action: "filesv2.rebuild_index",
        actor: { userId: state.actorId, uid: state.actorName },
        target: { type: "filegate.root", id: state.root.name },
        result: { ok: true, data: { area } },
      });
      return summary(await state.root.info());
    },
    async maintain(input: { signal?: AbortSignal; heartbeat?: () => Promise<void> } = {}): Promise<DirectoryMaintenanceResult> {
      const totals: DirectoryMaintenanceResult = { processed: 0, archived: 0, pending: 0 };
      const config = await deps.readConfiguration();
      if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
      const pending = await sql<
        Operation[]
      >`SELECT * FROM filesv2.operations WHERE state='pending' ORDER BY updated_at,id LIMIT ${PAGE_SIZE}`;
      for (const operation of pending) {
        if (input.signal?.aborted) break;
        await input.heartbeat?.();
        try {
          await sql`UPDATE filesv2.operations SET updated_at=now() WHERE id=${operation.id}::uuid`;
          if (!config[operation.area].enabled) continue;
          await locked(operation.root, () => perform(config, deps.connect(config).root(operation.root), operation, false));
        } catch {
          totals.pending++;
        }
        totals.processed++;
      }
      if (!config.cloud.enabled || !config.cloud.autoArchive) return totals;
      const [cursor] = await sql<{ after_id: string | null }[]>`SELECT after_id FROM filesv2.maintenance WHERE singleton=true`;
      const rows = await sql<
        { id: string; identity_id: string; identity_name: string; kind: BaseKind; root: string; path: string }[]
      >`SELECT id,identity_id,identity_name,kind,root,path FROM filesv2.bases WHERE area='cloud' AND lifecycle='active' AND (${cursor?.after_id ?? null}::uuid IS NULL OR id>${cursor?.after_id ?? null}::uuid) ORDER BY id LIMIT ${PAGE_SIZE}`;
      for (const base of rows) {
        if (input.signal?.aborted) break;
        await input.heartbeat?.();
        try {
          const evidence = await deps.identities.localLifecycle({
            kind: base.kind,
            identityId: base.identity_id,
            name: base.identity_name,
          });
          if (
            evidence.localLinuxEnabled &&
            (evidence.identity.state === "absent" ||
              (base.kind === "groups" &&
                evidence.identity.state === "present" &&
                !evidence.identity.eligible &&
                evidence.identity.identity.id === base.identity_id))
          ) {
            if (
              base.root !== config.cloud.root ||
              base.path !== basePath(config, { area: "cloud", kind: base.kind, name: base.identity_name })
            )
              continue;
            const archived = await locked(base.root, async () => {
              const fresh = await deps.identities.localLifecycle({
                kind: base.kind,
                identityId: base.identity_id,
                name: base.identity_name,
              });
              if (
                !fresh.localLinuxEnabled ||
                !(
                  fresh.identity.state === "absent" ||
                  (base.kind === "groups" &&
                    fresh.identity.state === "present" &&
                    !fresh.identity.eligible &&
                    fresh.identity.identity.id === base.identity_id)
                )
              )
                throw new FilesError("identity_unknown", 409);
              const pending = await operations.pending(base.root, base.path);
              if (pending) {
                if (pending.action !== "archive" || pending.actor_id !== null) throw new FilesError("operation_pending", 409);
                return perform(config, deps.connect(config).root(base.root), pending, false);
              }
              return archiveBound(
                config,
                deps.connect(config).root(base.root),
                { area: "cloud", kind: base.kind, name: base.identity_name },
                base.id,
                null,
                null,
                systemCall("automatic-archive"),
              );
            });
            if (archived.state === "complete") totals.archived++;
            else totals.pending++;
          }
        } catch {
          totals.pending++;
        } finally {
          totals.processed++;
          await sql`INSERT INTO filesv2.maintenance(singleton,after_id) VALUES(true,${base.id}::uuid) ON CONFLICT(singleton) DO UPDATE SET after_id=EXCLUDED.after_id`;
        }
      }
      if (rows.length < PAGE_SIZE && !input.signal?.aborted)
        await sql`INSERT INTO filesv2.maintenance(singleton,after_id) VALUES(true,NULL) ON CONFLICT(singleton) DO UPDATE SET after_id=NULL`;
      return totals;
    },
  };
}
