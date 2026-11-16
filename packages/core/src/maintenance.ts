import { listAppsDetailed, readAppRegistrySnapshot } from "@k2b/cloud";
import {
  MAINTENANCE_MESSAGE_MAX_LENGTH,
  type MaintenanceBusyApp,
  type MaintenanceOnInput,
  type MaintenanceState,
  type MaintenanceStatus,
  normalizeMaintenanceMessage,
  type QuietReport,
  quietGeneration,
} from "@k2b/cloud/contracts/maintenance";
import { hasRole, type User } from "@k2b/cloud/contracts/shared";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { audit } from "@k2b/cloud/services";
import {
  clearMaintenanceState,
  type ObservedMaintenance,
  readMaintenanceState,
  readQuietReports,
  writeMaintenanceState,
} from "@k2b/cloud/services/maintenance-state";
import { listKnownApps } from "./known-apps";

/**
 * Whole-Cloud maintenance switch. Core owns every write; the gateway only
 * reads the state. The check here is the authority: the route guard alone is
 * not enough, so a skipped guard still cannot switch the Cloud off.
 */

type Store = {
  read: () => Promise<ObservedMaintenance | null>;
  write: (state: MaintenanceState) => Promise<void>;
  clear: () => Promise<void>;
};

/** Apps the operator expects (Core's catalogue without removed listings) against apps registered right now. */
export const readAppsReady = async (): Promise<MaintenanceStatus["apps"]> => {
  const [known, { apps }] = await Promise.all([listKnownApps(), readAppRegistrySnapshot()]);
  const live = new Set(apps.map((app) => app.id));
  const expected = new Set([...known.filter((app) => !app.hidden).map((app) => app.id), ...live]);
  const starting = [...expected].filter((id) => !live.has(id)).sort();
  return { ready: expected.size - starting.length, total: expected.size, starting };
};

type QuietApp = { id: string; name: string; instances?: { instanceId: string }[] };

/**
 * Stage „Ruhe“ per running app: quiet when every live instance reports no
 * work in flight for `generation`. An instance without such a report (not
 * yet applied, its report expired, or a report of an earlier stage „Ruhe“)
 * keeps its app from counting as quiet.
 */
export const summarizeQuiet = (
  apps: readonly QuietApp[],
  allReports: readonly QuietReport[],
  generation: string,
): NonNullable<MaintenanceStatus["quiet"]> => {
  const reports = allReports.filter((report) => report.generation === generation);
  const byInstance = new Map(reports.map((report) => [report.instanceId, report]));
  const busy: MaintenanceBusyApp[] = [];
  let quiet = 0;
  for (const app of [...apps].sort((a, b) => a.id.localeCompare(b.id))) {
    const instances = app.instances?.length
      ? app.instances.map(({ instanceId }) => byInstance.get(instanceId))
      : reports.filter((report) => report.appId === app.id);
    let inFlight = 0;
    let unreported = 0;
    for (const report of instances.length ? instances : [undefined]) {
      if (report && report.appId === app.id) inFlight += report.inFlight;
      else unreported += 1;
    }
    if (inFlight === 0 && unreported === 0) quiet += 1;
    else busy.push({ id: app.id, name: app.name, inFlight, unreported });
  }
  return { quiet, total: apps.length, busy };
};

/** Read without Postgres: the registry and one snapshot of the quiesce reports. */
export const readQuiet = async (state: MaintenanceState): Promise<NonNullable<MaintenanceStatus["quiet"]>> => {
  const [apps, reports] = await Promise.all([listAppsDetailed(), readQuietReports()]);
  return summarizeQuiet(apps, reports, quietGeneration(state));
};

const randomKey = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

const iso = (epochMs: number | undefined) => (epochMs === undefined ? undefined : new Date(epochMs).toISOString());

const view = (
  state: MaintenanceState | null,
  apps: MaintenanceStatus["apps"],
  quiet: MaintenanceStatus["quiet"] | undefined,
): MaintenanceStatus =>
  state
    ? {
        active: true,
        startedAt: iso(state.startedAt),
        startedBy: state.startedBy,
        ...(state.message ? { message: state.message } : {}),
        ...(state.until ? { until: iso(state.until) } : {}),
        quiesce: state.quiesce,
        ...(state.quiesce && quiet ? { quiet } : {}),
        apps,
      }
    : { active: false, apps };

