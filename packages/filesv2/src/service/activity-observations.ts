import { createHash } from "node:crypto";
import { logger } from "@k2b/cloud/services";
import { FilegateError, type Node, type RootInfo } from "@k2b/filegate";
import {
  claimObservationRetries,
  type Finding,
  type KnownActivity,
  knownIdentityActivity,
  type ObservationTarget,
  observationBinding,
  observationBlocked,
  observationChecked,
  observationDestination,
  observationFailed,
  observationObsolete,
  recordObservation,
} from "../data/activity-observations";
import type { Binding } from "../data/bases";
import { withRootLock } from "../data/operations";
import type { readConfiguration } from "./configuration";
import type { FilesFilegate, FilesRoot } from "./filegate-facade";
import { joinPath } from "./paths";

type Config = Awaited<ReturnType<typeof readConfiguration>>;
const log = logger("filesv2:observations");
const absent = (error: unknown) => error instanceof FilegateError && error.status === 404 && error.code === "not_found";
const stateOf = (node: Node) => ({
  exists: true as const,
  directory: node.directory,
  size: node.size,
  ...(node.id ? { id: node.id } : {}),
  ...(node.revision ? { revision: node.revision } : {}),
});

/** Config drift is not absence. Retired/archived/deleted claims cannot be reopened by contact. */
export function observationBindingMatches(config: Config, binding: Binding, target: ObservationTarget): boolean {
  const area = config[binding.area];
  return (
    !config.unreadable &&
    config.url === target.serverUrl &&
    area.enabled &&
    area.root === target.root &&
    binding.lifecycle === "active" &&
    binding.id === target.baseId &&
    binding.root === target.root &&
    binding.path === joinPath(area.prefix, binding.kind === "users" ? area.homes : area.groups, binding.identity_name) &&
    (target.path === binding.path || target.path.startsWith(`${binding.path}/`))
  );
}

/** Never use mtime/ctime as a change time. Revisionless equal-size changes may be undetectable. */
export function compareActivity(known: KnownActivity, node: Node, info: RootInfo): Finding | null {
  if (node.root !== known.root || node.path !== known.path || node.directory !== known.directory) return null;
  if (known.item_id && (!info.stableIds || node.id !== known.item_id)) return null;
  if (info.stableIds && !known.item_id) return null;
  if (known.directory || (known.revision !== null && !node.revision)) return null;
  if ((known.revision !== null && node.revision !== known.revision) || (known.size !== null && String(node.size) !== known.size))
    return { action: "item.differs", path: node.path, state: stateOf(node) };
  return null;
}

/** Reads only: the façade deliberately supplies no mutation surface here. */
export async function inspectActivity(
  known: KnownActivity,
  root: Pick<FilesRoot, "info" | "stat" | "resolve">,
  signal?: AbortSignal,
): Promise<Finding | null> {
  signal?.throwIfAborted();
  const info = await root.info();
  signal?.throwIfAborted();
  if (info.name !== known.root || (known.item_id !== null) !== info.stableIds || info.index.rebuilding) return null;
  let node: Node | null = null;
  try {
    node = await root.stat(known.path);
  } catch (error) {
    if (!absent(error)) throw error;
  }
  signal?.throwIfAborted();
  if (node && (!known.item_id || node.id === known.item_id)) return compareActivity(known, node, info);
  // A replacement identity is never the new baseline for the old element.
  if (known.item_id && info.stableIds) {
    try {
      const resolved = await root.resolve(known.item_id);
      signal?.throwIfAborted();
      if (resolved.root !== known.root || resolved.id !== known.item_id || resolved.directory !== known.directory) return null;
      if (resolved.path === known.path) return null; // Raced a restore/recreate; wait for another contact.
      return { action: "item.elsewhere", path: resolved.path, state: stateOf(resolved) };
    } catch (error) {
      if (!absent(error)) throw error;
    }
  }
  signal?.throwIfAborted();
  // A removed/unavailable root is never a missing element.
  const stillThere = await root.info();
  signal?.throwIfAborted();
  if (
    stillThere.name !== known.root ||
    stillThere.stableIds !== info.stableIds ||
    stillThere.managed !== info.managed ||
    stillThere.index.rebuilding
  )
    return null;
  return { action: "item.missing", path: null, state: { exists: false } };
}

export function observationKey(known: KnownActivity, finding: Finding): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        known.id,
        known.server_url,
        known.root,
        known.base_id,
        known.item_id ?? known.path,
        finding.action,
        finding.path,
        finding.state,
      ]),
    )
    .digest("hex");
}

