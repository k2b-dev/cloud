import type { TransactionSQL } from "bun";
import { z } from "zod";
import { GeoAutocompleteInputSchema } from "../contracts/geo";
import { isInstallablePath } from "../contracts/installable";
import { PWA_LIMITS } from "../contracts/pwa";
import { sql } from "../runtime/clients";
import { ratelimit } from "../server/ratelimit";
import { REQUEST_IDLE_TIMEOUT_SECONDS } from "../server/request-timeout";
import { getEffectivePermission, hasPermission } from "../server/services/access";
import { decodeAccountCategoryEnabled } from "../services/account-category-policy";
import { audit } from "../services/audit";
import { GeoError } from "../services/geo/errors";
import { coreGeo } from "../services/geo/service";
import { geoPlan, readGeoConfig } from "../services/geo/settings";
import { pairingSecret } from "../services/pairing-secret";
import { get as getSetting } from "../services/settings";
import { databaseClock, lockWebAuthority } from "./authority";
import {
  type AppPwaActor,
  type AppPwaDeviceActor,
  type AppPwaDeviceView,
  AppPwaError,
  AppPwaId,
  type AppPwaOptions,
  type AppPwaRegistrationGuestView,
  type AppPwaRegistrationView,
  AppPwaSecret,
  type AppPwaStaffAction,
  type AppPwaStaffTarget,
  type AppPwaVisitActor,
  type AppPwaVisitView,
  type AppPwaWebSignIn,
  APP_PWA_LIMITS as limits,
  parseAppPwaInput as parse,
  pwaFail,
} from "./contracts";
import { AppPwaCoreQueryError } from "./core-query-error";
import { appPwaQr, parseAppPwaQr } from "./protocol";
import { appPwaSchemaName, setupAppPwa } from "./schema";
import { withAppPwaTransaction } from "./transaction";
import { untilAppPwaAbort } from "./transport-input";

type Browser = { credential_hash: string; device_id: string | null; expires_at: Date };
type Device = {
  id: string;
  owner_user_id: string;
  initiator_sid: string;
  auth_epoch: string;
  name: string;
  input_digest: string;
  secret_hash: string;
  browser_hash: string | null;
  state: "pending" | "active" | "revoked";
  qr_expires_at: Date;
  activated_at: Date | null;
  expires_at: Date | null;
  active_visit_id: string | null;
  registration_id: string | null;
  visit_only: boolean;
};
type Registration = {
  id: string;
  name: string;
  browser_hash: string;
  registered_by: string;
  registered_at: Date;
  expires_at: Date;
  state: "active" | "revoked";
};
type Visit = {
  issued_at: Date;
  id: string;
  device_id: string;
  input_digest: string;
  secret_hash: string;
  subject: unknown;
  state: "pending" | "active" | "ended" | "revoked";
  browser_hash: string | null;
  qr_expires_at: Date;
  activated_at: Date | null;
  last_used_at: Date | null;
  expires_at: Date | null;
};
type Attempt = { route: string; input_digest: string; result: unknown };

/** Canonical JSON makes property-order changes harmless while retaining route and validated input binding. */
export const appPwaDigest = (value: unknown): string => {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (typeof item === "object" && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.entries(item)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    }
    return pwaFail("INVALID_INPUT", 400);
  };
  return pairingSecret.hash(canonical(value));
};

/** Six digits from a registration's server-only browser hash; staff and other browsers cannot derive them. */
export const appPwaPresenceCode = (appId: string, registrationId: string, browserHash: string, window: number): string =>
  String(
    Number.parseInt(pairingSecret.hash(`cloud-app-pwa:presence:${appId}:${registrationId}:${browserHash}:${window}`).slice(0, 12), 16) %
      1_000_000,
  ).padStart(6, "0");
const presenceWindow = (time: Date) => Math.floor(time.getTime() / (limits.presenceSeconds * 1000));

const earlier = (...values: Date[]): Date => new Date(Math.min(...values.map((value) => value.getTime())));
const plus = (time: Date, seconds: number): Date => new Date(time.getTime() + seconds * 1000);
const deviceView = (device: Device, time: Date): AppPwaDeviceView => ({
  id: device.id,
  name: device.name,
  state:
    device.state !== "revoked" &&
    (device.state === "pending" ? device.qr_expires_at <= time : !device.expires_at || device.expires_at <= time)
      ? "expired"
      : device.state,
  expiresAt: device.expires_at?.toISOString() ?? null,
  registrationId: device.registration_id ?? null,
});
const visitView = (visit: Visit, time: Date): AppPwaVisitView => ({
  id: visit.id,
  state:
    (visit.state === "pending" && visit.qr_expires_at <= time) || (visit.state === "active" && !liveVisit(visit, time))
      ? "expired"
      : visit.state,
  expiresAt: visit.expires_at?.toISOString() ?? null,
  idleExpiresAt: visit.last_used_at ? plus(visit.last_used_at, limits.visitIdleSeconds).toISOString() : null,
});
const checkDevice = (device: Device, time: Date, epoch: string) => {
  if (device.state === "revoked") return pwaFail("REVOKED", 410);
  if (String(device.auth_epoch) !== String(epoch)) return pwaFail("REVOKED", 410);
  if (device.state !== "active" || !device.expires_at || device.expires_at <= time) return pwaFail("EXPIRED", 410);
  return device.expires_at;
};
const checkVisitDeadline = (visit: Visit, time: Date) => {
  if (!visit.expires_at || !visit.last_used_at || visit.expires_at <= time || plus(visit.last_used_at, limits.visitIdleSeconds) <= time)
    return pwaFail("EXPIRED", 410);
  return earlier(visit.expires_at, plus(visit.last_used_at, limits.visitIdleSeconds));
};
const checkVisit = (visit: Visit, time: Date) => {
  if (visit.state === "revoked" || visit.state === "ended") return pwaFail("REVOKED", 410);
  if (visit.state !== "active") return pwaFail("EXPIRED", 410);
  return checkVisitDeadline(visit, time);
};
const liveVisit = (visit: Visit, time: Date) =>
  visit.state === "active" &&
  visit.expires_at &&
  visit.last_used_at &&
  visit.expires_at > time &&
  plus(visit.last_used_at, limits.visitIdleSeconds) > time;