export const createMaintenanceService = ({
  store = { read: readMaintenanceState, write: writeMaintenanceState, clear: clearMaintenanceState },
  appsReady = readAppsReady,
  quietReady = readQuiet,
  record = audit.record,
  now = Date.now,
}: {
  store?: Store;
  appsReady?: () => Promise<MaintenanceStatus["apps"]>;
  quietReady?: (state: MaintenanceState) => Promise<NonNullable<MaintenanceStatus["quiet"]>>;
  record?: typeof audit.record;
  now?: () => number;
} = {}) => {
  const requireAdmin = (actor: User | undefined): actor is User => !!actor && hasRole(actor, "admin");

  const parseUntil = (value: string): Result<number> => {
    const until = Date.parse(value);
    if (!Number.isFinite(until)) return fail(err.badInput("until must be an ISO date-time"));
    if (until <= now()) return fail(err.badInput("until must be in the future"));
    return ok(until);
  };

  const status = async (actor: User | undefined): Promise<Result<MaintenanceStatus>> => {
    if (!requireAdmin(actor)) return fail(err.forbidden("Administrator access required"));
    const [observed, apps] = await Promise.all([store.read(), appsReady()]);
    const state = observed?.state ?? null;
    return ok(view(state, apps, state?.quiesce ? await quietReady(state) : undefined));
  };

  return {
    status,

    /** Switch on, or update message, end and quiesce while already on; id, start and bypass key stay. */
    on: async (actor: User | undefined, input: MaintenanceOnInput): Promise<Result<MaintenanceStatus>> => {
      if (!requireAdmin(actor)) return fail(err.forbidden("Administrator access required"));
      const message = normalizeMaintenanceMessage(input.message);
      if (message && message.length > MAINTENANCE_MESSAGE_MAX_LENGTH)
        return fail(err.badInput(`message must be at most ${MAINTENANCE_MESSAGE_MAX_LENGTH} characters`));
      let until: number | undefined;
      if (input.until !== undefined) {
        const parsed = parseUntil(input.until);
        if (!parsed.ok) return parsed;
        until = parsed.data;
      }
      const current = (await store.read())?.state;
      // Omitted fields keep the running values; an empty message removes it.
      const nextMessage = input.message === undefined ? current?.message : message;
      const nextUntil = input.until === undefined ? current?.until : until;
      const quiesce = input.quiesce ?? current?.quiesce ?? false;
      // Every switch-on starts a new stage „Ruhe“, so reports of an earlier one stop counting.
      const quiesceEpoch = quiesce && !current?.quiesce ? (current?.quiesceEpoch ?? 0) + 1 : current?.quiesceEpoch;
      const state: MaintenanceState = {
        id: current?.id ?? crypto.randomUUID(),
        startedAt: current?.startedAt ?? now(),
        startedBy: current?.startedBy ?? { id: actor.id, label: (actor.displayName || actor.uid).slice(0, 200) },
        ...(nextMessage ? { message: nextMessage } : {}),
        ...(nextUntil ? { until: nextUntil } : {}),
        quiesce,
        ...(quiesceEpoch ? { quiesceEpoch } : {}),
        bypassKey: current?.bypassKey ?? randomKey(32),
      };
      await store.write(state);
      await record({
        action: current ? "maintenance.update" : "maintenance.start",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "maintenance", id: state.id },
        metadata: { until: iso(state.until) ?? null, message: !!state.message, quiesce: state.quiesce },
      });
      return status(actor);
    },

    setUntil: async (actor: User | undefined, value: string): Promise<Result<MaintenanceStatus>> => {
      if (!requireAdmin(actor)) return fail(err.forbidden("Administrator access required"));
      const parsed = parseUntil(value);
      if (!parsed.ok) return parsed;
      const current = (await store.read())?.state;
      if (!current) return fail({ code: "CONFLICT", status: 409, message: "Maintenance mode is not active" });
      const state = { ...current, until: parsed.data };
      await store.write(state);
      await record({
        action: "maintenance.update",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "maintenance", id: state.id },
        metadata: { until: iso(state.until) ?? null },
      });
      return status(actor);
    },

    off: async (actor: User | undefined): Promise<Result<MaintenanceStatus>> => {
      if (!requireAdmin(actor)) return fail(err.forbidden("Administrator access required"));
      const current = (await store.read())?.state;
      if (current) {
        await store.clear();
        await record({
          action: "maintenance.end",
          outcome: "allowed",
          actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
          target: { type: "maintenance", id: current.id },
          metadata: { startedAt: iso(current.startedAt) },
        });
      }
      return status(actor);
    },
  };
};

export type MaintenanceService = ReturnType<typeof createMaintenanceService>;
