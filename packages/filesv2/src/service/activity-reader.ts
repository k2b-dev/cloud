import { createHash } from "node:crypto";
import type { RequestActor, resolveDisplayNames } from "@k2b/cloud/server";
import { AccountIdentityError, secrets } from "@k2b/cloud/services";
import { FilegateError, type Node } from "@k2b/filegate";
import { z } from "zod";
import {
  ACTIVITY_CHAIN_LIMIT,
  ACTIVITY_PAGE_LIMIT,
  ACTIVITY_SCAN_LIMIT,
  ACTIVITY_SEARCH_LIMIT,
  ActivityBasesInput,
  type ActivityBasesPage,
  type ActivityBatchContext,
  type ActivityChain,
  type ActivityEntry,
  ActivityInput,
  type ActivityObservation,
  type ActivityPage,
  type ActivitySide,
  HistoryAction,
  MovementChainInput,
  type ShareAccessCounts,
  ShareAccessInput,
} from "../activity-contracts";
import { type ActivityCandidate, type ActivityPosition, activityReaderData, type CandidateInput } from "../data/activity-reader";
import type { Binding, bindings } from "../data/bases";
import type { ShareRow } from "../data/shares";
import type { UserFilesCall } from "./activity";
import { type ActivityReadBudget, withActivityReadBudget } from "./activity-read-budget";
import type { readConfiguration } from "./configuration";
import { FilesError } from "./errors";
import type { FilesFilegate } from "./filegate-facade";
import { relativePath } from "./paths";

export type ActivityReadCall = UserFilesCall & { requestAbort?: AbortSignal };
type Config = Awaited<ReturnType<typeof readConfiguration>>;
/** Structural subset of the owning service's actual authorized() result. */
export type HistoryAccess = {
  state: { config: { url: string } };
  inspection: { binding: Binding | null; summary: { id: string } };
  node: Pick<Node, "id" | "path" | "directory">;
  target: string;
  info: { stableIds?: boolean };
};
export type ActivityReaderDependencies = {
  /** MUST NOT provision, adopt, claim bindings or write observations. Same current membership, execution,
   * ancestor traversal and leaf read checks as authorized(actor, publicBaseId, relativePath).
   * Pass RequestActor unchanged; accessSubject is not an extra group-manager entitlement.
   * 403/404 deny access; operational failures must propagate rather than masquerade as disappearance. */
  requestContext(
    actor: RequestActor,
    budget: ActivityReadBudget,
  ): Promise<{
    userId: string;
    admin: boolean;
    config: Config;
    allowedBindingIds: string[];
    readOnlyAuthorized(publicBaseId: string, path: string): Promise<HistoryAccess>;
  }>;
  bindings: Pick<typeof bindings, "byId">;
  /** Service-scoped identity reads carry the request signal through the transport. */
  connect(config: Config, signal?: AbortSignal): FilesFilegate;
  displayNames: typeof resolveDisplayNames;
  requireAdmin(actor: RequestActor, budget: ActivityReadBudget): Promise<void>;
  canReadShare(actor: RequestActor, creatorId: string | null, budget: ActivityReadBudget): Promise<boolean>;
  shares: { get(id: string): Promise<Pick<ShareRow, "created_by" | "base_id"> | null> };
  /** Default is the real SQL reader. Injection supports focused tests without a database. */
  data?: typeof activityReaderData;
  /** Internal deterministic clock; never accepted from a transport. */
  now?: () => Date;
};
const denied = (error: unknown) =>
  (error instanceof FilesError || error instanceof FilegateError || error instanceof AccountIdentityError) &&
  [403, 404].includes(error.status);
