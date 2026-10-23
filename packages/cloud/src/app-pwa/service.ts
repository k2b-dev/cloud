import { sql, type TransactionSQL } from "bun";
import { z } from "zod";
import { isInstallablePath } from "../contracts/installable";
import { PWA_LIMITS } from "../contracts/pwa";
import { getEffectivePermission, hasPermission } from "../server/services/access";
import { audit } from "../services/audit";
import { pairingSecret } from "../services/pairing-secret";
import { databaseClock, lockWebAuthority } from "./authority";
import {
  type AppPwaActor,
  type AppPwaDeviceActor,
  type AppPwaDeviceView,
  AppPwaError,
  AppPwaId,
  type AppPwaOptions,
  AppPwaSecret,
  type AppPwaStaffAction,
  type AppPwaVisitActor,
  type AppPwaVisitView,
  type AppPwaWebSignIn,
  APP_PWA_LIMITS as limits,
  parseAppPwaInput as parse,
  pwaFail,
} from "./contracts";
import { appPwaQr, parseAppPwaQr } from "./protocol";
import { appPwaSchemaName, setupAppPwa } from "./schema";
import { withAppPwaTransaction } from "./transaction";

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
};
type Visit = {
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
  const db = options.db ?? sql;
  const appId = options.app.id;
  const path = options.app.installable.path;
  const origin = new URL(options.publicOrigin);
  if (origin.protocol !== "https:" || origin.origin !== options.publicOrigin || !isInstallablePath(appId, path))
    throw new Error("App-PWA requires a canonical HTTPS public origin and the declared installable path");
  const schema = appPwaSchemaName(options.schema);
  const tables = {
    browsers: sql(`${schema}._cloud_pwa_browsers`),
    devices: sql(`${schema}._cloud_pwa_devices`),
    visits: sql(`${schema}._cloud_pwa_visits`),
    attempts: sql(`${schema}._cloud_pwa_attempts`),
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
        db,
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
  const record = (
    tx: TransactionSQL,
    event: string,
    actor: AppPwaActor | AppPwaWebSignIn,
    deviceId: string | null,
    visitId: string | null = null,
  ) =>
    audit.record(
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
        },
      },
      tx,
    );
  const csrf = (credential: string) => pairingSecret.hash(`cloud-app-pwa:csrf:${appId}:${path}:${credential}`);
  const browser = async (tx: TransactionSQL, credential: string, lock = false): Promise<Browser> => {
    parse(AppPwaSecret, credential);
    const [row] = await tx<Browser[]>`SELECT * FROM ${tables.browsers}
      WHERE app_id = ${appId} AND credential_hash = ${pairingSecret.hash(credential)} ${lock ? sql`FOR UPDATE` : sql``}`;
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
  const staffDeviceViews = async (tx: TransactionSQL, devices: Device[], epoch: string): Promise<AppPwaDeviceView[]> => {
    if (!devices.length) return [];
    const families = await tx<
      {
        sid: string;
        auth_epoch: string;
        expires_at: Date;
        revoked_at: Date | null;
        pwa_device_id: string | null;
        key_state: string;
      }[]
    >`SELECT f.sid,f.auth_epoch,f.expires_at,f.revoked_at,f.pwa_device_id,k.state AS key_state
      FROM auth.session_families f JOIN auth.signing_keys k ON k.kid=f.signing_kid
      WHERE f.sid=ANY(${devices.map((device) => device.initiator_sid)}::uuid[])`;
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
        String(family.auth_epoch) !== String(epoch) ||
        String(device.auth_epoch) !== String(epoch)
      ) {
        return { ...view, state: "revoked" };
      }
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
  const guest = async <T>(
    credential: string,
    work: (tx: TransactionSQL, device: Device, signal: AbortSignal, beforeCommit: BeforeCommit) => Promise<T>,
    signal?: AbortSignal,
  ) =>
    transaction(async (tx, requestSignal, beforeCommit) => {
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
    }, signal);
  const boundVisit = async (tx: TransactionSQL, device: Device, visitId: string) => {
    const visit = await lockVisit(tx, visitId);
    if (visit.device_id !== device.id || visit.browser_hash !== device.browser_hash) return pwaFail("NOT_FOUND", 404);
    return visit;
  };
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
      await setupAppPwa(db, schema);
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
              if (
                !(error instanceof AppPwaError) ||
                !["EXPIRED", "REVOKED", "WEB_SESSION_REQUIRED", "BROWSER_REQUIRED"].includes(error.code)
              )
                throw error;
              live = false;
            }
          }
          if (live && binding) {
            beforeCommit.deadline((time) => {
              if (binding.expires_at <= time) pwaFail("BROWSER_REQUIRED", 401);
              return binding.expires_at;
            });
            return { credential: existingCredential, csrf: csrf(existingCredential) };
          }
        }
        const credential = pairingSecret.create();
        await tx`INSERT INTO ${tables.browsers}(app_id, credential_hash, expires_at)
          VALUES (${appId}, ${pairingSecret.hash(credential)}, ${plus(await databaseClock(tx), limits.deviceSeconds)})`;
        return { credential, csrf: csrf(credential) };
      }, signal),
    issueDevice: (signIn: AppPwaWebSignIn, input: { requestId: string; name: string }, signal?: AbortSignal) =>
      staff(
        signIn,
        "issue-device",
        async (tx, authority) => {
          parse(z.strictObject({ requestId: AppPwaId, name: z.string().trim().min(1).max(PWA_LIMITS.nameMaxLength) }), input);
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
          const expires = existing?.qr_expires_at ?? earlier(plus(time, limits.qrSeconds), authority.family.expires_at);
          if (existing)
            await tx`UPDATE ${tables.devices} SET secret_hash = ${pairingSecret.hash(secret)} WHERE app_id = ${appId} AND id = ${id}::uuid`;
          else {
            await tx`INSERT INTO ${tables.devices}(app_id,id,request_id,input_digest,owner_user_id,initiator_sid,auth_epoch,name,secret_hash,state,issued_at,qr_expires_at)
          VALUES (${appId},${id}::uuid,${input.requestId}::uuid,${digest},${signIn.userId}::uuid,${signIn.sid}::uuid,${authority.user.auth_epoch},${input.name},${pairingSecret.hash(secret)},'pending',${time},${expires})`;
            await record(tx, "device.issued", signIn, id);
          }
          return {
            id,
            name: input.name,
            state: "pending",
            expiresAt: null,
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
          const expires = earlier(plus(time, ttl), authority.family.expires_at, binding.expires_at);
          await tx`UPDATE ${tables.devices} SET browser_hash = ${binding.credential_hash}, state = 'active', activated_at = ${time}, expires_at = ${expires}
          WHERE app_id = ${appId} AND id = ${device.id}::uuid`;
          await tx`UPDATE ${tables.browsers} SET device_id = ${device.id}::uuid WHERE app_id = ${appId} AND credential_hash = ${binding.credential_hash}`;
          device.state = "active";
          device.expires_at = expires;
          await record(tx, "device.claimed", deviceActor(device), device.id);
        }
        const finish = await databaseClock(tx);
        await authority.check(finish);
        checkDevice(device, finish, authority.user.auth_epoch);
        return deviceView(device, finish);
      }, signal),
    listDevices: (signIn: AppPwaWebSignIn, after?: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "list-devices",
        async (tx, authority) => {
          if (after) parse(AppPwaId, after);
          const rows = await tx<Device[]>`SELECT * FROM ${tables.devices} WHERE app_id = ${appId} AND owner_user_id = ${signIn.userId}::uuid
        ${after ? sql`AND id > ${after}::uuid` : sql``} ORDER BY id LIMIT ${options.budgets.listPageSize}`;
          return {
            items: await staffDeviceViews(tx, rows, authority.user.auth_epoch),
            next: rows.length === options.budgets.listPageSize ? (rows.at(-1)?.id ?? null) : null,
          };
        },
        signal,
      ),
    deviceStatus: (signIn: AppPwaWebSignIn, id: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "device-status",
        async (tx, authority) => {
          const views = await staffDeviceViews(tx, [await ownedDevice(tx, signIn, id)], authority.user.auth_epoch);
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
    issueVisit: (signIn: AppPwaWebSignIn, input: { requestId: string; deviceId: string; subject: unknown }, signal?: AbortSignal) =>
      staff(
        signIn,
        "issue-visit",
        async (tx, authority, beforeCommit) => {
          parse(AppPwaId, input.requestId);
          const subject = bounded(parse(options.subject, input.subject), options.budgets.requestBytes);
          const device = await ownedDevice(tx, signIn, input.deviceId);
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
          const digest = appPwaDigest({ deviceId: device.id, subject });
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
          const expires = existing?.qr_expires_at ?? earlier(plus(time, limits.qrSeconds), device.expires_at ?? time);
          if (existing)
            await tx`UPDATE ${tables.visits} SET secret_hash = ${pairingSecret.hash(secret)} WHERE app_id = ${appId} AND id = ${id}::uuid`;
          else {
            await tx`INSERT INTO ${tables.visits}(app_id,id,device_id,request_id,input_digest,secret_hash,subject,state,issued_at,qr_expires_at)
          VALUES (${appId},${id}::uuid,${device.id}::uuid,${input.requestId}::uuid,${digest},${pairingSecret.hash(secret)},${JSON.stringify(subject)}::jsonb,'pending',${time},${expires})`;
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
    status: (credential: string, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, _signal, beforeCommit) => {
          if (!device.active_visit_id) return { device: deviceView(device, await databaseClock(tx)), visit: null };
          const visit = await boundVisit(tx, device, device.active_visit_id);
          if (!liveVisit(visit, await databaseClock(tx))) return { device: deviceView(device, await databaseClock(tx)), visit: null };
          beforeCommit.deadline((time) => checkVisit(visit, time));
          return { device: deviceView(device, await databaseClock(tx)), visit: visitView(visit, await databaseClock(tx)) };
        },
        signal,
      ),
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
        VALUES (${appId},${visit.id}::uuid,${parse(AppPwaId, attemptId)}::uuid,${route},${digest},${JSON.stringify(result)}::jsonb)`;
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
    revokeVisit: (signIn: AppPwaWebSignIn, deviceId: string, visitId: string, signal?: AbortSignal) =>
      staff(
        signIn,
        "revoke-visit",
        async (tx) => {
          const device = await ownedDevice(tx, signIn, deviceId);
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
    deviceOperation: (credential: string, route: string, input: unknown, signal?: AbortSignal) =>
      guest(
        credential,
        async (tx, device, requestSignal, beforeCommit) => {
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