export function createActivityObservations(deps: {
  readConfiguration: typeof readConfiguration;
  connect: (config: Config) => FilesFilegate;
  now?: () => Date;
}) {
  const now = () => deps.now?.() ?? new Date();
  async function check(
    target: ObservationTarget,
    options: { signal?: AbortSignal; underRootLock?: boolean; evidence?: KnownActivity } = {},
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    const run = async () => {
      options.signal?.throwIfAborted();
      const config = await deps.readConfiguration();
      // An unreadable setting is temporary unavailability, not evidence that a baseline is obsolete.
      if (config.unreadable) return false;
      const binding = await observationBinding(target);
      if (!binding || !observationBindingMatches(config, binding, target)) {
        if (options.evidence) await observationObsolete(options.evidence.id);
        return false;
      }
      const known = await knownIdentityActivity({ ...target, stableId: target.stableId ?? options.evidence?.item_id ?? undefined });
      if (!known || (options.evidence && options.evidence.id !== known.id)) {
        if (options.evidence) await observationObsolete(options.evidence.id);
        return false; // No initial read baseline, including after retention/history loss.
      }
      const source = { serverUrl: known.server_url, root: known.root, baseId: known.base_id, path: known.path };
      const sourceBinding = await observationBinding(source);
      if (!sourceBinding || !observationBindingMatches(config, sourceBinding, source)) {
        if (options.evidence) await observationObsolete(options.evidence.id);
        return false;
      }
      if ((await observationBlocked(target)) || (await observationBlocked(source))) return false;
      try {
        const finding = await inspectActivity(known, deps.connect(config).root(source.root), options.signal);
        options.signal?.throwIfAborted();
        // Do not record a root/binding/config change that happened during the reads.
        const latestConfig = await deps.readConfiguration();
        for (const endpoint of [target, source]) {
          const latestBinding = await observationBinding(endpoint);
          if (!latestBinding || !observationBindingMatches(latestConfig, latestBinding, endpoint)) return false;
        }
        if (finding?.path) {
          const endpoint = { ...source, path: finding.path };
          const destination = await observationDestination(endpoint);
          if (!destination || !observationBindingMatches(latestConfig, destination, { ...endpoint, baseId: destination.id })) return false;
        }
        // Contact identity was authorized at target; do not follow a subsequent move during this comparison.
        if (target.stableId && finding?.path && finding.path !== target.path) return false;
        if (finding) {
          const info = await deps.connect(latestConfig).root(source.root).info();
          if (info.name !== source.root || info.index.rebuilding || info.stableIds !== (known.item_id !== null)) return false;
        }
        options.signal?.throwIfAborted();
        const recorded = finding
          ? await recordObservation(source, known, finding, observationKey(known, finding), now(), options.signal)
          : false;
        await observationChecked(known.id, now());
        return recorded;
      } catch (error) {
        if (!options.signal?.aborted) {
          await observationFailed(known.id, now()).catch((failure) =>
            log.error("Observation retry could not be recorded", { activityId: known.id, error: failure }),
          );
          log.error("History observation failed", { activityId: known.id, error });
        }
        throw error;
      }
    };
    // An untouched object has no comparison to order, and must never acquire a read baseline.
    if (!options.evidence && !(await knownIdentityActivity(target))) return false;
    options.signal?.throwIfAborted();
    // The existing root lock also orders contact against Cloud namespace/content publication.
    return options.underRootLock ? run() : withRootLock(target.root, run, options.signal);
  }
  async function maintain(input: {
    now?: Date;
    signal?: AbortSignal;
    heartbeat?: () => Promise<void>;
    root?: { serverUrl: string; root: string };
  }) {
    input.signal?.throwIfAborted();
    const rows = await claimObservationRetries(input.now ?? now(), input.root);
    let checked = 0;
    let failed = 0;
    for (const row of rows) {
      input.signal?.throwIfAborted();
      await input.heartbeat?.();
      input.signal?.throwIfAborted();
      try {
        await check(
          { serverUrl: row.server_url, root: row.root, baseId: row.base_id, path: row.path },
          { signal: input.signal, evidence: row },
        );
        checked++;
      } catch (error) {
        input.signal?.throwIfAborted();
        // Configuration/lock/SQL failures can happen before check found its evidence row.
        await observationFailed(row.id, input.now ?? now()).catch((failure) =>
          log.error("Observation retry could not be recorded", { activityId: row.id, error: failure }),
        );
        log.error("History observation retry failed", { activityId: row.id, error });
        failed++;
      }
    }
    return { checked, failed };
  }
  return { check, maintain };
}