export const createAppPwaService = (options: AppPwaOptions) => {
  if (typeof options.authorizeStaff !== "function" || typeof options.authorizeVisit !== "function")
    throw new Error("App-PWA requires staff and visit-subject authorization");
  const coreQueries = new Set(options.coreQueries ?? []);
  if (!Array.isArray(options.coreQueries ?? []) || [...coreQueries].some((query) => query !== "address.autocomplete"))
    throw new Error("Unsupported App-PWA Core query");
  const db = () => options.db ?? sql;
  const appId = options.app.id;
  const path = options.app.installable.path;
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || !isInstallablePath(appId, path))
    throw new Error("App-PWA requires a canonical HTTPS public origin and the declared installable path");
  const schema = appPwaSchemaName(options.schema);
  // Declarations precede platform startup; resolve clients and identifiers only on use.
  const tables = {
    get browsers() {
      return db()(`${schema}._cloud_pwa_browsers`);
    },
    get devices() {
      return db()(`${schema}._cloud_pwa_devices`);
    },
    get visits() {
      return db()(`${schema}._cloud_pwa_visits`);
    },
    get attempts() {
      return db()(`${schema}._cloud_pwa_attempts`);
    },
    get registrations() {
      return db()(`${schema}._cloud_pwa_registrations`);
    },
  };
  const requestedTtl = options.deviceTtlSeconds ?? limits.deviceSeconds;
  if (!Number.isSafeInteger(requestedTtl) || requestedTtl <= 0) throw new Error("Invalid App-PWA device TTL");
  const ttl = Math.min(requestedTtl, limits.deviceSeconds);
  for (const budget of Object.values(options.budgets))
    if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Invalid App-PWA budget");
  for (const routes of [options.queries, options.commands, options.deviceOperations]) {
    for (const route of Object.keys(routes ?? {})) if (!/^[a-z][a-z0-9-]*$/.test(route)) throw new Error("Invalid App-PWA operation name");
  }
  const cookieName = `__Secure-cloud-app-pwa-${appId}-${pairingSecret.hash(path).slice(0, 16)}`;
  let ready = false;
  const bounded = <T>(value: T, max = options.budgets.responseBytes): T => {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || new TextEncoder().encode(encoded).byteLength > max) return pwaFail("TOO_LARGE", 413);
    // Refuse undefined, dates, nonfinite values, cycles and non-JSON handler output before storing it.
    appPwaDigest(value);
    return value;
  };
  type BeforeCommit = {
    authorize(check: () => Promise<void>): void;
    deadline(check: (time: Date) => Date): void;
  };
  const transaction = async <T>(
    work: (tx: TransactionSQL, signal: AbortSignal, beforeCommit: BeforeCommit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    if (!ready) return pwaFail("UNAVAILABLE", 503);
    const authorizations: (() => Promise<void>)[] = [];
    const deadlines: ((time: Date) => Date)[] = [];
    try {
      return await withAppPwaTransaction(
        db(),
        signal,
        async (tx, requestSignal) => {
          const result = bounded(
            await work(tx, requestSignal, {
              authorize: (check) => {
                authorizations.push(check);
              },
              deadline: (check) => {
                deadlines.push(check);
              },
            }),
          );
          for (const check of authorizations) await check();
          return result;
        },
        (time) => {
          const checked = deadlines.map((check) => check(time));
          return checked.length ? earlier(...checked) : undefined;
        },
      );
    } catch (error) {
      if (error instanceof AppPwaError) throw error;
      return pwaFail("UNAVAILABLE", 503);
    }
  };
  const record = async (
    tx: TransactionSQL,
    event: string,
    actor: AppPwaActor | AppPwaWebSignIn,
    deviceId: string | null,
    visitId: string | null = null,
    details: Record<string, string | null> = {},
  ) => {
    // Visit provenance is stable even when another employee ends the visit.
    const [device] = visitId
      ? await tx<Device[]>`SELECT d.* FROM ${tables.devices} d JOIN ${tables.visits} v
        ON v.app_id = d.app_id AND v.device_id = d.id WHERE v.app_id = ${appId} AND v.id = ${visitId}::uuid`
      : [];
    return audit.record(
      {
        action: `app_pwa.${event}`,
        outcome: "allowed",
        target: { type: "app_pwa", id: appId },
        ...(!("kind" in actor) ? { actor: { userId: actor.userId } } : {}),
        metadata: {
          appId,
          deviceId,
          visitId,
          actorKind: "kind" in actor ? actor.kind : "web",
          ownerUserId: "kind" in actor ? actor.ownerUserId : actor.userId,
          ...(device ? { registrationId: device.registration_id, issuedByUserId: device.owner_user_id } : {}),
          ...details,
        },
      },
      tx,
    );
  };
  const csrf = (credential: string) => pairingSecret.hash(`cloud-app-pwa:csrf:${appId}:${path}:${credential}`);
  const browser = async (tx: TransactionSQL, credential: string, lock = false): Promise<Browser> => {
    parse(AppPwaSecret, credential);
    const [row] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
      WHERE app_id = ${appId} AND credential_hash = ${pairingSecret.hash(credential)} ${lock ? db()`FOR UPDATE` : db()``}`;
    if (!row || row.expires_at <= (await databaseClock(tx))) return pwaFail("BROWSER_REQUIRED", 401);
    return row;
  };
  const staff = async <T>(
    signIn: AppPwaWebSignIn,
    action: AppPwaStaffAction,
    work: (tx: TransactionSQL, authority: Awaited<ReturnType<typeof lockWebAuthority>>, beforeCommit: BeforeCommit) => Promise<T>,
    signal?: AbortSignal,
  ) => {
    parse(AppPwaId, signIn.userId);
    parse(AppPwaId, signIn.sid);
    return transaction(async (tx, _signal, beforeCommit) => {
      const authority = await lockWebAuthority(tx, signIn);
      beforeCommit.deadline(authority.check);
      beforeCommit.authorize(async () => {
        if (!(await options.authorizeStaff(action, signIn, tx))) pwaFail("FORBIDDEN", 403);
      });
      if (!(await options.authorizeStaff(action, signIn, tx))) return pwaFail("FORBIDDEN", 403);
      const result = await work(tx, authority, beforeCommit);
      await authority.check(await databaseClock(tx));
      return result;
    }, signal);
  };
  const lockDevice = async (tx: TransactionSQL, id: string): Promise<Device> => {
    const [row] = await tx<
      Device[]
    >`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND id = ${parse(AppPwaId, id)}::uuid FOR UPDATE`;
    return row ?? pwaFail("NOT_FOUND", 404);
  };
  const lockVisit = async (tx: TransactionSQL, id: string): Promise<Visit> => {
    const [row] = await tx<
      Visit[]
    >`SELECT * FROM ${tables.visits} WHERE app_id = ${appId} AND id = ${parse(AppPwaId, id)}::uuid FOR UPDATE`;
    return row ?? pwaFail("NOT_FOUND", 404);
  };
  const ownedDevice = async (tx: TransactionSQL, signIn: AppPwaWebSignIn, id: string) => {
    const row = await lockDevice(tx, id);
    if (row.owner_user_id !== signIn.userId) return pwaFail("NOT_FOUND", 404);
    return row;
  };
  // Staff can inspect devices from an earlier web session. Report the same
  // initiating-family invalidation that the guest path enforces, without
  // pretending those devices became active again after a fresh sign-in.
  // Each device is judged by its own owner's epoch, so shared registrations
  // can report other people's uses with the same rule.
  const staffDeviceViews = async (tx: TransactionSQL, devices: Device[]): Promise<AppPwaDeviceView[]> => {
    if (!devices.length) return [];
    const families = await tx<
      {
        sid: string;
        auth_epoch: string;
        user_epoch: string;
        expires_at: Date;
        revoked_at: Date | null;
        pwa_device_id: string | null;
        key_state: string;
        account_expires: Date | null;
        legal_allowed: boolean;
        category_value: string | null;
      }[]
    >`SELECT f.sid,f.auth_epoch,u.auth_epoch AS user_epoch,f.expires_at,f.revoked_at,f.pwa_device_id,k.state AS key_state,
        u.account_expires, (NOT f.legal_pending OR EXISTS(SELECT 1 FROM auth.legal_acceptances a WHERE a.user_id=u.id)) AS legal_allowed,
        e.value AS category_value
      FROM auth.session_families f JOIN auth.signing_keys k ON k.kid=f.signing_kid JOIN auth.users u ON u.id=f.user_id
      LEFT JOIN settings.entries e ON e.key = 'user.category.' ||
        CASE WHEN u.provider='ipa' THEN 'freeipa' WHEN u.profile='guest' THEN 'guest' ELSE 'login' END || '.enabled'
      WHERE f.sid=ANY(${db().array(
        devices.map((device) => device.initiator_sid),
        "uuid",
      )})`;
    const visitOnlySessions = new Set(devices.filter((device) => device.visit_only).map((device) => device.initiator_sid));
    const disabledSessions = new Set<string>();
    for (const family of families)
      if (visitOnlySessions.has(family.sid) && !(await decodeAccountCategoryEnabled(family.category_value)))
        disabledSessions.add(family.sid);
    const byId = new Map(families.map((family) => [family.sid, family]));
    const time = await databaseClock(tx);
    return devices.map((device) => {
      const view = deviceView(device, time);
      if (view.state === "revoked" || view.state === "expired") return view;
      const family = byId.get(device.initiator_sid);
      if (
        !family ||
        family.revoked_at ||
        family.pwa_device_id ||
        family.key_state === "revoked" ||
        String(family.auth_epoch) !== String(family.user_epoch) ||
        String(device.auth_epoch) !== String(family.user_epoch)
      ) {
        return { ...view, state: "revoked" };
      }
      if (
        device.visit_only &&
        ((family.account_expires && family.account_expires <= time) || !family.legal_allowed || disabledSessions.has(family.sid))
      )
        return { ...view, state: "revoked" };
      return family.expires_at <= time ? { ...view, state: "expired" } : view;
    });
  };
  const deviceActor = (device: Device): AppPwaDeviceActor => ({
    kind: "device",
    appId,
    deviceId: device.id,
    ownerUserId: device.owner_user_id,
  });
  const visitActor = (device: Device, visit: Visit): AppPwaVisitActor => ({
    ...deviceActor(device),
    kind: "visit",
    visitId: visit.id,
    subject: parse(options.subject, visit.subject),
  });
  type GuestWork<T> = (tx: TransactionSQL, device: Device, signal: AbortSignal, beforeCommit: BeforeCommit) => Promise<T>;
  const guestIn = async <T>(
    tx: TransactionSQL,
    credential: string,
    requestSignal: AbortSignal,
    beforeCommit: BeforeCommit,
    work: GuestWork<T>,
  ): Promise<T> => {
    // Snapshot identifies the owner only; every authority row is locked and checked afterwards.
    const snapshot = await browser(tx, credential);
    if (!snapshot.device_id) return pwaFail("BROWSER_REQUIRED", 401);
    const [identity] = await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND id = ${snapshot.device_id}::uuid`;
    if (!identity) return pwaFail("BROWSER_REQUIRED", 401);
    const authority = await lockWebAuthority(tx, { userId: identity.owner_user_id, sid: identity.initiator_sid });
    const device = await lockDevice(tx, identity.id);
    const binding = await browser(tx, credential, true);
    if (binding.device_id !== device.id || device.browser_hash !== binding.credential_hash) return pwaFail("BROWSER_REQUIRED", 401);
    checkDevice(device, await databaseClock(tx), authority.user.auth_epoch);
    beforeCommit.deadline((time) => {
      const authorityExpiry = authority.check(time);
      const deviceExpiry = checkDevice(device, time, authority.user.auth_epoch);
      if (binding.expires_at <= time) return pwaFail("EXPIRED", 410);
      return earlier(authorityExpiry, deviceExpiry, binding.expires_at);
    });
    const result = await work(tx, device, requestSignal, beforeCommit);
    const time = await databaseClock(tx);
    await authority.check(time);
    checkDevice(device, time, authority.user.auth_epoch);
    if (binding.expires_at <= time) return pwaFail("EXPIRED", 410);
    return result;
  };
  const guest = <T>(credential: string, work: GuestWork<T>, signal?: AbortSignal) =>
    transaction((tx, requestSignal, beforeCommit) => guestIn(tx, credential, requestSignal, beforeCommit, work), signal);
  // A device whose use ended (logout, expiry, revocation, takeover) stays registered.
  const leaseEnded = (error: unknown) =>
    error instanceof AppPwaError && ["EXPIRED", "REVOKED", "WEB_SESSION_REQUIRED", "BROWSER_REQUIRED"].includes(error.code);
  const liveRegistration = async (tx: TransactionSQL, browserHash: string, lock = false): Promise<Registration | undefined> => {
    const [row] = await tx<Registration[]>`SELECT * FROM ${tables.registrations}
      WHERE app_id = ${appId} AND browser_hash = ${browserHash} AND state = 'active' ${lock ? db()`FOR UPDATE` : db()``}`;
    return row && row.expires_at > (await databaseClock(tx)) ? row : undefined;
  };
  const lockRegistration = async (tx: TransactionSQL, id: string): Promise<Registration> => {
    const [row] = await tx<Registration[]>`SELECT * FROM ${tables.registrations}
      WHERE app_id = ${appId} AND id = ${parse(AppPwaId, id)}::uuid FOR UPDATE`;
    return row ?? pwaFail("NOT_FOUND", 404);
  };
  // Only the display name: an unauthenticated device never learns account IDs, login names, or contact details.
  const holderName = async (tx: TransactionSQL, userId: string): Promise<string | null> => {
    const [row] = await tx<
      { name: string | null }[]
    >`SELECT NULLIF(trim(display_name), '') AS name FROM auth.users WHERE id = ${userId}::uuid`;
    return row?.name ?? null;
  };
  const registrationStaffView = (registration: Registration, holder: { displayName: string | null } | null) => ({
    id: registration.id,
    name: registration.name,
    expiresAt: registration.expires_at.toISOString(),
    holder,
  });
  // Only the registered browser receives its presence code; staff responses never contain it.
  const registrationGuestView = (
    registration: Registration,
    holder: { displayName: string | null } | null,
    time: Date,
  ): AppPwaRegistrationGuestView => {
    const window = presenceWindow(time);
    return {
      ...registrationStaffView(registration, holder),
      presence: {
        code: appPwaPresenceCode(appId, registration.id, registration.browser_hash, window),
        expiresAt: new Date((window + 1) * limits.presenceSeconds * 1000).toISOString(),
      },
    };
  };
  const presenceMatches = (registration: Registration, code: string, time: Date) => {
    const window = presenceWindow(time);
    // Compare both accepted windows every time, in constant time.
    const current = pairingSecret.matches(
      code,
      pairingSecret.hash(appPwaPresenceCode(appId, registration.id, registration.browser_hash, window)),
    );
    const previous = pairingSecret.matches(
      code,
      pairingSecret.hash(appPwaPresenceCode(appId, registration.id, registration.browser_hash, window - 1)),
    );
    return current || previous;
  };
  const presenceLimiter = ratelimit({
    id: `app-pwa:${appId}:presence`,
    limit: limits.presenceAttempts,
    windowSecs: limits.presenceSeconds,
  });
  // Registration actions change or reveal other people's state; the app may narrow them per registration.
  const authorizeTarget = async (
    tx: TransactionSQL,
    signIn: AppPwaWebSignIn,
    action: AppPwaStaffAction,
    target: AppPwaStaffTarget,
    beforeCommit?: BeforeCommit,
  ) => {
    const check = async () => {
      if (!(await options.authorizeStaff(action, signIn, tx, target))) pwaFail("FORBIDDEN", 403);
    };
    await check();
    beforeCommit?.authorize(check);
  };
  // Ending a use revokes its device row and any running visit. Callers hold the registration lock.
  const endUse = async (tx: TransactionSQL, device: Device, actor: AppPwaWebSignIn) => {
    if (device.state !== "revoked")
      await tx`UPDATE ${tables.devices} SET state = 'revoked' WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
    if (!device.active_visit_id) return null;
    const visit = await lockVisit(tx, device.active_visit_id);
    if (visit.state !== "active" && visit.state !== "pending") return null;
    await tx`UPDATE ${tables.visits} SET state = 'revoked' WHERE app_id = ${appId} AND id = ${visit.id}::uuid`;
    await record(tx, "visit.revoked", actor, device.id, visit.id);
    return visit.id;
  };
  const boundVisit = async (tx: TransactionSQL, device: Device, visitId: string) => {
    const visit = await lockVisit(tx, visitId);
    if (visit.device_id !== device.id || visit.browser_hash !== device.browser_hash) return pwaFail("NOT_FOUND", 404);
    return visit;
  };
  const coreActor = async (tx: TransactionSQL, device: Device, beforeCommit: BeforeCommit, visitId?: string): Promise<AppPwaActor> => {
    const currentVisit = visitId ?? device.active_visit_id;
    if (!currentVisit) return device.visit_only ? pwaFail("REVOKED", 410) : deviceActor(device);
    const visit = await boundVisit(tx, device, currentVisit);
    if (device.active_visit_id !== visit.id) return pwaFail("REVOKED", 410);
    // Device mode resumes after a visit ends. Explicit visit requests never fall back.
    if (!visitId && !liveVisit(visit, await databaseClock(tx))) return device.visit_only ? pwaFail("REVOKED", 410) : deviceActor(device);
    beforeCommit.deadline((time) => checkVisit(visit, time));
    checkVisit(visit, await databaseClock(tx));
    return visitActor(device, visit);
  };
  const recordCoreQuery = (actor: AppPwaActor, outcome: "allowed" | "denied" | "failed", code?: string, tx?: TransactionSQL) =>
    audit.record(
      {
        action: "app_pwa.core.query",
        outcome,
        target: { type: "core.query", id: "address.autocomplete" },
        ...(code ? { error: { code } } : {}),
        metadata: {
          appId,
          subject: { type: "user", userId: actor.ownerUserId },
          via: { kind: actor.kind, appId, deviceId: actor.deviceId, ...(actor.kind === "visit" ? { visitId: actor.visitId } : {}) },
        },
      },
      tx,
    );
  const readAttempt = async (tx: TransactionSQL, visitId: string, attemptId: string) => {
    const [row] = await tx<Attempt[]>`SELECT route, input_digest, result FROM ${tables.attempts}
      WHERE app_id = ${appId} AND visit_id = ${visitId}::uuid AND attempt_id = ${parse(AppPwaId, attemptId)}::uuid`;
    return row;
  };

  return {
    path,
    appId,
    publicOrigin: origin.origin,
    cookieName,
    budgets: options.budgets,
    csrf,
    /** Lifecycle setup; a rejected migration prevents all service operations. */
    setup: async () => {
      await setupAppPwa(db(), schema);
      ready = true;
    },
    /** No caller-selected credential. An existing credential can only continue its existing browser. */
    bootstrap: (existingCredential?: string, signal?: AbortSignal) =>
      transaction(async (tx, _signal, beforeCommit) => {
        // Unknown/malformed hints never become a stored credential. A still-live
        // binding survives bootstrap; terminal authority gets a fresh random browser.
        if (existingCredential && AppPwaSecret.safeParse(existingCredential).success) {
          const [binding] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
            WHERE app_id = ${appId} AND credential_hash = ${pairingSecret.hash(existingCredential)}`;
          let live = !!binding && binding.expires_at > (await databaseClock(tx));
          if (live && binding?.device_id) {
            try {
              const [identity] = await tx<
                Device[]
              >`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND id = ${binding.device_id}::uuid`;
              if (!identity) return pwaFail("BROWSER_REQUIRED", 401);
              const authority = await lockWebAuthority(tx, { userId: identity.owner_user_id, sid: identity.initiator_sid });
              const device = await lockDevice(tx, identity.id);
              const current = await browser(tx, existingCredential, true);
              const check = (time: Date) => {
                const authorityExpiry = authority.check(time);
                const deviceExpiry = checkDevice(device, time, authority.user.auth_epoch);
                if (current.device_id !== device.id || device.browser_hash !== current.credential_hash || current.expires_at <= time)
                  pwaFail("BROWSER_REQUIRED", 401);
                return earlier(authorityExpiry, deviceExpiry, current.expires_at);
              };
              await check(await databaseClock(tx));
              beforeCommit.deadline(check);
            } catch (error) {
              if (!leaseEnded(error)) throw error;
              live = false;
            }
          }
          // A registered browser outlives each use; it keeps its credential and holds no authority.
          const registration =
            binding && binding.expires_at > (await databaseClock(tx)) ? await liveRegistration(tx, binding.credential_hash) : undefined;
          if ((live || registration) && binding) {
            beforeCommit.deadline((time) => {
              if (binding.expires_at <= time) pwaFail("BROWSER_REQUIRED", 401);
              return binding.expires_at;
            });
            return {
              credential: existingCredential,
              csrf: csrf(existingCredential),
              persistUntil: registration ? binding.expires_at.toISOString() : null,
            };
          }
        }
        const credential = pairingSecret.create();
        await tx`INSERT INTO ${tables.browsers}(app_id, credential_hash, expires_at)
          VALUES (${appId}, ${pairingSecret.hash(credential)}, ${plus(await databaseClock(tx), limits.deviceSeconds)})`;
        return { credential, csrf: csrf(credential), persistUntil: null };
      }, signal),
    /** `register: true` issues a shared-device registration QR; its claim makes the issuer the first user. */
    issueDevice: (signIn: AppPwaWebSignIn, input: { requestId: string; name: string; register?: boolean }, signal?: AbortSignal) =>
      staff(
        signIn,
        input.register === true ? "register-device" : "issue-device",
        async (tx, authority) => {
          parse(
            z.strictObject({
              requestId: AppPwaId,
              name: z.string().trim().min(1).max(PWA_LIMITS.nameMaxLength),
              register: z.boolean().optional(),
            }),
            input,
          );
          const digest = appPwaDigest(input);
          const [existing] = await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId}
        AND owner_user_id = ${signIn.userId}::uuid AND initiator_sid = ${signIn.sid}::uuid AND request_id = ${input.requestId}::uuid FOR UPDATE`;
          if (existing && existing.input_digest !== digest) return pwaFail("ATTEMPT_CONFLICT", 409);
          const time = await databaseClock(tx);
          if (existing && existing.state !== "pending")
            return { ...deviceView(existing, time), qr: null, qrExpiresAt: existing.qr_expires_at.toISOString() };
          if (existing && existing.qr_expires_at <= time) return pwaFail("EXPIRED", 410);
          // A lost issuance response rotates the unconsumed QR on the SAME row; no raw QR is stored.
          const secret = pairingSecret.create();
          const id = existing?.id ?? crypto.randomUUID();
          const registrationId = existing ? existing.registration_id : input.register === true ? crypto.randomUUID() : null;
          const expires = existing?.qr_expires_at ?? earlier(plus(time, limits.qrSeconds), authority.family.expires_at);
          if (existing)
            await tx`UPDATE ${tables.devices} SET secret_hash = ${pairingSecret.hash(secret)} WHERE app_id = ${appId} AND id = ${id}::uuid`;
          else {
            await tx`INSERT INTO ${tables.devices}(app_id,id,request_id,input_digest,owner_user_id,initiator_sid,auth_epoch,name,secret_hash,state,issued_at,qr_expires_at,registration_id)
          VALUES (${appId},${id}::uuid,${input.requestId}::uuid,${digest},${signIn.userId}::uuid,${signIn.sid}::uuid,${authority.user.auth_epoch},${input.name},${pairingSecret.hash(secret)},'pending',${time},${expires},${registrationId}::uuid)`;
            await record(tx, "device.issued", signIn, id, null, registrationId ? { registrationId } : {});
          }
          return {
            id,
            name: input.name,
            state: "pending",
            expiresAt: null,
            registrationId,
            qr: appPwaQr(origin.origin, path, { kind: "device", secret }),
            qrExpiresAt: expires.toISOString(),
          };
        },
        signal,
      ),
    claimDevice: (credential: string, qr: string, signal?: AbortSignal) =>
      transaction(async (tx, _signal, beforeCommit) => {
        const parsed = parseAppPwaQr(qr, origin.origin, path);
        if (parsed?.kind !== "device") return pwaFail("INVALID_QR", 400);
        await browser(tx, credential);
        const [identity] = await tx<
          Device[]
        >`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND secret_hash = ${pairingSecret.hash(parsed.secret)}`;
        if (!identity) return pwaFail("INVALID_QR", 400);
        const authority = await lockWebAuthority(tx, { userId: identity.owner_user_id, sid: identity.initiator_sid });
        const device = await lockDevice(tx, identity.id);
        const binding = await browser(tx, credential, true);
        beforeCommit.deadline((time) => {
          const authorityExpiry = authority.check(time);
          const deviceExpiry = checkDevice(device, time, authority.user.auth_epoch);
          if (binding.expires_at <= time) pwaFail("EXPIRED", 410);
          return earlier(authorityExpiry, deviceExpiry, binding.expires_at);
        });
        if (!pairingSecret.matches(parsed.secret, device.secret_hash)) return pwaFail("INVALID_QR", 400);
        const time = await databaseClock(tx);
        if (device.state !== "pending") {
          if (device.browser_hash !== binding.credential_hash || binding.device_id !== device.id) return pwaFail("ALREADY_CLAIMED", 409);
          checkDevice(device, time, authority.user.auth_epoch);
        } else {
          if (device.qr_expires_at <= time) return pwaFail("EXPIRED", 410);
          // A terminal binding must bootstrap a new server-generated credential.
          // Never transfer the old browser's authority to a new device in place.
          if (binding.device_id) return pwaFail("BROWSER_REQUIRED", 401);
          // A registration QR keeps this fresh browser bound beyond the issuer's use.
          if (device.registration_id) binding.expires_at = plus(time, limits.registrationSeconds);
          const expires = earlier(plus(time, ttl), authority.family.expires_at, binding.expires_at);
          device.visit_only = !!device.registration_id && options.registeredDevices?.push === "staff";
          await tx`UPDATE ${tables.devices} SET browser_hash = ${binding.credential_hash}, state = 'active', activated_at = ${time}, expires_at = ${expires}, visit_only = ${device.visit_only}
          WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
          await tx`UPDATE ${tables.browsers} SET device_id = ${device.id}::uuid, expires_at = ${binding.expires_at}
          WHERE app_id = ${appId} AND credential_hash = ${binding.credential_hash}`;
          device.state = "active";
          device.expires_at = expires;
          device.browser_hash = binding.credential_hash;
          if (device.registration_id) {
            await tx`INSERT INTO ${tables.registrations}(app_id,id,name,browser_hash,registered_by,registered_at,expires_at,state)
            VALUES (${appId},${device.registration_id}::uuid,${device.name},${binding.credential_hash},${device.owner_user_id}::uuid,${time},${binding.expires_at},'active')`;
            await record(tx, "registration.registered", deviceActor(device), device.id, null, { registrationId: device.registration_id });
          }
          await record(tx, "device.claimed", deviceActor(device), device.id);
        }
        const finish = await databaseClock(tx);
        await authority.check(finish);
        checkDevice(device, finish, authority.user.auth_epoch);
        const registration = device.registration_id ? await liveRegistration(tx, binding.credential_hash) : undefined;
        return {
          ...deviceView(device, finish),
          registration: registration
            ? registrationGuestView(
                registration,
                device.visit_only ? null : { displayName: await holderName(tx, device.owner_user_id) },
                finish,
              )
            : null,
        };
      }, signal),
    listDevices: (signIn: AppPwaWebSignIn, after?: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "list-devices",
        async (tx) => {
          if (after) parse(AppPwaId, after);
          const rows = await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND owner_user_id = ${signIn.userId}::uuid
        ${after ? db()`AND id > ${after}::uuid` : db()``} ORDER BY id LIMIT ${options.budgets.listPageSize}`;
          return {
            items: await staffDeviceViews(tx, rows),
            next: rows.length === options.budgets.listPageSize ? (rows.at(-1)?.id ?? null) : null,
          };
        },
        signal,
      ),
    deviceStatus: (signIn: AppPwaWebSignIn, id: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "device-status",
        async (tx) => {
          const views = await staffDeviceViews(tx, [await ownedDevice(tx, signIn, id)]);
          return views[0] ?? pwaFail("NOT_FOUND", 404);
        },
        signal,
      ),
    revokeDevice: (signIn: AppPwaWebSignIn, id: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "revoke-device",
        async (tx) => {
          const device = await ownedDevice(tx, signIn, id);
          if (device.state !== "revoked") {
            await tx`UPDATE ${tables.devices} SET state = 'revoked' WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
            await record(tx, "device.revoked", signIn, device.id);
          }
          return { state: "revoked" };
        },
        signal,
      ),
    /** `push: true` opens the visit directly on the issuer's device, bound to its browser, without a QR. */
    issueVisit: (
      signIn: AppPwaWebSignIn,
      input: { requestId: string; subject: unknown } & (
        | { deviceId: string; registrationId?: never; push?: boolean }
        | { registrationId: string; deviceId?: never; push: true }
      ),
      signal?: AbortSignal,
    ) =>
      staff(
        signIn,
        "issue-visit",
        async (tx, authority, beforeCommit) => {
          parse(AppPwaId, input.requestId);
          const push = parse(z.boolean().optional(), input.push) === true;
          const subject = bounded(parse(options.subject, input.subject), options.budgets.requestBytes);
          let device: Device;
          let replacement: Record<string, string | null> = {};
          if (input.registrationId !== undefined) {
            if (options.registeredDevices?.push !== "staff") return pwaFail("FORBIDDEN", 403);
            if (!push || input.deviceId !== undefined) return pwaFail("INVALID_INPUT", 400);
            const registration = await lockRegistration(tx, input.registrationId);
            await authorizeTarget(tx, signIn, "issue-visit", { registrationId: registration.id, name: registration.name }, beforeCommit);
            const time = await databaseClock(tx);
            if (registration.state === "revoked") return pwaFail("REVOKED", 410);
            if (registration.expires_at <= time) return pwaFail("EXPIRED", 410);
            beforeCommit.deadline((time) => {
              if (registration.expires_at <= time) return pwaFail("EXPIRED", 410);
              return registration.expires_at;
            });
            const [binding] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
              WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash}`;
            if (!binding || binding.expires_at <= time) return pwaFail("EXPIRED", 410);
            // A request identifies its session-bound carrier, even after another visit has used the registration.
            const [retry] = await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId}
              AND owner_user_id = ${signIn.userId}::uuid AND initiator_sid = ${signIn.sid}::uuid
              AND request_id = ${input.requestId}::uuid FOR UPDATE`;
            if (retry) {
              if (!retry.visit_only || retry.registration_id !== registration.id) return pwaFail("ATTEMPT_CONFLICT", 409);
              device = retry;
            } else {
              const previous = binding.device_id ? await lockDevice(tx, binding.device_id) : undefined;
              const [view] = previous ? await staffDeviceViews(tx, [previous]) : [];
              if (previous?.active_visit_id && view?.state === "active") {
                const current = await lockVisit(tx, previous.active_visit_id);
                if (liveVisit(current, await databaseClock(tx))) return pwaFail("ACTIVE_VISIT", 409);
              }
              replacement = {
                previousDeviceId: previous?.id ?? null,
                previousOwnerUserId: previous && !previous.visit_only && view?.state === "active" ? previous.owner_user_id : null,
              };
              // Replace an idle use without presence or takeover. A live visit always wins over a new push.
              if (previous) await endUse(tx, previous, signIn);
              device = {
                id: crypto.randomUUID(),
                owner_user_id: signIn.userId,
                initiator_sid: signIn.sid,
                auth_epoch: authority.user.auth_epoch,
                name: registration.name,
                input_digest: appPwaDigest({ registrationId: registration.id }),
                secret_hash: pairingSecret.hash(pairingSecret.create()),
                browser_hash: binding.credential_hash,
                state: "active",
                qr_expires_at: time,
                activated_at: time,
                expires_at: earlier(
                  plus(time, limits.visitSeconds),
                  authority.family.expires_at,
                  binding.expires_at,
                  registration.expires_at,
                ),
                active_visit_id: null,
                registration_id: registration.id,
                visit_only: true,
              };
              await tx`INSERT INTO ${tables.devices}(app_id,id,request_id,input_digest,owner_user_id,initiator_sid,auth_epoch,name,secret_hash,browser_hash,state,issued_at,qr_expires_at,activated_at,expires_at,registration_id,visit_only)
                VALUES (${appId},${device.id}::uuid,${input.requestId}::uuid,${device.input_digest},${device.owner_user_id}::uuid,${device.initiator_sid}::uuid,${device.auth_epoch},${device.name},${device.secret_hash},${device.browser_hash},'active',${time},${time},${time},${device.expires_at},${registration.id}::uuid,true)`;
              // Same lock order as takeover: registration -> previous use/visit -> browser.
              await tx`SELECT 1 FROM ${tables.browsers} WHERE app_id = ${appId} AND credential_hash = ${binding.credential_hash} FOR UPDATE`;
              await tx`UPDATE ${tables.browsers} SET device_id = ${device.id}::uuid
                WHERE app_id = ${appId} AND credential_hash = ${binding.credential_hash}`;
            }
          } else {
            device = await ownedDevice(tx, signIn, input.deviceId);
            // A visit-only carrier is never an alternate owner-scoped issuance target.
            if (device.visit_only) return pwaFail("FORBIDDEN", 403);
          }
          beforeCommit.deadline((time) => checkDevice(device, time, authority.user.auth_epoch));
          // Ownership belongs to the employee, not the browser used to open
          // this staff screen. The pairing family's authority must still live.
          if (device.initiator_sid !== signIn.sid) {
            const initiating = await lockWebAuthority(tx, { userId: device.owner_user_id, sid: device.initiator_sid });
            beforeCommit.deadline(initiating.check);
          }
          checkDevice(device, await databaseClock(tx), authority.user.auth_epoch);
          const authorizeSubject = async () => {
            if (!(await options.authorizeVisit(signIn, subject, tx))) pwaFail("FORBIDDEN", 403);
          };
          await authorizeSubject();
          beforeCommit.authorize(authorizeSubject);
          // Unchanged digest for QR visits keeps retries across an upgrade stable.
          const digest = appPwaDigest(
            input.registrationId !== undefined
              ? { registrationId: device.registration_id, subject, push }
              : push
                ? { deviceId: device.id, subject, push }
                : { deviceId: device.id, subject },
          );
          const [existing] = await tx<
            Visit[]
          >`SELECT * FROM ${tables.visits} WHERE app_id = ${appId} AND device_id = ${device.id}::uuid AND request_id = ${input.requestId}::uuid FOR UPDATE`;
          if (existing && existing.input_digest !== digest) return pwaFail("ATTEMPT_CONFLICT", 409);
          const time = await databaseClock(tx);
          if (existing && existing.state !== "pending")
            return { ...visitView(existing, time), qr: null, qrExpiresAt: existing.qr_expires_at.toISOString() };
          if (existing && existing.qr_expires_at <= time) return pwaFail("EXPIRED", 410);
          const secret = pairingSecret.create();
          const id = existing?.id ?? crypto.randomUUID();
          if (push) {
            // Same rules as a claim: one live visit per device, deadlines from activation, bound to the device's browser.
            if (device.active_visit_id) {
              const current = await lockVisit(tx, device.active_visit_id);
              if (liveVisit(current, time)) return pwaFail("ACTIVE_VISIT", 409);
            }
            const visit: Visit = {
              issued_at: time,
              id,
              device_id: device.id,
              input_digest: digest,
              secret_hash: pairingSecret.hash(secret),
              subject,
              state: "active",
              browser_hash: device.browser_hash,
              qr_expires_at: time,
              activated_at: time,
              last_used_at: time,
              expires_at: earlier(plus(time, limits.visitSeconds), device.expires_at ?? time),
            };
            await tx`INSERT INTO ${tables.visits}(app_id,id,device_id,request_id,input_digest,secret_hash,subject,browser_hash,state,issued_at,qr_expires_at,activated_at,last_used_at,expires_at)
          VALUES (${appId},${id}::uuid,${device.id}::uuid,${input.requestId}::uuid,${digest},${visit.secret_hash},${JSON.stringify(subject)}::text::jsonb,${visit.browser_hash},'active',${time},${time},${time},${time},${visit.expires_at})`;
            await tx`UPDATE ${tables.devices} SET active_visit_id = ${id}::uuid WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
            await record(tx, "visit.pushed", signIn, device.id, id, replacement);
            checkDevice(device, await databaseClock(tx), authority.user.auth_epoch);
            return { ...visitView(visit, time), qr: null, qrExpiresAt: time.toISOString() };
          }
          const expires = existing?.qr_expires_at ?? earlier(plus(time, limits.qrSeconds), device.expires_at ?? time);
          if (existing)
            await tx`UPDATE ${tables.visits} SET secret_hash = ${pairingSecret.hash(secret)} WHERE app_id = ${appId} AND id = ${id}::uuid`;
          else {
            await tx`INSERT INTO ${tables.visits}(app_id,id,device_id,request_id,input_digest,secret_hash,subject,state,issued_at,qr_expires_at)
          VALUES (${appId},${id}::uuid,${device.id}::uuid,${input.requestId}::uuid,${digest},${pairingSecret.hash(secret)},${JSON.stringify(subject)}::text::jsonb,'pending',${time},${expires})`;
            await record(tx, "visit.issued", signIn, device.id, id);
          }
          checkDevice(device, await databaseClock(tx), authority.user.auth_epoch);
          return {
            id,
            state: "pending",
            expiresAt: null,
            idleExpiresAt: null,
            qr: appPwaQr(origin.origin, path, { kind: "visit", secret }),
            qrExpiresAt: expires.toISOString(),
          };
        },
        signal,
      ),
    claimVisit: (credential: string, qr: string, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, _signal, beforeCommit) => {
          const parsed = parseAppPwaQr(qr, origin.origin, path);
          if (parsed?.kind !== "visit") return pwaFail("INVALID_QR", 400);
          const [identity] = await tx<
            Visit[]
          >`SELECT * FROM ${tables.visits} WHERE app_id = ${appId} AND secret_hash = ${pairingSecret.hash(parsed.secret)}`;
          if (!identity || identity.device_id !== device.id) return pwaFail("INVALID_QR", 400);
          const visit = await lockVisit(tx, identity.id);
          beforeCommit.deadline((time) => checkVisit(visit, time));
          const time = await databaseClock(tx);
          if (!pairingSecret.matches(parsed.secret, visit.secret_hash)) return pwaFail("INVALID_QR", 400);
          if (visit.state !== "pending") {
            if (visit.browser_hash !== device.browser_hash) return pwaFail("ALREADY_CLAIMED", 409);
            checkVisit(visit, time);
            if (device.active_visit_id !== visit.id) return pwaFail("REVOKED", 410);
          } else {
            if (visit.qr_expires_at <= time) return pwaFail("EXPIRED", 410);
            if (device.active_visit_id) {
              const current = await lockVisit(tx, device.active_visit_id);
              if (liveVisit(current, time)) return pwaFail("ACTIVE_VISIT", 409);
            }
            visit.expires_at = earlier(plus(time, limits.visitSeconds), device.expires_at ?? time);
            visit.last_used_at = time;
            visit.state = "active";
            await tx`UPDATE ${tables.visits} SET state = 'active', browser_hash = ${device.browser_hash}, activated_at = ${time}, last_used_at = ${time}, expires_at = ${visit.expires_at}
          WHERE app_id = ${appId} AND id = ${visit.id}::uuid`;
            await tx`UPDATE ${tables.devices} SET active_visit_id = ${visit.id}::uuid WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
            await record(tx, "visit.claimed", deviceActor(device), device.id, visit.id);
          }
          checkVisit(visit, await databaseClock(tx));
          return visitView(visit, await databaseClock(tx));
        },
        signal,
      ),
    /** A registered browser also sees its registration and the current user's display name, never visit data without a visit. */
    status: (credential: string, signal?: AbortSignal) =>
      transaction(async (tx, requestSignal, beforeCommit) => {
        const work: GuestWork<{ device: AppPwaDeviceView; visit: AppPwaVisitView | null; ownerUserId: string }> = async (
          tx,
          device,
          _signal,
          beforeCommit,
        ) => {
          const time = await databaseClock(tx);
          if (!device.active_visit_id) return { device: deviceView(device, time), visit: null, ownerUserId: device.owner_user_id };
          const visit = await boundVisit(tx, device, device.active_visit_id);
          if (!liveVisit(visit, time)) return { device: deviceView(device, time), visit: null, ownerUserId: device.owner_user_id };
          beforeCommit.deadline((time) => checkVisit(visit, time));
          return { device: deviceView(device, time), visit: visitView(visit, time), ownerUserId: device.owner_user_id };
        };
        // Unlocked read: a registration lock here would invert the takeover lock order.
        // A concurrent revocation is seen by the next poll; a stale "free" view carries no data.
        const registration = await liveRegistration(tx, (await browser(tx, credential)).credential_hash);
        if (!registration) {
          const { ownerUserId: _owner, ...current } = await guestIn(tx, credential, requestSignal, beforeCommit, work);
          return { ...current, registration: null };
        }
        beforeCommit.deadline((time) => {
          if (registration.expires_at <= time) pwaFail("BROWSER_REQUIRED", 401);
          return registration.expires_at;
        });
        // Collect the use's commit checks separately, so an ended use reports "free" instead of failing.
        const authorizations: (() => Promise<void>)[] = [];
        const deadlines: ((time: Date) => Date)[] = [];
        try {
          const current = await guestIn(
            tx,
            credential,
            requestSignal,
            {
              authorize: (check) => authorizations.push(check),
              deadline: (check) => deadlines.push(check),
            },
            work,
          );
          authorizations.forEach(beforeCommit.authorize);
          deadlines.forEach(beforeCommit.deadline);
          const [carrier] = current.device
            ? await tx<Device[]>`SELECT * FROM ${tables.devices}
            WHERE app_id = ${appId} AND id = ${current.device.id}::uuid`
            : [];
          if (carrier?.visit_only && !current.visit)
            return { device: null, visit: null, registration: registrationGuestView(registration, null, await databaseClock(tx)) };
          const displayName = await holderName(tx, current.ownerUserId);
          return {
            device: current.device,
            visit: current.visit,
            registration: registrationGuestView(registration, carrier?.visit_only ? null : { displayName }, await databaseClock(tx)),
          };
        } catch (error) {
          if (!leaseEnded(error)) throw error;
          return { device: null, visit: null, registration: registrationGuestView(registration, null, await databaseClock(tx)) };
        }
      }, signal),
    coreQuery: async (
      credential: string,
      visitId: string | undefined,
      query: string,
      input: unknown,
      signal?: AbortSignal,
      locale?: string,
    ) => {
      const requestSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(REQUEST_IDLE_TIMEOUT_SECONDS * 1000)]);
      return untilAppPwaAbort(requestSignal, async () => {
        if (query !== "address.autocomplete" || !coreQueries.has(query)) return pwaFail("FORBIDDEN", 403);
        const value = parse(GeoAutocompleteInputSchema, bounded(input, options.budgets.requestBytes));
        const actor = await guest(
          credential,
          (tx, device, _signal, beforeCommit) => coreActor(tx, device, beforeCommit, visitId),
          requestSignal,
        );
        try {
          // No pairing transaction or settings lock spans a pool checkout or provider request.
          // Bound each device/visit by both the operator's request budget and the Geo plan's RPS.
          const [requestRate, geoConfig] = await Promise.all([getSetting<number>("security.rate_limit_per_second"), readGeoConfig()]);
          if (requestSignal.aborted) return pwaFail("UNAVAILABLE", 503);
          const limiter = ratelimit({ id: `app-pwa:${appId}:core`, limit: Math.min(requestRate, geoPlan(geoConfig).rps) });
          if ((await limiter.check(`device:${actor.deviceId}`)).limited) return pwaFail("RATE_LIMITED", 429);
          if (actor.kind === "visit" && (await limiter.check(`visit:${actor.visitId}`)).limited) return pwaFail("RATE_LIMITED", 429);
          if (requestSignal.aborted) return pwaFail("UNAVAILABLE", 503);
          const result = bounded(await coreGeo.autocompleteForAppPwa(value, { actor, signal: requestSignal, locale }));
          await guest(
            credential,
            async (tx, device, _signal, beforeCommit) => {
              const current = await coreActor(tx, device, beforeCommit, actor.kind === "visit" ? actor.visitId : undefined);
              // A newly opened visit changes device-mode authority; retry with its current status.
              if (current.kind !== actor.kind) return pwaFail("UNAVAILABLE", 503);
              if (current.deviceId !== actor.deviceId || current.ownerUserId !== actor.ownerUserId) return pwaFail("REVOKED", 410);
              await recordCoreQuery(current, "allowed", undefined, tx);
              return null;
            },
            requestSignal,
          );
          return result;
        } catch (error) {
          const code = error instanceof AppPwaError || error instanceof GeoError ? error.code : "UNAVAILABLE";
          await recordCoreQuery(
            actor,
            error instanceof AppPwaError || (error instanceof GeoError && error.status < 500) ? "denied" : "failed",
            code,
          );
          if (error instanceof GeoError) throw new AppPwaCoreQueryError(error);
          if (error instanceof AppPwaError) throw error;
          return pwaFail("UNAVAILABLE", 503);
        }
      });
    },
    query: (credential: string, visitId: string, route: string, input: unknown, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, requestSignal, beforeCommit) => {
          const operation = Object.hasOwn(options.queries ?? {}, route) ? options.queries?.[route] : undefined;
          if (!operation) return pwaFail("NOT_FOUND", 404);
          const visit = await boundVisit(tx, device, visitId);
          if (device.active_visit_id !== visit.id) return pwaFail("REVOKED", 410);
          beforeCommit.deadline((time) => checkVisit(visit, time));
          checkVisit(visit, await databaseClock(tx));
          const result = bounded(
            await operation.run(
              { actor: visitActor(device, visit), tx, signal: requestSignal },
              bounded(input, options.budgets.requestBytes),
            ),
          );
          checkVisit(visit, await databaseClock(tx));
          return result;
        },
        signal,
      ),
    command: (credential: string, visitId: string, route: string, attemptId: string, input: unknown, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, requestSignal, beforeCommit) => {
          const operation = Object.hasOwn(options.commands ?? {}, route) ? options.commands?.[route] : undefined;
          if (!operation) return pwaFail("NOT_FOUND", 404);
          const visit = await boundVisit(tx, device, visitId);
          const digest = appPwaDigest(operation.parse(bounded(input, options.budgets.requestBytes)));
          const stored = await readAttempt(tx, visit.id, attemptId);
          const timeBefore = await databaseClock(tx);
          const live = device.active_visit_id === visit.id && liveVisit(visit, timeBefore);
          if (stored) {
            if (stored.route !== route || stored.input_digest !== digest) return pwaFail("ATTEMPT_CONFLICT", 409);
            if (!live) return { state: "committed" as const, completed: visit.state === "ended", replayed: true, result: null };
            beforeCommit.deadline((time) => checkVisit(visit, time));
            return { result: stored.result, replayed: true };
          }
          if (device.active_visit_id !== visit.id) return pwaFail("REVOKED", 410);
          checkVisit(visit, timeBefore);
          beforeCommit.deadline((time) => checkVisit(visit, time));
          let ended = false;
          const actor = visitActor(device, visit);
          const result = bounded(
            await operation.run(
              {
                actor,
                tx,
                signal: requestSignal,
                endVisit: () => {
                  ended = true;
                },
              },
              input,
            ),
          );
          // Expiry after domain locks/work rolls back domain writes as well as the attempt.
          const time = await databaseClock(tx);
          checkVisit(visit, time);
          await tx`INSERT INTO ${tables.attempts}(app_id,visit_id,attempt_id,route,input_digest,result)
        VALUES (${appId},${visit.id}::uuid,${parse(AppPwaId, attemptId)}::uuid,${route},${digest},${JSON.stringify(result)}::text::jsonb)`;
          await tx`UPDATE ${tables.visits} SET last_used_at = ${time}, state = ${ended ? "ended" : "active"} WHERE app_id = ${appId} AND id = ${visit.id}::uuid`;
          await record(tx, ended ? "visit.completed" : "visit.command", actor, device.id, visit.id);
          checkVisit(visit, await databaseClock(tx));
          // A completing command ends content access immediately, including this response.
          return ended ? { state: "committed" as const, completed: true, result: null, replayed: false } : { result, replayed: false };
        },
        signal,
      ),
    attempt: (credential: string, visitId: string, attemptId: string, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device) => {
          const visit = await boundVisit(tx, device, visitId);
          const stored = await readAttempt(tx, visit.id, attemptId);
          // Reconciliation is status-only. Old customer attempts can never reveal
          // stored domain output, even when a new visit now occupies this device.
          return stored ? { state: "committed" as const, completed: visit.state === "ended" } : { state: "unknown" as const };
        },
        signal,
      ),
    endVisit: (credential: string, visitId: string, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device) => {
          const visit = await boundVisit(tx, device, visitId);
          if (visit.state === "active") {
            await tx`UPDATE ${tables.visits} SET state = 'revoked' WHERE app_id = ${appId} AND id = ${visit.id}::uuid`;
            await record(tx, "visit.revoked", visitActor(device, visit), device.id, visit.id);
          }
          return { state: "revoked" };
        },
        signal,
      ),
    revokeVisit: (signIn: AppPwaWebSignIn, target: string | { registrationId: string }, visitId: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "revoke-visit",
        async (tx, _authority, beforeCommit) => {
          let device: Device;
          if (typeof target === "string") {
            // Discover the registration without reversing registration -> device lock order.
            const [identity] = await tx<Device[]>`SELECT * FROM ${tables.devices}
              WHERE app_id = ${appId} AND id = ${parse(AppPwaId, target)}::uuid AND owner_user_id = ${signIn.userId}::uuid`;
            if (identity?.visit_only && identity.registration_id) {
              const registration = await lockRegistration(tx, identity.registration_id);
              await authorizeTarget(tx, signIn, "revoke-visit", { registrationId: registration.id, name: registration.name }, beforeCommit);
            }
            device = await ownedDevice(tx, signIn, target);
          } else {
            if (options.registeredDevices?.push !== "staff") return pwaFail("FORBIDDEN", 403);
            const registration = await lockRegistration(tx, target.registrationId);
            await authorizeTarget(tx, signIn, "revoke-visit", { registrationId: registration.id, name: registration.name }, beforeCommit);
            // Resolve the supplied visit under the registration lock, never revoke a different current visit.
            const [identity] = await tx<
              Visit[]
            >`SELECT * FROM ${tables.visits} WHERE app_id = ${appId} AND id = ${parse(AppPwaId, visitId)}::uuid`;
            if (!identity) return pwaFail("NOT_FOUND", 404);
            device = await lockDevice(tx, identity.device_id);
            if (device.registration_id !== registration.id) return pwaFail("NOT_FOUND", 404);
          }
          const visit = await lockVisit(tx, visitId);
          if (visit.device_id !== device.id) return pwaFail("NOT_FOUND", 404);
          if (visit.state !== "revoked" && visit.state !== "ended") {
            await tx`UPDATE ${tables.visits} SET state = 'revoked' WHERE app_id = ${appId} AND id = ${visit.id}::uuid`;
            await record(tx, "visit.revoked", signIn, device.id, visit.id);
          }
          return { state: "revoked" };
        },
        signal,
      ),
    /** Every registered device of this application with its current user, for any authorized staff member. */
    listRegistrations: (signIn: AppPwaWebSignIn, after?: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "list-registrations",
        async (tx, _authority, beforeCommit) => {
          if (after) parse(AppPwaId, after);
          const page = await tx<(Registration & { device_id: string | null })[]>`SELECT r.*, b.device_id
            FROM ${tables.registrations} r LEFT JOIN ${tables.browsers} b ON b.app_id = r.app_id AND b.credential_hash = r.browser_hash
            WHERE r.app_id = ${appId} AND r.state = 'active' ${after ? db()`AND r.id > ${after}::uuid` : db()``}
            ORDER BY r.id LIMIT ${options.budgets.listPageSize}`;
          // The page cursor stays on the unfiltered rows, so hidden registrations never stall paging.
          const rows: typeof page = [];
          for (const row of page) {
            const target = { registrationId: row.id, name: row.name };
            if (!(await options.authorizeStaff("list-registrations", signIn, tx, target))) continue;
            rows.push(row);
            // A registration in the response must still be allowed when the transaction commits.
            beforeCommit.authorize(async () => {
              if (!(await options.authorizeStaff("list-registrations", signIn, tx, target))) pwaFail("FORBIDDEN", 403);
            });
          }
          const leaseIds = rows.flatMap((row) => (row.device_id ? [row.device_id] : []));
          const leases = leaseIds.length
            ? await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND id = ANY(${db().array(leaseIds, "uuid")})`
            : [];
          const views = new Map((await staffDeviceViews(tx, leases)).map((view) => [view.id, view]));
          const ownerIds = [...new Set(leases.map((lease) => lease.owner_user_id))];
          const owners = ownerIds.length
            ? await tx<
                { id: string; name: string; display_name: string | null }[]
              >`SELECT id, NULLIF(trim(display_name), '') AS display_name, COALESCE(NULLIF(trim(display_name), ''), uid) AS name
              FROM auth.users WHERE id = ANY(${db().array(ownerIds, "uuid")})`
            : [];
          const names = new Map(owners.map((owner) => [owner.id, owner.name]));
          const visitIds = leases.flatMap((lease) => (lease.active_visit_id ? [lease.active_visit_id] : []));
          const visits = visitIds.length
            ? await tx<Visit[]>`SELECT * FROM ${tables.visits} WHERE app_id = ${appId} AND id = ANY(${db().array(visitIds, "uuid")})`
            : [];
          const time = await databaseClock(tx);
          const liveVisits = new Set(visits.filter((visit) => liveVisit(visit, time)).map((visit) => visit.id));
          const items: AppPwaRegistrationView[] = rows.map((row) => {
            const lease = leases.find((device) => device.id === row.device_id);
            const view = lease ? views.get(lease.id) : undefined;
            const visit =
              lease && view?.state === "active" && row.expires_at > time
                ? visits.find((visit) => visit.id === lease.active_visit_id && liveVisits.has(visit.id))
                : undefined;
            return {
              id: row.id,
              name: row.name,
              state: row.expires_at > time ? "active" : "expired",
              registeredAt: row.registered_at.toISOString(),
              expiresAt: row.expires_at.toISOString(),
              activeVisit:
                visit && lease
                  ? {
                      id: visit.id,
                      issuedBy: { displayName: owners.find((owner) => owner.id === lease.owner_user_id)?.display_name ?? null },
                      issuedAt: visit.issued_at.toISOString(),
                    }
                  : null,
              holder:
                lease && !lease.visit_only && view?.state === "active" && row.expires_at > time
                  ? {
                      userId: lease.owner_user_id,
                      displayName: names.get(lease.owner_user_id) ?? "",
                      deviceId: lease.id,
                      expiresAt: view.expiresAt,
                      visitActive: !!lease.active_visit_id && liveVisits.has(lease.active_visit_id),
                    }
                  : null,
            };
          });
          return { items, next: page.length === options.budgets.listPageSize ? (page.at(-1)?.id ?? null) : null };
        },
        signal,
      ),
    /**
     * Start using a registered device. A live use by anyone else is replaced only when
     * `expectedDeviceId` names it (the use the staff UI showed and the person confirmed).
     * The previous use and its running visit end in the same transaction.
     */
    takeOverDevice: async (
      signIn: AppPwaWebSignIn,
      input: { registrationId: string; expectedDeviceId: string | null; presenceCode: string },
      signal?: AbortSignal,
    ) => {
      parse(z.strictObject({ registrationId: AppPwaId, expectedDeviceId: AppPwaId.nullable(), presenceCode: z.string().max(16) }), input);
      // Staff-push applications have no holder/takeover workflow. Existing applications retain it.
      if (options.registeredDevices?.push === "staff") return pwaFail("FORBIDDEN", 403);
      // Every attempt counts, also a correct one, so guessing stays bounded per displayed code.
      let limited: boolean;
      try {
        // PostgreSQL accepts any UUID casing; one canonical key keeps one counter per registration.
        limited = (await presenceLimiter.check(input.registrationId.toLowerCase())).limited;
      } catch {
        return pwaFail("UNAVAILABLE", 503);
      }
      if (limited) return pwaFail("RATE_LIMITED", 429);
      return staff(
        signIn,
        "take-over-device",
        async (tx, authority, beforeCommit) => {
          // Lock order: web authority -> registration -> previous use -> its visit -> browser binding.
          const registration = await lockRegistration(tx, input.registrationId);
          await authorizeTarget(tx, signIn, "take-over-device", { registrationId: registration.id, name: registration.name }, beforeCommit);
          let time = await databaseClock(tx);
          if (registration.state === "revoked") return pwaFail("REVOKED", 410);
          if (registration.expires_at <= time) return pwaFail("EXPIRED", 410);
          // The binding's device pointer changes only under this registration lock.
          const [snapshot] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
            WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash}`;
          if (!snapshot || snapshot.expires_at <= time) return pwaFail("EXPIRED", 410);
          // Presence at the device: only its registered browser sees this code. An orphaned
          // registration whose browser is gone can therefore not be taken over.
          if (!presenceMatches(registration, input.presenceCode, time)) return pwaFail("PRESENCE_REQUIRED", 403);
          const previous = snapshot.device_id ? await lockDevice(tx, snapshot.device_id) : undefined;
          const [previousView] = previous ? await staffDeviceViews(tx, [previous]) : [];
          const live = previous && previousView?.state === "active" ? previous : undefined;
          if (live && live.owner_user_id === signIn.userId && live.initiator_sid === signIn.sid) {
            // A retry from the session that already uses the device changes nothing.
            return {
              registration: registrationStaffView(registration, { displayName: await holderName(tx, signIn.userId) }),
              device: deviceView(live, time),
            };
          }
          if (live && live.id !== input.expectedDeviceId) return pwaFail("IN_USE", 409);
          const endedVisitId = previous ? await endUse(tx, previous, signIn) : null;
          const [binding] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
            WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash} FOR UPDATE`;
          if (!binding || binding.device_id !== snapshot.device_id) return pwaFail("UNAVAILABLE", 503);
          time = await databaseClock(tx);
          const device: Device = {
            id: crypto.randomUUID(),
            owner_user_id: signIn.userId,
            initiator_sid: signIn.sid,
            auth_epoch: authority.user.auth_epoch,
            name: registration.name,
            input_digest: appPwaDigest({ registrationId: registration.id }),
            // Never revealed: a use is bound by takeover, not by a QR.
            secret_hash: pairingSecret.hash(pairingSecret.create()),
            browser_hash: binding.credential_hash,
            state: "active",
            qr_expires_at: time,
            activated_at: time,
            expires_at: earlier(plus(time, ttl), authority.family.expires_at, binding.expires_at, registration.expires_at),
            active_visit_id: null,
            registration_id: registration.id,
            visit_only: false,
          };
          await tx`INSERT INTO ${tables.devices}(app_id,id,request_id,input_digest,owner_user_id,initiator_sid,auth_epoch,name,secret_hash,browser_hash,state,issued_at,qr_expires_at,activated_at,expires_at,registration_id)
            VALUES (${appId},${device.id}::uuid,${crypto.randomUUID()}::uuid,${device.input_digest},${device.owner_user_id}::uuid,${device.initiator_sid}::uuid,${device.auth_epoch},${device.name},${device.secret_hash},${device.browser_hash},'active',${time},${time},${time},${device.expires_at},${registration.id}::uuid)`;
          await tx`UPDATE ${tables.browsers} SET device_id = ${device.id}::uuid WHERE app_id = ${appId} AND credential_hash = ${binding.credential_hash}`;
          await record(tx, "registration.taken_over", signIn, device.id, endedVisitId, {
            registrationId: registration.id,
            previousDeviceId: previous?.id ?? null,
            previousOwnerUserId: live?.owner_user_id ?? null,
          });
          return {
            registration: registrationStaffView(registration, { displayName: await holderName(tx, signIn.userId) }),
            device: deviceView(device, time),
          };
        },
        signal,
      );
    },
    renameRegistration: (signIn: AppPwaWebSignIn, input: { registrationId: string; name: string }, signal?: AbortSignal) =>
      staff(
        signIn,
        "rename-registration",
        async (tx, _authority, beforeCommit) => {
          const name = parse(z.string().trim().min(1).max(PWA_LIMITS.nameMaxLength), input.name);
          const registration = await lockRegistration(tx, input.registrationId);
          await authorizeTarget(
            tx,
            signIn,
            "rename-registration",
            { registrationId: registration.id, name: registration.name },
            beforeCommit,
          );
          if (registration.state === "revoked") return pwaFail("REVOKED", 410);
          if (registration.expires_at <= (await databaseClock(tx))) return pwaFail("EXPIRED", 410);
          await tx`UPDATE ${tables.registrations} SET name = ${name} WHERE app_id = ${appId} AND id = ${registration.id}::uuid`;
          await record(tx, "registration.renamed", signIn, null, null, {
            registrationId: registration.id,
            previousName: registration.name,
            name,
          });
          return { id: registration.id, name };
        },
        signal,
      ),
    /** Unregister a shared device: its use and visit end and its browser must be registered again. */
    revokeRegistration: (signIn: AppPwaWebSignIn, registrationId: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "revoke-registration",
        async (tx, _authority, beforeCommit) => {
          const registration = await lockRegistration(tx, registrationId);
          await authorizeTarget(
            tx,
            signIn,
            "revoke-registration",
            { registrationId: registration.id, name: registration.name },
            beforeCommit,
          );
          if (registration.state === "revoked") return { state: "revoked" };
          const [snapshot] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
            WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash}`;
          const previous = snapshot?.device_id ? await lockDevice(tx, snapshot.device_id) : undefined;
          const endedVisitId = previous ? await endUse(tx, previous, signIn) : null;
          const time = await databaseClock(tx);
          await tx`SELECT 1 FROM ${tables.browsers} WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash} FOR UPDATE`;
          await tx`UPDATE ${tables.browsers} SET expires_at = LEAST(expires_at, ${time})
            WHERE app_id = ${appId} AND credential_hash = ${registration.browser_hash}`;
          await tx`UPDATE ${tables.registrations} SET state = 'revoked', revoked_at = ${time}
            WHERE app_id = ${appId} AND id = ${registration.id}::uuid`;
          await record(tx, "registration.revoked", signIn, previous?.id ?? null, endedVisitId, {
            registrationId: registration.id,
            previousOwnerUserId: previous?.owner_user_id ?? null,
          });
          return { state: "revoked" };
        },
        signal,
      ),
    deviceOperation: (credential: string, route: string, input: unknown, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, requestSignal, beforeCommit) => {
          if (device.visit_only) {
            if (!device.active_visit_id) return pwaFail("REVOKED", 410);
            const visit = await boundVisit(tx, device, device.active_visit_id);
            checkVisit(visit, await databaseClock(tx));
            beforeCommit.deadline((time) => checkVisit(visit, time));
          }
          const operation = Object.hasOwn(options.deviceOperations ?? {}, route) ? options.deviceOperations?.[route] : undefined;
          const ceiling = Object.hasOwn(options.devicePermissions ?? {}, route) ? options.devicePermissions?.[route] : undefined;
          if (!operation || !ceiling || !hasPermission(ceiling, operation.permission)) return pwaFail("FORBIDDEN", 403);
          const context = { actor: deviceActor(device), tx, signal: requestSignal };
          // getEffectivePermission reads these canonical tables, including nested
          // membership. SHARE also covers missing membership rows/INSERTs. The
          // app's accessIds resolver must lock its resource/junction authority.
          await tx`LOCK TABLE auth.access, auth.groups, auth.user_groups_v2, auth.group_groups_v2 IN SHARE MODE`;
          const checkPermission = async () => {
            const ids = await operation.accessIds(context, bounded(input, options.budgets.requestBytes));
            if (ids.length > options.budgets.maxAccessIds) return pwaFail("TOO_LARGE", 413);
            ids.forEach((id) => parse(AppPwaId, id));
            const current = await getEffectivePermission({ accessIds: ids, subject: { type: "user", userId: device.owner_user_id } }, tx);
            if (!hasPermission(current, operation.permission)) return pwaFail("FORBIDDEN", 403);
          };
          await checkPermission();
          beforeCommit.authorize(checkPermission);
          const result = bounded(await operation.run(context, input));
          await record(tx, "device.operation", context.actor, device.id);
          return result;
        },
        signal,
      ),
  };
};

export type AppPwaService = ReturnType<typeof createAppPwaService>;
