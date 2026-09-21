import type { RequestActor } from "@k2b/cloud/server";
import { type accountIdentities, audit } from "@k2b/cloud/services";
import { type DirectoryOptions, type Filegate, FilegateError, type Node, type RootClient, type TransferResult } from "@k2b/filegate";
import { sql } from "bun";
import type {
  AdminBrowseResult,
  AdminLocator,
  ArchiveEntry,
  ArchivePage,
  Area,
  BaseKind,
  DirectoryTarget,
  MaintenanceResult,
  OperationResult,
  RootSummary,
} from "../contracts";
import type { bindings, NewBinding } from "../data/bases";
import { type Operation, operations, withRootLock } from "../data/operations";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import { joinPath, relativePath } from "./paths";
import { rootSummary as summary } from "./root-summary";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
type Dependencies = {
  identities: typeof accountIdentities;
  bindings: typeof bindings;
  readConfiguration: typeof readConfiguration;
  connect: (config: Config) => Filegate;
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
async function stat(root: RootClient, path: string): Promise<Node | null> {
  try {
    return await root.stat(path);
  } catch (error) {
    if (error instanceof FilegateError && error.status === 404) return null;
    throw error;
  }
}
const unchanged = (before: Node | null, now: Node) =>
  before !== null &&
  before.directory === now.directory &&
  before.uid === now.uid &&
  before.gid === now.gid &&
  before.mode === now.mode &&
  (before.id ? before.id === now.id : before.modified === now.modified && before.size === now.size);
async function serviceUid(root: RootClient, parent: string): Promise<number> {
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
}
const privateDirectory = async (root: RootClient, path: string) => {
  const node = await root.stat(path);
  const owner = await serviceUid(root, path.split("/").slice(0, -1).join("/") || ".");
  if (!node.directory || node.uid !== owner || (Number.parseInt(node.mode, 8) & 0o077) !== 0)
    throw new FilesError("archive_not_private", 409);
};
async function ensureParents(root: RootClient, path: string, mode: string) {
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
async function verifyCreation(root: RootClient, node: Node, base: NewBinding, daemonUid?: number) {
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
  function operationContained(config: Config, op: Operation) {
    const active = basePath(config, { area: op.area, kind: op.kind, name: op.name });
    if (op.root !== config[op.area].root || op.server_url !== config.url) throw new FilesError("configuration_changed", 409);
    if (op.action === "create" && op.source !== active) throw new FilesError("configuration_changed", 409);
    if (op.action === "archive" && (op.source !== active || !op.target || !archiveTargetContained(config, op.area, op.target)))
      throw new FilesError("configuration_changed", 409);
    if (op.action === "restore" && (op.target !== active || !archiveTargetContained(config, op.area, op.source)))
      throw new FilesError("configuration_changed", 409);
    if (op.action === "delete" && !within(op.source, active) && !op.archive_id) throw new FilesError("configuration_changed", 409);
  }
  async function perform(config: Config, root: RootClient, operation: Operation, allowCreate = true): Promise<OperationResult> {
    operationContained(config, operation);
    if (operation.archive_id) {
      const archived = await operations.get(operation.archive_id);
      if (!archived || archived.action !== "archive") throw new FilesError("not_found", 404);
      operationContained(config, archived);
      if (operation.action === "delete" && !within(operation.source, archived.target!)) throw new FilesError("configuration_changed", 409);
    }
    if (operation.state !== "pending") return result(operation);
    // These callers only issue native same-root moves. An unexpected pending
    // receipt cannot be completed from filesystem appearance on the next run.
    if (operation.error_code === "transfer_pending") throw new FilesError("transfer_pending", 409);
    try {
      if (operation.action === "create") {
        const rows = await sql<
          { uid_number: number | null; gid_number: number | null }[]
        >`SELECT uid_number::float8 AS uid_number,gid_number::float8 AS gid_number FROM filesv2.bases WHERE id=${operation.base_id}::uuid`;
        if (!rows[0]) throw new FilesError("binding_conflict", 409);
        const base: NewBinding = {
          area: operation.area,
          kind: operation.kind,
          identity_id: "",
          identity_name: operation.name,
          root: operation.root,
          path: operation.source,
          ...rows[0],
        };
        let node = await stat(root, operation.source);
        if (!node && !allowCreate) return result(operation);
        await ensureParents(root, operation.source.split("/").slice(0, -1).join("/"), operation.area === "cloud" ? "0700" : "0755");
        const daemonUid =
          operation.area === "freeipa" && operation.kind === "groups"
            ? await serviceUid(root, operation.source.split("/").slice(0, -1).join("/"))
            : undefined;
        if (!node) {
          if (!allowCreate) return result(operation);
          try {
            node = await root.mkdir(operation.source, creationOptions(base, daemonUid));
          } catch (error) {
            node = await stat(root, operation.source);
            if (!node) throw error;
          }
        }
        await verifyCreation(root, node, base, daemonUid);
      } else if (operation.action === "archive" || operation.action === "restore") {
        let movedPath = operation.target!;
        const source = await stat(root, operation.source);
        const target = await stat(root, operation.target!);
        if (source && target) throw new FilesError("path_conflict", 409);
        if (!source && !target) throw new FilesError("not_found", 409);
        if (source) {
          if (!allowCreate) return result(operation);
          if (!unchanged(operation.snapshot, source)) throw new FilesError("source_changed", 409);
          if (operation.action === "archive") {
            const wrapper = operation.target!.split("/").slice(0, -1).join("/");
            await ensureParents(root, wrapper, "0700");
            await privateDirectory(root, wrapper);
          } else
            await ensureParents(root, operation.target!.split("/").slice(0, -1).join("/"), operation.area === "cloud" ? "0700" : "0755");
          let receipt: TransferResult | undefined;
          let answered = false;
          try {
            receipt = await root.transfer(operation.source, operation.root, operation.target!, { move: true, onConflict: "error" });
            answered = true;
          } catch (error) {
            if ((await stat(root, operation.source)) || !(await stat(root, operation.target!))) throw error;
          }
          if (answered) {
            if (receipt?.state !== "completed") throw new FilesError("transfer_pending", 409);
            if (!receipt.node || receipt.node.root !== operation.root || receipt.node.path !== operation.target)
              throw new FilesError("operation_unresolved", 409);
            movedPath = receipt.node.path;
          }
        }
        const moved = await root.stat(movedPath);
        if (!unchanged(operation.snapshot, moved)) throw new FilesError("source_changed", 409);
        if (operation.action === "archive") await privateDirectory(root, operation.target!.split("/").slice(0, -1).join("/"));
      } else {
        const node = await stat(root, operation.source);
        if (node) {
          if (!allowCreate) return result(operation);
          if (!unchanged(operation.snapshot, node)) throw new FilesError("source_changed", 409);
          try {
            await root.remove(operation.source, true);
          } catch (error) {
            if (await stat(root, operation.source)) throw error;
          }
        }
      }
      await operations.finish(operation);
      await audit.recordResultAfterSideEffect({
        action: `filesv2.${operation.action}`,
        actor: { userId: operation.actor_id, uid: operation.actor_name },
        target: { type: "filesv2.directory", id: operation.id, label: operation.source },
        metadata: { area: operation.area, root: operation.root, target: operation.target },
        result: { ok: true, data: { operationId: operation.id } },
      });
      return result({ ...operation, state: "complete" });
    } catch (error) {
      await sql`UPDATE filesv2.operations SET error_code=${error instanceof FilesError ? error.code : "unavailable"},updated_at=now() WHERE id=${operation.id}::uuid`;
      throw error;
    }
  }
  async function newOperation(
    config: Config,
    root: RootClient,
    input: Omit<Operation, "id" | "state" | "error_code" | "created_at" | "updated_at">,
  ): Promise<OperationResult> {
    const pending = await operations.pending(input.root, input.source);
    if (pending) {
      if (pending.action !== input.action || pending.target !== input.target) throw new FilesError("operation_pending", 409);
      return perform(config, root, pending);
    }
    const operation = await operations.insert({ id: crypto.randomUUID(), ...input });
    return perform(config, root, operation);
  }
  async function provisionCandidate(
    config: Config,
    base: NewBinding,
    actorId: string | null,
    actorName: string | null,
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
      return newOperation(config, root, {
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
      });
    });
  }
  async function bindKnown(actor: RequestActor, config: Config, input: DirectoryTarget, node: Node) {
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
    const rows = await deps.bindings.claim(candidate);
    if (rows.length !== 1 || rows[0]!.identity_id !== identity.id || rows[0]!.path !== candidate.path)
      throw new FilesError("binding_conflict", 409);
    return rows[0]!;
  }
  async function archiveDirectory(actor: RequestActor, input: DirectoryTarget & { archivePath?: string }) {
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
        if (node) binding = await bindKnown(actor, state.config, input, node);
      }
      return archiveBound(state.config, state.root, input, binding?.id ?? null, state.actorId, state.actorName);
    });
  }
  async function archiveBound(
    config: Config,
    root: RootClient,
    input: DirectoryTarget & { archivePath?: string },
    baseId: string | null,
    actorId: string | null,
    actorName: string | null,
  ) {
    const source = basePath(config, input);
    const node = await stat(root, source);
    if (!node?.directory) throw new FilesError("not_directory", 409);
    const id = crypto.randomUUID();
    const target = joinPath(archiveParent(config, input.area, input.archivePath ?? config[input.area].archive), id, "contents");
    const operation = await operations.insert({
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
    });
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
  return {
    provisionCandidate,
    async provision(actor: RequestActor, input: { area: Area; kind: BaseKind; identityId: string }) {
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
      return provisionCandidate(state.config, base, state.actorId, state.actorName);
    },
    archive: archiveDirectory,
    async retire(actor: RequestActor, input: DirectoryTarget): Promise<OperationResult> {
      const state = await admin(actor, input.area);
      return locked(state.root.name, async () => {
        const path = basePath(state.config, input);
        const binding = await deps.bindings.path(state.root.name, path);
        if (!binding) throw new FilesError("unassigned", 409);
        if (await operations.pending(state.root.name, path)) throw new FilesError("operation_pending", 409);
        await sql`UPDATE filesv2.bases SET lifecycle='retired' WHERE id=${binding.id}::uuid AND lifecycle='active'`;
        await audit.recordResultAfterSideEffect({
          action: "filesv2.retire",
          actor: { userId: state.actorId, uid: state.actorName },
          target: { type: "filesv2.directory", id: binding.id, label: path },
          result: { ok: true, data: { path } },
        });
        return { id: binding.id, path, state: "complete" };
      });
    },
    async archives(actor: RequestActor, input: { area: Area; after?: string; q?: string }): Promise<ArchivePage> {
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
    async restore(actor: RequestActor, id: string, input: { confirmPath: string }): Promise<OperationResult> {
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
        return newOperation(state.config, state.root, {
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
        });
      });
    },
    async adminList(actor: RequestActor, input: AdminLocator & { after?: string }): Promise<AdminBrowseResult> {
      const loc = await location(actor, input);
      const node = await loc.root.stat(loc.target);
      if (!node.directory) throw new FilesError("not_directory");
      const page = await loc.root.list(loc.target, { limit: PAGE_SIZE, after: input.after });
      if (page.items.some((node) => !node.path.startsWith(`${loc.target}/`) || node.path.slice(loc.target.length + 1).includes("/")))
        throw new FilesError("unavailable", 503);
      return {
        versioningEnabled: (await loc.root.info()).versioning.enabled,
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
    async adminDownload(actor: RequestActor, input: AdminLocator) {
      const loc = await location(actor, input);
      const node = await loc.root.stat(loc.target);
      if (node.directory) throw new FilesError("not_file");
      const lease = await loc.root.directDownload(loc.target, { expiresIn: 60 });
      return { url: lease.url, method: "GET" as const, expires: lease.expires };
    },
    async adminVersions(actor: RequestActor, input: AdminLocator) {
      const loc = await location(actor, input);
      if ((await loc.root.stat(loc.target)).directory) throw new FilesError("not_file");
      if (!(await loc.root.info()).versioning.enabled) return [];
      return (await loc.root.versions(loc.target)).map((version) => ({
        id: version.id,
        created: version.created,
        size: version.size,
        pinned: version.pinned,
        comment: typeof version.metadata?.comment === "string" ? version.metadata.comment : null,
        author: typeof version.metadata?.author === "string" ? version.metadata.author : null,
      }));
    },
    async adminDeleteVersion(actor: RequestActor, input: AdminLocator & { id: string; confirmPath: string }) {
      const loc = await location(actor, input);
      if (input.confirmPath !== loc.target) throw new FilesError("confirmation_mismatch");
      if ((await loc.root.stat(loc.target)).directory) throw new FilesError("not_file");
      if (!(await loc.root.info()).versioning.enabled) throw new FilesError("versioning_disabled");
      await loc.root.deleteVersion(loc.target, input.id);
      return { deleted: true };
    },
    async adminDelete(actor: RequestActor, input: AdminLocator & { confirmPath: string }): Promise<OperationResult> {
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
          binding = await bindKnown(actor, loc.config, { area: input.area, kind: loc.kind, name: loc.name }, node);
        let baseId = binding?.id ?? null;
        if (loc.archiveId) {
          const archived = await operations.get(loc.archiveId);
          baseId = archived?.base_id ?? null;
        }
        return newOperation(loc.config, loc.root, {
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
        });
      });
    },
    async deleteDirectory(actor: RequestActor, input: DirectoryTarget & { confirmPath: string }) {
      return this.adminDelete(actor, { ...input, path: "", confirmPath: input.confirmPath });
    },
    async deleteArchive(actor: RequestActor, id: string, input: { confirmPath: string }) {
      const state = await archiveById(actor, id);
      return this.adminDelete(actor, { area: state.op.area, archiveId: id, path: "", confirmPath: input.confirmPath });
    },
    async retry(actor: RequestActor, id: string): Promise<OperationResult> {
      const operation = await operations.get(id);
      if (!operation) throw new FilesError("not_found", 404);
      const state = await admin(actor, operation.area);
      return locked(operation.root, async () => {
        const current = await operations.get(id);
        if (!current) throw new FilesError("not_found", 404);
        operationContained(state.config, current);
        if (current.state !== "pending") return result(current);
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
    async refreshRoot(actor: RequestActor, area: Area): Promise<RootSummary> {
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
    async rebuildRoot(actor: RequestActor, area: Area): Promise<RootSummary> {
      const state = await admin(actor, area);
      if (!(await state.root.info()).index.enabled) throw new FilesError("index_disabled", 409);
      await state.root.rebuild(AbortSignal.timeout(10 * 60 * 1000));
      await audit.recordResultAfterSideEffect({
        action: "filesv2.rebuild_index",
        actor: { userId: state.actorId, uid: state.actorName },
        target: { type: "filegate.root", id: state.root.name },
        result: { ok: true, data: { area } },
      });
      return summary(await state.root.info());
    },
    async maintain(input: { signal?: AbortSignal; heartbeat?: () => Promise<void> } = {}): Promise<MaintenanceResult> {
      const totals: MaintenanceResult = { processed: 0, archived: 0, pending: 0 };
      const config = await deps.readConfiguration();
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
            await locked(base.root, async () => {
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
                return perform(config, deps.connect(config).root(base.root), pending);
              }
              return archiveBound(
                config,
                deps.connect(config).root(base.root),
                { area: "cloud", kind: base.kind, name: base.identity_name },
                base.id,
                null,
                "automatic-policy",
              );
            });
            totals.archived++;
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
