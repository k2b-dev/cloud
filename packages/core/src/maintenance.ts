import { readAppRegistrySnapshot } from "@k2b/cloud";
import {
  MAINTENANCE_MESSAGE_MAX_LENGTH,
  type MaintenanceBypassLink,
  type MaintenanceOnInput,
  type MaintenanceState,
  type MaintenanceStatus,
  normalizeMaintenanceMessage,
} from "@k2b/cloud/contracts/maintenance";
import { hasRole, type User } from "@k2b/cloud/contracts/shared";
import { err, fail, ok, type Result } from "@k2b/cloud/server";
import { audit, coreSettings } from "@k2b/cloud/services";
import { issueMaintenanceBypassToken, MAINTENANCE_BYPASS_PARAM, MAINTENANCE_BYPASS_TTL_MS } from "@k2b/cloud/services/maintenance-bypass";
import {
  clearMaintenanceState,
  type ObservedMaintenance,
  readMaintenanceState,
  writeMaintenanceState,
} from "@k2b/cloud/services/maintenance-state";
import { publicCloudOrigin } from "@k2b/cloud/shared";
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

const randomKey = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");

const iso = (epochMs: number | undefined) => (epochMs === undefined ? undefined : new Date(epochMs).toISOString());

const view = (state: MaintenanceState | null, apps: MaintenanceStatus["apps"]): MaintenanceStatus =>
  state
    ? {
        active: true,
        startedAt: iso(state.startedAt),
        startedBy: state.startedBy,
        ...(state.message ? { message: state.message } : {}),
        ...(state.until ? { until: iso(state.until) } : {}),
        apps,
      }
    : { active: false, apps };

const readCloudOrigin = async (): Promise<string> => publicCloudOrigin(await coreSettings.get<string>("app.url"));

export const createMaintenanceService = ({
  store = { read: readMaintenanceState, write: writeMaintenanceState, clear: clearMaintenanceState },
  appsReady = readAppsReady,
  record = audit.record,
  now = Date.now,
  cloudOrigin = readCloudOrigin,
}: {
  store?: Store;
  appsReady?: () => Promise<MaintenanceStatus["apps"]>;
  record?: typeof audit.record;
  now?: () => number;
  /** Public origin of the Cloud host (`app.url`); the bypass link points there, never to an app domain. */
  cloudOrigin?: () => Promise<string>;
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
    return ok(view(observed?.state ?? null, apps));
  };

  return {
    status,

    /** Switch on, or update message and end while already on; id, start and bypass key stay. */
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
      const state: MaintenanceState = {
        id: current?.id ?? crypto.randomUUID(),
        startedAt: current?.startedAt ?? now(),
        startedBy: current?.startedBy ?? { id: actor.id, label: (actor.displayName || actor.uid).slice(0, 200) },
        ...(nextMessage ? { message: nextMessage } : {}),
        ...(nextUntil ? { until: nextUntil } : {}),
        quiesce: current?.quiesce ?? false,
        bypassKey: current?.bypassKey ?? randomKey(32),
      };
      await store.write(state);
      await record({
        action: current ? "maintenance.update" : "maintenance.start",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "maintenance", id: state.id },
        metadata: { until: iso(state.until) ?? null, message: !!state.message },
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

    /**
     * A personal link that lets the calling administrator past the maintenance wall on the Cloud host. It is
     * signed with this maintenance's key, so it ends with the maintenance, and after 12 hours at the latest.
     */
    bypass: async (actor: User | undefined): Promise<Result<MaintenanceBypassLink>> => {
      if (!requireAdmin(actor)) return fail(err.forbidden("Administrator access required"));
      const current = (await store.read())?.state;
      if (!current) return fail({ code: "CONFLICT", status: 409, message: "Maintenance mode is not active" });
      // Whole seconds, as the token carries them.
      const expiresAt = Math.floor((now() + MAINTENANCE_BYPASS_TTL_MS) / 1000) * 1000;
      const token = issueMaintenanceBypassToken(current, actor.id, expiresAt);
      const url = new URL("/", await cloudOrigin());
      url.searchParams.set(MAINTENANCE_BYPASS_PARAM, token);
      // The token itself is a credential: the audit entry names who asked and until when, never the link.
      await record({
        action: "maintenance.bypass",
        outcome: "allowed",
        actor: { userId: actor.id, uid: actor.uid, provider: actor.provider, roles: actor.roles },
        target: { type: "maintenance", id: current.id },
        metadata: { expiresAt: iso(expiresAt) },
      });
      return ok({ url: url.href, expiresAt: new Date(expiresAt).toISOString() });
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