const under = (path: string, ancestor: string) => path === ancestor || ancestor === "" || path.startsWith(`${ancestor}/`);
const publicId = (binding: Pick<Binding, "area" | "kind" | "identity_id">) => `${binding.area}:${binding.kind}:${binding.identity_id}`;
const relativeTo = (path: string, base: string) => (path === base ? "" : path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null);
const hidden: ActivitySide = { visibility: "hidden" };
const observationSchema = z.union([
  z.object({ state: z.literal("unavailable") }),
  z.object({
    exists: z.boolean(),
    directory: z.boolean().optional(),
    id: z.string().optional(),
    size: z.number().nonnegative().optional(),
    revision: z.string().optional(),
  }),
]);
const cursorSchema = z
  .object({
    purpose: z.literal("filesv2-activity"),
    scope: z.string(),
    time: z.string().max(64),
    id: z.uuid(),
    matches: z.number().int().min(0).max(ACTIVITY_SEARCH_LIMIT),
  })
  .strict();
type Projection = {
  directory: boolean;
  effectiveTime: string;
  entry: ActivityEntry;
  bases: { before: string | null; after: string | null };
  relative: { before: string | null; after: string | null };
};
const positionOf = (row: ActivityCandidate): ActivityPosition => ({ time: row.effective_time, id: row.id });
/** Compare instants without losing SQL microseconds (or caller-supplied fractional precision) to Date. */
function compareActivityTime(left: string, right: string): number {
  const seconds = Math.floor(Date.parse(left) / 1000) - Math.floor(Date.parse(right) / 1000);
  if (seconds) return seconds;
  const a = /\.(\d+)/.exec(left)?.[1] ?? "";
  const b = /\.(\d+)/.exec(right)?.[1] ?? "";
  const width = Math.max(a.length, b.length);
  return a.padEnd(width, "0").localeCompare(b.padEnd(width, "0"), "en");
}
function candidateTimeBoundary(value: string | undefined, upper: boolean): string | undefined {
  if (value === undefined) return undefined;
  const hour = 3_600_000;
  const start = Math.floor(Date.parse(value) / hour) * hour;
  // Even a sub-millisecond fraction after an exact hour must round the upper bound outward.
  return new Date(start + (upper && compareActivityTime(value, new Date(start).toISOString()) > 0 ? hour : 0)).toISOString();
}
const versionActions = new Set<HistoryAction>(["version.comment", "version.restore", "version.restore_copy", "version.delete"]);
const disappearanceActions = new Set<HistoryAction>(["item.trash", "item.purge", "place.retire"]);
const movementActions = new Set<HistoryAction>(["item.rename", "item.move", "place.archive", "place.restore"]);
const arrivalActions = new Set<HistoryAction>([
  ...movementActions,
  "folder.create",
  "file.create",
  "file.upload",
  "file.overwrite",
  "item.copy",
  "item.restore",
  "version.restore_copy",
  "place.provision",
]);

/** One request-local projection context; caches never survive a request or a membership change. */
export function createActivityReader(deps: ActivityReaderDependencies) {
  const data = deps.data ?? activityReaderData;
  async function context(call: ActivityReadCall, budget: ActivityReadBudget) {
    const { userId, admin, config, allowedBindingIds, readOnlyAuthorized } = await budget.run(() =>
      deps.requestContext(call.actor, budget),
    );
    // History needs the actual storage configuration, even when candidate scoping would otherwise look empty.
    if (config.unreadable) throw new FilesError("configuration_unreadable", 409);
    const allowed = new Set(allowedBindingIds);
    const scope = { admin, userId, bindingIds: allowedBindingIds, serverUrl: config.url };
    const bindingCache = new Map<string, Promise<Binding | null>>();
    const identityCache = new Map<string, Promise<boolean>>();
    const statCache = new Map<string, Promise<Pick<Node, "id" | "directory"> | null | "denied">>();
    const accessCache = new Map<string, Promise<HistoryAccess | null>>();
    const binding = (id: string | null) => {
      if (!id) return Promise.resolve(null);
      let value = bindingCache.get(id);
      if (!value) {
        value = budget.run(() => deps.bindings.byId(id));
        bindingCache.set(id, value);
      }
      return value;
    };
    const access = (base: Binding, path: string, fresh = false) => {
      const key = JSON.stringify([config.url, base.root, base.id, path]);
      let value = fresh ? undefined : accessCache.get(key);
      if (!value) {
        if (!allowed.has(base.id)) return Promise.resolve(null);
        value = budget
          .run(() => readOnlyAuthorized(publicId(base), path))
          .catch((error: unknown) => {
            if (denied(error)) return null;
            throw error;
          });
        accessCache.set(key, value);
      }
      return value;
    };
    const matches = (current: HistoryAccess | null, base: Binding, target: string) =>
      current !== null &&
      current.state.config.url === config.url &&
      current.inspection.binding?.id === base.id &&
      current.inspection.binding.root === base.root &&
      current.inspection.binding.path === base.path &&
      current.inspection.summary.id === publicId(base) &&
      current.target === target &&
      current.node.path === target;
    async function project(row: ActivityCandidate): Promise<Projection | null> {
      budget.check();
      if (!admin && !allowed.has(row.base_id ?? "") && !allowed.has(row.base_after_id ?? "")) return null;
      const parsed = HistoryAction.safeParse(row.action);
      if (!parsed.success) return null;
      const action = parsed.data;
      async function side(after: boolean): Promise<{ value: ActivitySide; base: string | null; relative: string | null }> {
        const path = after ? row.path_after : row.path_before;
        if (path === null) return { value: hidden, base: null, relative: null };
        const root = after ? (row.root_after ?? row.root) : row.root;
        const baseId = after ? (row.base_after_id ?? (root === row.root ? row.base_id : null)) : row.base_id;
        const itemId = after ? row.item_after_id : row.item_id;
        const base = await binding(baseId);
        const relative = base?.root === root ? relativeTo(path, base.path) : null;
        const basePublicId = base && relative !== null ? publicId(base) : null;
        const name = path.split("/").at(-1) ?? "";
        // A current, already-authorized binding can name an own snapshot's storage without resolving its leaf.
        // This is display metadata only: source stays snapshot; item access/navigation still needs current checks.
        const displayBaseId =
          base &&
          allowed.has(base.id) &&
          base.lifecycle === "active" &&
          relative !== null &&
          row.server_url === config.url &&
          !config.unreadable
            ? basePublicId
            : null;
        const full = (source: "current" | "snapshot"): ActivitySide => {
          const observed = observationSchema.safeParse(after ? row.observed_after : row.observed_before);
          const size = row.size === null ? null : Number(row.size);
          return {
            visibility: "full",
            source,
            name,
            path,
            root,
            baseId,
            publicBaseId: source === "current" ? basePublicId : displayBaseId,
            relativePath: source === "current" || displayBaseId !== null ? relative : null,
            itemId,
            directory: row.directory,
            size: size !== null && Number.isSafeInteger(size) && size >= 0 ? size : null,
            revision: after ? row.revision_after : row.revision_before,
            ...(versionActions.has(action) && row.version_id ? { versionId: row.version_id } : {}),
            ...(source === "current" && observed.success ? { observation: observed.data satisfies ActivityObservation } : {}),
          };
        };
        const minimal = (currentBaseId: string | null = null): ActivitySide => ({
          visibility: "disappearance",
          name,
          path,
          directory: row.metadataUnknown ? null : row.directory,
          publicBaseId: currentBaseId,
          relativePath: currentBaseId === null ? null : relative,
        });
        const invisible = { value: hidden, base: null, relative: null };
        if (!base || base.area !== "cloud" || base.root !== root || relative === null) return invisible;
        if (admin) return { value: row.metadataUnknown ? minimal(displayBaseId) : full("snapshot"), base: publicId(base), relative };
        if (!allowed.has(base.id) || base.lifecycle !== "active" || relative === null || row.server_url !== config.url || config.unreadable)
          return invisible;
        if (row.actor_kind === "user" && row.actor_user_id === userId)
          return { value: row.metadataUnknown ? minimal(basePublicId) : full("snapshot"), base: basePublicId, relative };
        // Storage refines current identity only. Cloud grants already authorize the retained
        // local snapshot; a failed stat must never remove a row after SQL pagination.
        const key = JSON.stringify([row.server_url, root, base.id, path]);
        let stat = statCache.get(key);
        if (!stat) {
          stat = budget
            .run(() => deps.connect(config, budget.signal).root(root).stat(path))
            .catch((error: unknown) => {
              if (error instanceof FilegateError && error.status === 404) return null;
              if (error instanceof FilegateError && error.status === 403) return "denied" as const;
              throw error;
            });
          statCache.set(key, stat);
        }
        const node = await stat;
        if (node === "denied")
          return { value: row.metadataUnknown ? minimal(basePublicId) : full("snapshot"), base: basePublicId, relative };
        let stable = identityCache.get(root);
        if (!stable) {
          stable = budget.run(() => deps.connect(config, budget.signal).root(root).info()).then((info) => info.stableIds === true);
          identityCache.set(root, stable);
        }
        const stableIds = await stable;
        if (node && (!stableIds || !itemId || !node.id || node.id === itemId)) {
          const current = await access(base, relative);
          if (!matches(current, base, path))
            return { value: row.metadataUnknown ? minimal(basePublicId) : full("snapshot"), base: basePublicId, relative };
          if (
            stableIds &&
            itemId &&
            current?.info.stableIds === true &&
            current.node.id === itemId &&
            node.directory === row.directory &&
            !row.metadataUnknown
          )
            return { value: full("current"), base: basePublicId, relative };
          // No stable identity promise means only the disappearance-level fields, even on a readable live leaf.
          return { value: minimal(basePublicId), base: basePublicId, relative };
        }
        return { value: minimal(basePublicId), base: basePublicId, relative };
      }
      const before = await side(false);
      const after = await side(true);
      if (before.value.visibility === "hidden" && after.value.visibility === "hidden") return null;
      const full = before.value.visibility === "full" || after.value.visibility === "full";
      return {
        directory: !row.metadataUnknown && row.directory,
        effectiveTime: row.effective_time,
        bases: { before: before.base, after: after.base },
        relative: { before: before.relative, after: after.relative },
        entry: {
          id: row.id,
          action,
          state: row.state,
          time: new Date(row.effective_time).toISOString(),
          startedAt: row.started_at.toISOString(),
          finishedAt: row.finished_at?.toISOString() ?? null,
          actor: { kind: row.actor_kind, userId: row.actor_user_id, name: null },
          via: row.via,
          before: before.value,
          after: after.value,
          batchId: row.batch_id,
          ...(full && (action === "share.create" || action === "share.revoke")
            ? { share: { expiresAt: row.share_expires_at?.toISOString() ?? null } }
            : {}),
          ...(full
            ? { execution: { invocationId: row.invocation_id, requestId: row.request_id, callingApp: row.calling_app, origin: row.origin } }
            : {}),
        },
      };
    }
    return { project, access, matches, binding, config, scope, budget };
  }
  async function names(items: Pick<ActivityEntry, "actor">[], budget: ActivityReadBudget) {
    budget.check();
    if (!items.length) return;
    const ids = [...new Set(items.flatMap((row) => (row.actor.userId ? [row.actor.userId] : [])))];
    const resolved = await budget.run(() => deps.displayNames(ids.map((userId) => ({ principal: { type: "user" as const, userId } }))));
    const byId = new Map(
      resolved.flatMap((row) => (row.principal.type === "user" ? [[row.principal.userId, row.displayName ?? null] as const] : [])),
    );
    for (const row of items) row.actor.name = row.actor.userId ? (byId.get(row.actor.userId) ?? null) : null;
  }
  function filter(row: Projection, input: z.output<typeof ActivityInput>): boolean {
    if (
      (input.from && compareActivityTime(row.effectiveTime, input.from) < 0) ||
      (input.to && compareActivityTime(row.effectiveTime, input.to) > 0)
    )
      return false;
    if ((input.actor && row.entry.actor.userId !== input.actor) || (input.action && row.entry.action !== input.action)) return false;
    const sides = (["before", "after"] as const).filter((side) => {
      const value = row.entry[side];
      if (value.visibility === "hidden" || (input.baseId && row.bases[side] !== input.baseId)) return false;
      if (input.itemId && (value.visibility !== "full" || value.itemId !== input.itemId)) return false;
      if (input.path !== undefined) {
        const path = row.relative[side];
        if (path === null) return false;
        const ancestorMove =
          row.entry[side].visibility !== "hidden" && movementActions.has(row.entry.action) && row.directory && under(input.path, path);
        if (!(input.scope === "folder" ? under(path, input.path) || ancestorMove : path === input.path || ancestorMove)) return false;
      }
      return true;
    });
    if (!sides.length) return false;
    if (!input.q) return true;
    const q = input.q.toLocaleLowerCase("en");
    return sides.some((side) => {
      const value = row.entry[side];
      if (value.visibility === "hidden") return false;
      const path = value.path.toLocaleLowerCase("en");
      const relative = row.relative[side]?.toLocaleLowerCase("en");
      // A moved ancestor is evidence for an old descendant path, never a lexical prefix collision.
      const descendant =
        side === "before" &&
        movementActions.has(row.entry.action) &&
        row.directory &&
        (q.startsWith(`${path}/`) || (relative !== undefined && q.startsWith(`${relative}/`)));
      return value.name.toLocaleLowerCase("en").includes(q) || path.includes(q) || descendant;
    });
  }
  return {
    async adminActivityBases(call: ActivityReadCall & { locale?: string }, rawInput: ActivityBasesInput = {}): Promise<ActivityBasesPage> {
      const parsed = ActivityBasesInput.safeParse(rawInput);
      if (!parsed.success) throw new FilesError("invalid_activity_filter", 400);
      const input = parsed.data;
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        await budget.run(() => deps.requireAdmin(call.actor, budget));
        if (input.baseId?.startsWith("freeipa:")) throw new FilesError("history_unavailable", 409);
        const items: ActivityBasesPage["items"] = [];
        let after = input.after;
        let scanned = 0;
        do {
          const page = await data.activityBases(after, ACTIVITY_PAGE_LIMIT, budget, {
            baseId: input.baseId,
            bindingIds: input.bindingIds?.split(","),
          });
          if (!page.items.length) return { items, next: null };
          const resolved = await budget.run(() =>
            deps.displayNames(
              [...new Map(page.items.map((base) => [publicId(base), base])).values()].map((base) => ({
                id: publicId(base),
                principal:
                  base.kind === "users"
                    ? { type: "user" as const, userId: base.identity_id }
                    : { type: "group" as const, groupId: base.identity_id },
              })),
            ),
          );
          const names = new Map(resolved.map((entry) => [entry.id, entry.displayName]));
          for (const base of page.items) {
            scanned++;
            after = base.id;
            const id = publicId(base);
            const name =
              names.get(id) ||
              (base.kind === "users" ? (call.locale?.startsWith("de") ? "Gelöschtes Konto" : "Deleted account") : base.identity_name);
            if (!input.q || `${name} ${id}`.toLocaleLowerCase("en").includes(input.q.toLocaleLowerCase("en")))
              items.push({
                id,
                bindingId: base.id,
                area: base.area,
                kind: base.kind,
                name,
                displayName: names.get(id) || null,
                root: base.root,
                path: base.path,
              });
            if (items.length === ACTIVITY_PAGE_LIMIT || scanned === ACTIVITY_SCAN_LIMIT)
              return { items, next: after === page.items.at(-1)!.id ? page.next : after };
          }
          if (!page.next) return { items, next: null };
          after = page.next;
        } while (scanned < ACTIVITY_SCAN_LIMIT);
        return { items, next: after ?? null };
      });
    },
    async activityEntry(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityEntry> {
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        const id = z.uuid().parse(input.activityId);
        const current = await context(call, budget);
        const row = await budget.run(() => data.byId(id, budget));
        const projected = row ? await current.project(row) : null;
        if (!projected) throw new FilesError("not_found", 404);
        await names([projected.entry], budget);
        return projected.entry;
      });
    },
    async activityBatchContext(call: ActivityReadCall, input: { activityId: string }): Promise<ActivityBatchContext> {
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        const id = z.uuid().parse(input.activityId);
        const current = await context(call, budget);
        const anchor = await budget.run(() => data.byId(id, budget));
        const projected = anchor ? await current.project(anchor) : null;
        const batchId = anchor?.batch_id;
        // Missing, denied and unbatched anchors share one opaque response. Never accept a caller's batch ID.
        if (!projected || !batchId) throw new FilesError("not_found", 404);
        const limit = ACTIVITY_SCAN_LIMIT - 1;
        const peers = await budget.run(() =>
          data.candidates({ scope: current.scope, batch: { id: batchId, anchorId: id }, position: null, direction: "desc", limit }, budget),
        );
        let visibleCount = 1;
        for (const peer of peers) if (await current.project(peer)) visibleCount++;
        budget.check();
        return { visibleCount, complete: peers.length < limit };
      });
    },
    async activity(call: ActivityReadCall, rawInput: ActivityInput = {}): Promise<ActivityPage> {
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        const input = ActivityInput.parse(rawInput);
        if (input.path !== undefined) relativePath(input.path);
        if ((input.path !== undefined && !input.baseId) || (input.from && input.to && compareActivityTime(input.from, input.to) > 0))
          throw new FilesError("invalid_activity_filter");
        // Bind to identity, not request-specific invocation IDs or live display names. Rights are rechecked on every page.
        const cursorActor =
          call.actor.kind === "user"
            ? { kind: call.actor.kind, userId: call.actor.user.id, sessionKind: call.actor.sessionKind }
            : { kind: call.actor.kind, serviceAccountId: call.actor.serviceAccount.id, userId: call.actor.delegatedUser?.id ?? null };
        const scope = createHash("sha256")
          .update(JSON.stringify([cursorActor, call.accessSubject, { ...input, cursor: undefined, limit: undefined }]))
          .digest("hex");
        let position: ActivityPosition | null = null;
        let matches = 0;
        if (input.cursor) {
          try {
            const cursor = cursorSchema.parse(await budget.run(() => secrets.decrypt(input.cursor!)));
            if (cursor.scope !== scope || !Number.isFinite(Date.parse(cursor.time))) throw new Error("foreign cursor");
            position = { time: cursor.time, id: cursor.id };
            matches = cursor.matches;
          } catch {
            budget.check();
            throw new FilesError("invalid_cursor");
          }
        }
        const current = await context(call, budget);
        if (input.baseId?.startsWith("freeipa:")) throw new FilesError("history_unavailable", 409);
        const rows =
          matches >= ACTIVITY_SEARCH_LIMIT && input.q
            ? []
            : await budget.run(() =>
                data.candidates(
                  {
                    position,
                    direction: "desc",
                    limit: ACTIVITY_SCAN_LIMIT,
                    // Only coarse UTC windows shape candidate scans. Exact filters stay in the cursor scope
                    // above and run on authorized projections, before page/search limits count a match.
                    from: candidateTimeBoundary(input.from, false),
                    to: candidateTimeBoundary(input.to, true),
                    scope: current.scope,
                    baseId: input.baseId,
                  },
                  budget,
                ),
              );
        const items: ActivityEntry[] = [];
        let consumed = 0;
        for (const row of rows) {
          budget.check();
          consumed++;
          position = positionOf(row);
          const projected = await current.project(row);
          if (!projected || !filter(projected, input)) continue;
          items.push(projected.entry);
          matches++;
          if (items.length >= input.limit || (input.q && matches >= ACTIVITY_SEARCH_LIMIT)) break;
        }
        await names(items, budget);
        const exhausted = consumed === rows.length && rows.length < ACTIVITY_SCAN_LIMIT;
        const searchLimitReached = !!input.q && matches >= ACTIVITY_SEARCH_LIMIT;
        const scanLimitReached = consumed === ACTIVITY_SCAN_LIMIT && items.length < input.limit && !searchLimitReached;
        const next =
          !exhausted && !searchLimitReached && position
            ? await budget.run(() => secrets.encrypt({ purpose: "filesv2-activity", scope, ...position, matches: input.q ? matches : 0 }))
            : null;
        const batches = new Map<string, number>();
        for (const item of items) if (item.batchId) batches.set(item.batchId, (batches.get(item.batchId) ?? 0) + 1);
        return {
          items,
          next,
          visibleCount: items.length,
          batches: [...batches].map(([id, visibleCount]) => ({ id, visibleCount })),
          exhausted,
          scanLimitReached,
          searchLimitReached,
        };
      });
    },
    async shareAccess(call: ActivityReadCall, rawInput: ShareAccessInput): Promise<ShareAccessCounts> {
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        const input = ShareAccessInput.parse(rawInput);
        const share = await budget.run(() => deps.shares.get(input.shareId));
        if (!share || !(await budget.run(() => deps.canReadShare(call.actor, share.created_by, budget))))
          throw new FilesError("not_found", 404);
        const base = await budget.run(() => deps.bindings.byId(share.base_id));
        if (base?.area !== "cloud") throw new FilesError("history_unavailable", 409);
        const current = await context(call, budget);
        if (!current.scope.admin && !current.scope.bindingIds.includes(base.id)) throw new FilesError("not_found", 404);
        return budget.run(() => data.shareAccess(input, { now: deps.now?.(), budget }));
      });
    },
    async movementChain(call: ActivityReadCall, raw: MovementChainInput): Promise<ActivityChain> {
      return withActivityReadBudget(call.requestAbort, async (budget) => {
        const input = MovementChainInput.parse(raw);
        const id = input.activityId;
        const current = await context(call, budget);
        const source = await budget.run(() => data.byId(id, budget));
        const projected = source ? await current.project(source) : null;
        if (!source || !projected) throw new FilesError("not_found", 404);
        const result: ActivityChain = {
          sourceId: id,
          hops: [],
          endpoint: null,
          certainty: "unavailable",
          historyComplete: false,
          truncated: false,
        };
        // Copy has its own destination identity and never continues the source's movement chain.
        if (!movementActions.has(projected.entry.action) || projected.entry.state !== "done" || source.metadataUnknown) return result;
        let entry = projected.entry;
        let path = source.path_after;
        let root = source.root_after ?? source.root;
        let baseId = source.base_after_id ?? source.base_id;
        let suffix = "";
        if (input.oldPath !== undefined) {
          const before = entry.before;
          const base = await current.binding(source.base_id);
          // Snapshot display metadata can scope an address, but can never establish live access.
          // Never guess a base prefix from a basename or from a root-relative path suffix.
          if (
            before.visibility === "hidden" ||
            before.relativePath == null ||
            !base ||
            base.lifecycle !== "active" ||
            base.root !== source.root ||
            before.publicBaseId !== publicId(base) ||
            source.server_url !== current.config.url ||
            relativeTo(source.path_before ?? "", base.path) !== before.relativePath ||
            !under(input.oldPath, before.relativePath)
          )
            throw new FilesError("not_found", 404);
          if (input.oldPath !== before.relativePath) {
            if (!source.directory) throw new FilesError("not_found", 404);
            suffix = `/${input.oldPath.slice(before.relativePath ? before.relativePath.length + 1 : 0)}`;
          }
        }
        // An ancestor's stable ID identifies that folder, never the descendant opened under its old address.
        // Keep suffix-derived chains path-only throughout, including after later exact child moves.
        const itemId = suffix ? null : (source.item_after_id ?? source.item_id);
        if (path === null || entry.after.visibility === "hidden") return result;
        if (suffix) path = path ? path + suffix : suffix.slice(1);
        result.hops.push({
          activityId: entry.id,
          time: entry.time,
          actor: entry.actor,
          via: entry.via,
          before: entry.before,
          after: entry.after,
        });
        let chainPosition = positionOf(source);
        let scanned = 0;
        while (scanned < ACTIVITY_SCAN_LIMIT) {
          budget.check();
          const chain: NonNullable<CandidateInput["chain"]> = { serverUrl: source.server_url, root, baseId, path };
          const rows = await budget.run(() =>
            data.candidates(
              {
                position: chainPosition,
                direction: "asc",
                limit: 1,
                scope: current.scope,
                chain,
              },
              budget,
            ),
          );
          const candidate = rows[0];
          if (!candidate) break;
          scanned++;
          chainPosition = positionOf(candidate);
          if (candidate.state !== "done" || candidate.server_url !== source.server_url) continue;
          const action = HistoryAction.safeParse(candidate.action);
          const afterRoot = candidate.root_after ?? candidate.root;
          const afterBase = candidate.base_after_id ?? (afterRoot === candidate.root ? candidate.base_id : null);
          const atDestination =
            afterRoot === root &&
            afterBase === baseId &&
            candidate.path_after !== null &&
            (candidate.path_after === path || ((candidate.directory || candidate.metadataUnknown) && under(path, candidate.path_after)));
          if (atDestination && action.success && arrivalActions.has(action.data)) {
            // A copied/moved-in item or recreated ancestor starts another lifetime. A write that
            // records the same identity on both sides leaves the existing lifetime intact.
            const samePlace =
              candidate.root === afterRoot && candidate.base_id === afterBase && candidate.path_before === candidate.path_after;
            const sameIdentity = candidate.item_id !== null && candidate.item_id === candidate.item_after_id;
            const knownEndpoint = candidate.path_after === path && itemId !== null && candidate.item_after_id === itemId;
            if (
              !knownEndpoint &&
              !(samePlace && sameIdentity && (candidate.path_after !== path || !itemId || candidate.item_id === itemId))
            ) {
              result.truncated = true;
              break;
            }
          }
          if (candidate.root !== root || candidate.base_id !== baseId || candidate.path_before === null) continue;
          const exact = candidate.path_before === path;
          const ancestor = (candidate.metadataUnknown || candidate.directory) && under(path, candidate.path_before);
          if (!exact && !ancestor) continue;
          if (action.success && !movementActions.has(action.data) && !disappearanceActions.has(action.data)) continue;
          // A conflicting identity or a deletion creates a gap; do not jump across it.
          if (exact && itemId && candidate.item_id !== itemId) {
            result.truncated = true;
            break;
          }
          if (!action.success || !movementActions.has(action.data) || candidate.metadataUnknown) {
            result.truncated = true;
            break;
          }
          const next = await current.project(candidate);
          if (!next || next.entry.after.visibility === "hidden" || candidate.path_after === null) {
            result.truncated = true;
            break;
          }
          if (result.hops.length >= ACTIVITY_CHAIN_LIMIT) {
            result.truncated = true;
            break;
          }
          const suffix = path.slice(candidate.path_before.length);
          path = candidate.path_after + suffix;
          root = candidate.root_after ?? candidate.root;
          baseId = candidate.base_after_id ?? candidate.base_id;
          entry = next.entry;
          result.hops.push({
            activityId: entry.id,
            time: entry.time,
            actor: entry.actor,
            via: entry.via,
            before: entry.before,
            after: entry.after,
          });
        }
        if (scanned === ACTIVITY_SCAN_LIMIT) result.truncated = true;
        await names(
          result.hops.map((hop) => ({ actor: hop.actor })),
          budget,
        );
        if (result.truncated && !itemId) return result;
        const base = await current.binding(baseId);
        if (
          !base ||
          base.lifecycle !== "active" ||
          base.root !== root ||
          source.server_url !== current.config.url ||
          current.config.unreadable
        )
          return result;
        // Even own saved snapshots do not authorize resolving or exposing a new location.
        const baseAccess = await current.access(base, "");
        if (!current.matches(baseAccess, base, base.path) || !baseAccess?.node.directory) return result;
        if (itemId) {
          if (!baseAccess.info.stableIds) return result;
          try {
            const resolved = await budget.run(() => deps.connect(current.config, budget.signal).root(root).resolve(itemId));
            if (resolved.id !== itemId || resolved.directory !== source.directory) return result;
            path = resolved.path;
          } catch (error) {
            if (error instanceof FilegateError && [400, 403, 404, 409].includes(error.status)) return result;
            throw error;
          }
        }
        const relative = relativeTo(path, base.path);
        if (relative === null) return result;
        const endpoint = await current.access(base, relative, true);
        if (!current.matches(endpoint, base, path) || (itemId && endpoint?.node.id !== itemId)) return result;
        result.endpoint = { baseId: publicId(base), path: relative, itemId };
        result.certainty = itemId ? "verified" : "probable";
        return result;
      });
    },
  };
}
