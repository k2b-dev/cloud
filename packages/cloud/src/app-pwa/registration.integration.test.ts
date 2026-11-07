import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { createTestBrowserSignIn } from "../services/session/session.test-fixture";
import { encryptValue } from "../services/settings/crypto";
import {
  APP_PWA_LIMITS,
  type AppPwaOptions,
  type AppPwaStaffTarget,
  type AppPwaWebSignIn,
  appPwaCommand,
  appPwaDeviceOperation,
  appPwaQuery,
} from "./contracts";
import { appPwaPresenceCode, createAppPwaService } from "./service";

// Takeover attempts are rate limited per registration in Valkey.
const suite = suiteFor("database", "valkey");
const annaId = "bbab0000-0000-4000-8000-000000000001";
const benId = "bbab0000-0000-4000-8000-000000000002";
const documentId = "bbab0000-0000-4000-8000-000000000003";
const schema = "app_pwa_registration_test";
const subject = z.strictObject({ documentId: z.uuid() });
let anna: AppPwaWebSignIn;
let ben: AppPwaWebSignIn;
let staffAllowed: (action: string, signIn: AppPwaWebSignIn, target?: AppPwaStaffTarget) => boolean = () => true;
let staffTargets: { action: string; target?: AppPwaStaffTarget }[] = [];

const options: AppPwaOptions = {
  app: { id: "reception", installable: { path: "/app/reception/kiosk/" } },
  publicOrigin: "https://cloud.example.test",
  schema,
  subject,
  budgets: { requestBytes: 8192, responseBytes: 8192, listPageSize: 10, maxAccessIds: 10 },
  authorizeStaff: async (action, signIn, _tx, target) => {
    staffTargets.push({ action, target });
    return staffAllowed(action, signIn, target);
  },
  authorizeVisit: async (_signIn, value) => subject.parse(value).documentId === documentId,
  commands: {
    sign: appPwaCommand({
      input: z.strictObject({ finish: z.boolean() }),
      output: z.strictObject({ saved: z.boolean() }),
      handler: async (context, input) => {
        if (input.finish) context.endVisit();
        return { saved: true };
      },
    }),
  },
};
const service = createAppPwaService(options);
const shared = createAppPwaService({
  ...options,
  registeredDevices: { push: "staff" },
  coreQueries: ["address.autocomplete"],
  queries: {
    owner: appPwaQuery({ input: z.null(), output: z.string(), handler: async ({ actor }) => actor.ownerUserId }),
  },
  devicePermissions: { read: "read" },
  deviceOperations: {
    read: appPwaDeviceOperation({
      input: z.null(),
      output: z.string(),
      permission: "read",
      accessIds: async () => [documentId],
      handler: async ({ actor }) => actor.ownerUserId,
    }),
  },
});
const push = (registrationId: string, signIn = ben, requestId = id()) =>
  shared.issueVisit(signIn, { requestId, registrationId, subject: { documentId }, push: true });
let seq = 100;
const id = () => `bbab0000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;

/** Anna registers the reception iPad; she is its first user. */
const registered = async () => {
  const boot = await service.bootstrap();
  const issued = await service.issueDevice(anna, { requestId: id(), name: "Reception iPad", register: true });
  if (!issued.qr || !issued.registrationId) throw new Error("fixture has no registration QR");
  const claimed = await service.claimDevice(boot.credential, issued.qr);
  return { boot, claimed, registrationId: issued.registrationId };
};
/** The code the registered iPad shows on its waiting screen. */
const code = async (credential: string) => (await service.status(credential)).registration?.presence.code ?? "";
const auditEvents = (action: string) =>
  sql<{ actor_user_id: string | null; metadata: Record<string, unknown> }[]>`SELECT actor_user_id, metadata FROM audit.events
    WHERE action = ${action} AND metadata->>'appId' = 'reception' ORDER BY created_at`;

suite("App-PWA shared device registration", () => {
  beforeAll(async () => {
    await service.setup();
    await shared.setup();
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES
      (${annaId}::uuid,'app-pwa-reg-anna','local','user','Anna Example'),
      (${benId}::uuid,'app-pwa-reg-ben','local','user','')`;
  });
  beforeEach(async () => {
    await sql`TRUNCATE app_pwa_registration_test._cloud_pwa_attempts, app_pwa_registration_test._cloud_pwa_visits,
      app_pwa_registration_test._cloud_pwa_devices, app_pwa_registration_test._cloud_pwa_browsers,
      app_pwa_registration_test._cloud_pwa_registrations`;
    await sql`DELETE FROM audit.events WHERE metadata->>'appId' = 'reception'`;
    await sql`DELETE FROM settings.entries WHERE key='user.category.freeipa.enabled'`;
    await sql`UPDATE auth.users SET auth_epoch=0,account_expires=NULL,provider='local',profile='user' WHERE id IN (${annaId}::uuid,${benId}::uuid)`;
    await sql`DELETE FROM auth.access WHERE id=${documentId}::uuid`;
    anna = await createTestBrowserSignIn(annaId);
    ben = await createTestBrowserSignIn(benId);
    staffAllowed = () => true;
    staffTargets = [];
  });
  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS app_pwa_registration_test CASCADE`;
    await sql`DELETE FROM audit.events WHERE metadata->>'appId' = 'reception'`;
    await sql`DELETE FROM auth.access WHERE id=${documentId}::uuid`;
    await sql`DELETE FROM settings.entries WHERE key='user.category.freeipa.enabled'`;
    await sql`DELETE FROM auth.users WHERE id IN (${annaId}::uuid, ${benId}::uuid)`;
  });

  test("a registered browser outlives its user's session and then holds no authority", async () => {
    const { boot, claimed, registrationId } = await registered();
    expect(claimed.registrationId).toBe(registrationId);
    expect(claimed.registration).toMatchObject({ id: registrationId, name: "Reception iPad", holder: { displayName: "Anna Example" } });
    const status = await service.status(boot.credential);
    expect(status.registration?.holder).toEqual({ displayName: "Anna Example" });
    expect(status.device?.id).toBe(claimed.id);

    await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp(), revocation_reason='test' WHERE sid=${anna.sid}::uuid`;
    expect(await service.status(boot.credential)).toMatchObject({
      device: null,
      visit: null,
      registration: { id: registrationId, name: "Reception iPad", expiresAt: claimed.registration?.expiresAt ?? "", holder: null },
    });
    // Bootstrap keeps the registered credential and asks for a persistent cookie.
    const again = await service.bootstrap(boot.credential);
    expect(again.credential).toBe(boot.credential);
    expect(again.persistUntil).toBe(claimed.registration?.expiresAt ?? "");
    // Without a use, the device can neither claim visits nor run commands.
    await expect(service.command(boot.credential, id(), "sign", id(), { finish: false })).rejects.toMatchObject({
      code: "WEB_SESSION_REQUIRED",
    });
    // An ordinary paired browser keeps today's session cookie.
    expect((await service.bootstrap()).persistUntil).toBeNull();
  });

  test("taking over needs confirmation of the current use, ends it with its visit, and is audited", async () => {
    const { boot, claimed, registrationId } = await registered();
    const visit = await service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true });
    expect(visit.state).toBe("active");

    const listed = await service.listRegistrations(ben);
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.holder).toMatchObject({ userId: annaId, displayName: "Anna Example", deviceId: claimed.id, visitActive: true });

    await expect(
      service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: await code(boot.credential) }),
    ).rejects.toMatchObject({
      code: "IN_USE",
      status: 409,
    });
    await expect(
      service.takeOverDevice(ben, { registrationId, expectedDeviceId: id(), presenceCode: await code(boot.credential) }),
    ).rejects.toMatchObject({ code: "IN_USE" });
    const taken = await service.takeOverDevice(ben, {
      registrationId,
      expectedDeviceId: claimed.id,
      presenceCode: await code(boot.credential),
    });
    expect(taken.device.registrationId).toBe(registrationId);
    expect(taken.device.id).not.toBe(claimed.id);
    // Ben has no display name: the device sees no fallback login name.
    expect(taken.registration.holder).toEqual({ displayName: null });

    const status = await service.status(boot.credential);
    expect(status.device?.id).toBe(taken.device.id);
    expect(status.visit).toBeNull();
    expect(status.registration?.holder).toEqual({ displayName: null });
    await expect(service.command(boot.credential, visit.id, "sign", id(), { finish: false })).rejects.toMatchObject({ status: 404 });
    expect((await service.deviceStatus(anna, claimed.id)).state).toBe("revoked");
    // Anna can no longer push to her ended use.
    await expect(
      service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true }),
    ).rejects.toMatchObject({ code: "REVOKED" });

    const [event] = await auditEvents("app_pwa.registration.taken_over");
    expect(event?.actor_user_id).toBe(benId);
    expect(event?.metadata).toMatchObject({
      registrationId,
      deviceId: taken.device.id,
      visitId: visit.id,
      previousDeviceId: claimed.id,
      previousOwnerUserId: annaId,
      issuedByUserId: annaId,
    });
    expect((await auditEvents("app_pwa.visit.revoked"))[0]?.metadata).toMatchObject({ visitId: visit.id });
    // Staff lists fall back to the login name; the device never does.
    expect((await service.listRegistrations(anna)).items[0]?.holder).toMatchObject({ userId: benId, displayName: "app-pwa-reg-ben" });
  });

  test("a free device is taken without confirmation and a retry from the same session changes nothing", async () => {
    const { boot, registrationId } = await registered();
    await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp(), revocation_reason='test' WHERE sid=${anna.sid}::uuid`;
    expect((await service.listRegistrations(ben)).items[0]?.holder).toBeNull();
    const first = await service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: await code(boot.credential) });
    const retry = await service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: await code(boot.credential) });
    expect(retry.device.id).toBe(first.device.id);
    expect((await auditEvents("app_pwa.registration.taken_over")).map((event) => event.metadata.previousOwnerUserId)).toEqual([null]);
    expect((await service.status(boot.credential)).device?.id).toBe(first.device.id);
    // Ben's own session ending frees the device again.
    await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp(), revocation_reason='test' WHERE sid=${ben.sid}::uuid`;
    expect((await service.status(boot.credential)).registration?.holder).toBeNull();
  });

  test("concurrent takeovers of a free device have one winner", async () => {
    const { boot, registrationId } = await registered();
    await service.revokeDevice(anna, (await service.listRegistrations(anna)).items[0]?.holder?.deviceId ?? "");
    const presenceCode = await code(boot.credential);
    const results = await Promise.allSettled([
      service.takeOverDevice(anna, { registrationId, expectedDeviceId: null, presenceCode }),
      service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "IN_USE" } });
  });

  test("a pushed visit opens on the device without a QR and keeps one visit per device", async () => {
    const { boot, claimed } = await registered();
    const requestId = id();
    const pushed = await service.issueVisit(anna, { requestId, deviceId: claimed.id, subject: { documentId }, push: true });
    expect(pushed.qr).toBeNull();
    expect(await service.issueVisit(anna, { requestId, deviceId: claimed.id, subject: { documentId }, push: true })).toMatchObject({
      id: pushed.id,
      state: "active",
    });
    await expect(service.issueVisit(anna, { requestId, deviceId: claimed.id, subject: { documentId } })).rejects.toMatchObject({
      code: "ATTEMPT_CONFLICT",
    });
    await expect(
      service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true }),
    ).rejects.toMatchObject({ code: "ACTIVE_VISIT" });
    await expect(
      service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId: id() }, push: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const status = await service.status(boot.credential);
    expect(status.visit).toMatchObject({ id: pushed.id, state: "active" });
    expect(await service.command(boot.credential, pushed.id, "sign", id(), { finish: true })).toMatchObject({ completed: true });
    // Ben cannot push to Anna's use.
    await expect(
      service.issueVisit(ben, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const next = await service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true });
    expect((await service.status(boot.credential)).visit?.id).toBe(next.id);
  });

  test("revoking a registration ends its use and its browser binding", async () => {
    const { boot, claimed, registrationId } = await registered();
    await service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true });
    expect(await service.revokeRegistration(ben, registrationId)).toEqual({ state: "revoked" });
    await expect(service.status(boot.credential)).rejects.toMatchObject({ code: "BROWSER_REQUIRED" });
    expect((await service.bootstrap(boot.credential)).credential).not.toBe(boot.credential);
    expect((await service.listRegistrations(anna)).items).toEqual([]);
    await expect(service.takeOverDevice(anna, { registrationId, expectedDeviceId: null, presenceCode: "000000" })).rejects.toMatchObject({
      code: "REVOKED",
    });
    expect((await auditEvents("app_pwa.registration.revoked"))[0]?.metadata).toMatchObject({ registrationId, previousOwnerUserId: annaId });
  });

  test("each registration action has its own staff authorization", async () => {
    const { registrationId } = await registered();
    staffAllowed = (action) => action !== "register-device";
    await expect(service.issueDevice(anna, { requestId: id(), name: "Second iPad", register: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await service.issueDevice(anna, { requestId: id(), name: "Own iPad" })).registrationId).toBeNull();
    for (const action of ["list-registrations", "take-over-device", "revoke-registration"]) {
      staffAllowed = (current) => current !== action;
      const call =
        action === "list-registrations"
          ? service.listRegistrations(ben)
          : action === "take-over-device"
            ? service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: "000000" })
            : service.revokeRegistration(ben, registrationId);
      await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  test("a registration from another app is not visible", async () => {
    const { registrationId } = await registered();
    const other = createAppPwaService({ ...options, app: { id: "other", installable: { path: "/app/other/kiosk/" } } });
    await other.setup();
    expect((await other.listRegistrations(ben)).items).toEqual([]);
    await expect(other.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: "000000" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(other.revokeRegistration(ben, registrationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("takeover needs the presence code the registered device shows", async () => {
    const { boot, claimed, registrationId } = await registered();
    const status = await service.status(boot.credential);
    expect(status.registration?.presence.code).toMatch(/^\d{6}$/);
    expect(Date.parse(status.registration?.presence.expiresAt ?? "")).toBeGreaterThan(Date.now() - 1000);
    // Staff never learn the code from the list.
    expect(JSON.stringify(await service.listRegistrations(ben))).not.toContain(status.registration?.presence.code ?? "-");
    const take = (presenceCode: string) => service.takeOverDevice(ben, { registrationId, expectedDeviceId: claimed.id, presenceCode });
    await expect(take("")).rejects.toMatchObject({ code: "PRESENCE_REQUIRED", status: 403 });
    const current = await code(boot.credential);
    await expect(take(String((Number(current) + 1) % 1_000_000).padStart(6, "0"))).rejects.toMatchObject({ code: "PRESENCE_REQUIRED" });

    // A code shown by another registered device does not unlock this one.
    const other = await registered();
    await expect(take(await code(other.boot.credential))).rejects.toMatchObject({ code: "PRESENCE_REQUIRED" });

    // The previous window is still accepted; older windows are not.
    const [row] = await sql<{ browser_hash: string; time: Date }[]>`SELECT browser_hash, clock_timestamp() AS time
      FROM app_pwa_registration_test._cloud_pwa_registrations WHERE id = ${registrationId}::uuid`;
    const window = Math.floor((row?.time.getTime() ?? 0) / (APP_PWA_LIMITS.presenceSeconds * 1000));
    const at = (offset: number) => appPwaPresenceCode("reception", registrationId, row?.browser_hash ?? "", window + offset);
    if (at(-2) !== at(-1) && at(-2) !== at(0)) await expect(take(at(-2))).rejects.toMatchObject({ code: "PRESENCE_REQUIRED" });
    expect((await take(at(-1))).device.registrationId).toBe(registrationId);
    expect((await service.status(boot.credential)).registration?.holder).toEqual({ displayName: null });
  });

  test("takeover attempts per registration are bounded", async () => {
    const { registrationId } = await registered();
    const attempts = [];
    for (let index = 0; index <= APP_PWA_LIMITS.presenceAttempts; index++)
      attempts.push(
        await service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: "000000" }).catch((error) => error),
      );
    expect(attempts.at(-1)).toMatchObject({ code: "RATE_LIMITED", status: 429 });
    // Another UUID casing names the same registration and shares its counter.
    await expect(
      service.takeOverDevice(ben, { registrationId: registrationId.toUpperCase(), expectedDeviceId: null, presenceCode: "000000" }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("a correct code is refused too once the attempts are used up", async () => {
    const { boot, registrationId } = await registered();
    for (let index = 0; index < APP_PWA_LIMITS.presenceAttempts; index++)
      await service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: "" }).catch(() => undefined);
    await expect(
      service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: await code(boot.credential) }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("opted-in registration starts neutral and grants no device access before a visit", async () => {
    const boot = await shared.bootstrap();
    const issued = await shared.issueDevice(anna, { requestId: id(), name: "Shared iPad", register: true });
    if (!issued.qr || !issued.registrationId) throw new Error("registration fixture missing");
    expect((await shared.claimDevice(boot.credential, issued.qr)).registration?.holder).toBeNull();
    expect(await shared.status(boot.credential)).toMatchObject({ device: null, visit: null, registration: { holder: null } });
    await expect(shared.deviceOperation(boot.credential, "read", null)).rejects.toMatchObject({ code: "REVOKED" });
    await expect(
      shared.coreQuery(boot.credential, undefined, "address.autocomplete", { text: "Example Str", countryCode: "de" }),
    ).rejects.toMatchObject({ code: "REVOKED" });
    const visit = await push(issued.registrationId);
    expect((await shared.status(boot.credential)).visit?.id).toBe(visit.id);
    await expect(
      shared.takeOverDevice(ben, {
        registrationId: issued.registrationId,
        expectedDeviceId: null,
        presenceCode: await code(boot.credential),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
    await shared.revokeVisit(anna, { registrationId: issued.registrationId }, visit.id);
    await expect(
      shared.takeOverDevice(ben, {
        registrationId: issued.registrationId,
        expectedDeviceId: null,
        presenceCode: await code(boot.credential),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  });

  test("registered staff push is opt-in and replaces an idle use without a holder or code", async () => {
    const { boot, claimed, registrationId } = await registered();
    await expect(service.issueVisit(ben, { requestId: id(), registrationId, subject: { documentId }, push: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
      status: 403,
    });
    const requestId = id();
    const visit = await push(registrationId, ben, requestId);
    expect(visit).toMatchObject({ state: "active", qr: null });
    expect((await service.deviceStatus(anna, claimed.id)).state).toBe("revoked");
    expect(await push(registrationId, ben, requestId)).toMatchObject({ id: visit.id, state: "active" });
    await expect(shared.issueVisit(ben, { requestId, registrationId, subject: { documentId: id() }, push: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const permissive = createAppPwaService({ ...options, registeredDevices: { push: "staff" }, authorizeVisit: async () => true });
    await permissive.setup();
    await expect(
      permissive.issueVisit(ben, { requestId, registrationId, subject: { documentId: id() }, push: true }),
    ).rejects.toMatchObject({ code: "ATTEMPT_CONFLICT", status: 409 });
    const status = await shared.status(boot.credential);
    await expect(
      shared.issueVisit(ben, { requestId: id(), deviceId: status.device?.id ?? "", subject: { documentId }, push: true }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(status.registration?.holder).toBeNull();
    expect(status.visit?.id).toBe(visit.id);
    expect(await shared.query(boot.credential, visit.id, "owner", null)).toBe(benId);
    expect((await shared.listRegistrations(anna)).items[0]).toMatchObject({
      holder: null,
      activeVisit: { issuedBy: { displayName: null }, issuedAt: expect.any(String) },
    });
    const serialized = JSON.stringify(status);
    for (const secret of [annaId, benId, "app-pwa-reg-ben", "app-pwa-reg-anna", "@"]) expect(serialized).not.toContain(secret);
    const [event] = await auditEvents("app_pwa.visit.pushed");
    expect(event?.metadata).toMatchObject({ previousDeviceId: claimed.id, previousOwnerUserId: annaId });
    expect(event).toMatchObject({
      actor_user_id: benId,
      metadata: { registrationId, issuedByUserId: benId, visitId: visit.id, previousDeviceId: claimed.id, previousOwnerUserId: annaId },
    });
  });

  test("a live old-style visit blocks a registered push; idle uses are replaced", async () => {
    const { boot, claimed, registrationId } = await registered();
    const old = await service.issueVisit(anna, { requestId: id(), deviceId: claimed.id, subject: { documentId }, push: true });
    await expect(push(registrationId)).rejects.toMatchObject({ code: "ACTIVE_VISIT", status: 409 });
    expect((await shared.status(boot.credential)).visit?.id).toBe(old.id);
    await shared.revokeVisit(ben, { registrationId }, old.id);
    const visit = await push(registrationId);
    expect((await shared.status(boot.credential)).visit?.id).toBe(visit.id);
  });

  test("registered pushes serialize across employees with one winner and one ACTIVE_VISIT", async () => {
    const { boot, registrationId } = await registered();
    const results = await Promise.allSettled([push(registrationId, anna), push(registrationId, ben)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ACTIVE_VISIT", status: 409 } });
    const visits = await sql`SELECT id FROM app_pwa_registration_test._cloud_pwa_visits WHERE state='active'`;
    expect(visits).toHaveLength(1);
    expect((await shared.status(boot.credential)).visit?.id).toBe(visits[0]?.id);
  });

  test("concurrent issuance retries recover one visit and never reactivate a replaced request", async () => {
    const { boot, registrationId } = await registered();
    const requestId = id();
    const [first, retry] = await Promise.all([push(registrationId, ben, requestId), push(registrationId, ben, requestId)]);
    expect(retry.id).toBe(first.id);
    expect(await auditEvents("app_pwa.visit.pushed")).toHaveLength(1);
    await shared.revokeVisit(anna, { registrationId }, first.id);
    await push(registrationId, anna);
    await expect(push(registrationId, ben, requestId)).rejects.toMatchObject({ code: "REVOKED", status: 410 });
    expect((await shared.status(boot.credential)).visit?.id).not.toBe(first.id);
  });

  test("issue, revoke, and rename authorization narrows by registration and repeats before commit", async () => {
    const { boot, registrationId } = await registered();
    const target = { registrationId, name: "Reception iPad" };
    staffAllowed = (action, _signIn, current) => !(action === "issue-visit" && current?.registrationId === registrationId);
    await expect(push(registrationId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(staffTargets).toContainEqual({ action: "issue-visit", target });
    staffAllowed = () => true;
    staffTargets = [];
    const visit = await push(registrationId);
    expect(staffTargets.filter((entry) => entry.action === "issue-visit" && entry.target)).toEqual([
      { action: "issue-visit", target },
      { action: "issue-visit", target },
    ]);
    staffAllowed = (action, _signIn, current) => !(action === "revoke-visit" && current?.registrationId === registrationId);
    await expect(shared.revokeVisit(anna, { registrationId }, visit.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const status = await shared.status(boot.credential);
    expect(status.visit?.id).toBe(visit.id);
    await expect(shared.revokeVisit(ben, status.device?.id ?? "", visit.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    staffAllowed = (action, _signIn, current) => !(action === "rename-registration" && current?.registrationId === registrationId);
    await expect(shared.renameRegistration(anna, { registrationId, name: "Other" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    staffAllowed = () => true;
    expect(await shared.renameRegistration(anna, { registrationId, name: "  Front desk  " })).toEqual({
      id: registrationId,
      name: "Front desk",
    });
    expect((await shared.status(boot.credential)).registration?.name).toBe("Front desk");
    expect((await shared.listRegistrations(anna)).items[0]?.name).toBe("Front desk");
    await expect(shared.renameRegistration(anna, { registrationId, name: " " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect((await auditEvents("app_pwa.registration.renamed"))[0]).toMatchObject({
      actor_user_id: annaId,
      metadata: { registrationId, previousName: "Reception iPad", name: "Front desk" },
    });
  });

  test("target authorization and visit authorization can refuse a registered issuance retry", async () => {
    const { registrationId } = await registered();
    const requestId = id();
    const visit = await push(registrationId, ben, requestId);
    let checks = 0;
    staffAllowed = (action, _signIn, target) => action !== "issue-visit" || !target || ++checks === 1;
    await expect(push(registrationId, ben, requestId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    staffAllowed = () => true;
    const denied = createAppPwaService({ ...options, registeredDevices: { push: "staff" }, authorizeVisit: async () => false });
    await denied.setup();
    await expect(denied.issueVisit(ben, { requestId, registrationId, subject: { documentId }, push: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await push(registrationId, ben, requestId)).id).toBe(visit.id);
  });

  test.each(["logout", "epoch", "account-expiry", "family-expiry", "signing-key", "legal", "category"])(
    "registered visit ends with the issuer's %s, not the registering employee's",
    async (kind) => {
      const { boot, registrationId } = await registered();
      const visit = await push(registrationId);
      await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp() WHERE sid=${anna.sid}::uuid`;
      expect(await shared.query(boot.credential, visit.id, "owner", null)).toBe(benId);
      if (kind === "logout") await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp() WHERE sid=${ben.sid}::uuid`;
      if (kind === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${benId}::uuid`;
      if (kind === "account-expiry")
        await sql`UPDATE auth.users SET account_expires=clock_timestamp()-interval '1 second' WHERE id=${benId}::uuid`;
      if (kind === "family-expiry")
        await sql`UPDATE auth.session_families SET issued_at=clock_timestamp()-interval '1 hour',expires_at=clock_timestamp()-interval '1 second' WHERE sid=${ben.sid}::uuid`;
      if (kind === "signing-key")
        await sql`UPDATE auth.signing_keys SET state='revoked',revoked_at=clock_timestamp(),revoke_reason='test' WHERE kid=${ben.sid}`;
      if (kind === "legal") await sql`UPDATE auth.session_families SET legal_pending=true WHERE sid=${ben.sid}::uuid`;
      if (kind === "category") {
        // IPA takes precedence over the guest presentation profile, as in lockWebAuthority.
        await sql`UPDATE auth.users SET provider='ipa',profile='guest' WHERE id=${benId}::uuid`;
        await sql`INSERT INTO settings.entries(key,value) VALUES ('user.category.freeipa.enabled',${await encryptValue(false)})`;
      }
      expect(await shared.status(boot.credential)).toMatchObject({
        device: null,
        visit: null,
        registration: { id: registrationId, holder: null },
      });
      await expect(shared.query(boot.credential, visit.id, "owner", null)).rejects.toMatchObject({ code: "WEB_SESSION_REQUIRED" });
      expect((await shared.bootstrap(boot.credential)).credential).toBe(boot.credential);
      anna = await createTestBrowserSignIn(annaId);
      expect((await shared.listRegistrations(anna)).items[0]?.activeVisit).toBeNull();
      expect((await push(registrationId, anna)).state).toBe("active");
    },
  );

  test("another admitted employee revokes a visit; guest end and completion preserve issuer audit and reveal no content", async () => {
    const { boot, registrationId } = await registered();
    const visit = await push(registrationId);
    const listed = (await shared.listRegistrations(anna)).items.find((item) => item.id === registrationId);
    expect(listed?.activeVisit?.id).toBe(visit.id);
    await shared.revokeVisit(anna, { registrationId }, listed?.activeVisit?.id ?? "");
    expect((await auditEvents("app_pwa.visit.revoked"))[0]).toMatchObject({
      actor_user_id: annaId,
      metadata: { registrationId, issuedByUserId: benId, visitId: visit.id },
    });
    expect((await shared.status(boot.credential)).device).toBeNull();
    const next = await push(registrationId);
    await shared.endVisit(boot.credential, next.id);
    expect((await auditEvents("app_pwa.visit.revoked"))[1]?.metadata).toMatchObject({
      registrationId,
      issuedByUserId: benId,
      visitId: next.id,
    });
    const final = await push(registrationId);
    const attemptId = id();
    expect(await shared.command(boot.credential, final.id, "sign", attemptId, { finish: true })).toMatchObject({
      completed: true,
      result: null,
    });
    expect(await shared.command(boot.credential, final.id, "sign", attemptId, { finish: true })).toMatchObject({
      replayed: true,
      result: null,
    });
    expect(await shared.attempt(boot.credential, final.id, attemptId)).toEqual({ state: "committed", completed: true });
    expect((await auditEvents("app_pwa.visit.completed"))[0]?.metadata).toMatchObject({
      registrationId,
      issuedByUserId: benId,
      visitId: final.id,
    });
    expect((await shared.listRegistrations(anna)).items[0]).toMatchObject({ holder: null, activeVisit: null });
    await expect(shared.deviceOperation(boot.credential, "read", null)).rejects.toMatchObject({ code: "REVOKED" });
    await expect(
      shared.coreQuery(boot.credential, undefined, "address.autocomplete", { text: "Example Str", countryCode: "de" }),
    ).rejects.toMatchObject({ code: "REVOKED" });
    await push(registrationId, anna);
    expect(await shared.attempt(boot.credential, final.id, attemptId)).toEqual({ state: "committed", completed: true });
    expect(await shared.command(boot.credential, final.id, "sign", attemptId, { finish: true })).toMatchObject({
      state: "committed",
      completed: true,
      replayed: true,
      result: null,
    });
    await expect(shared.query(boot.credential, final.id, "owner", null)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(shared.command(boot.credential, final.id, "sign", id(), { finish: false })).rejects.toMatchObject({ code: "REVOKED" });
    const other = await registered();
    await push(other.registrationId);
    await expect(shared.attempt(other.boot.credential, final.id, attemptId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  test("resource operations intersect the issuer's grants and close at visit end and deadlines", async () => {
    const { boot, registrationId } = await registered();
    const visit = await push(registrationId);
    await sql`INSERT INTO auth.access(id,user_id,permission) VALUES (${documentId}::uuid,${annaId}::uuid,'read')`;
    await expect(shared.deviceOperation(boot.credential, "read", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await sql`UPDATE auth.access SET user_id=${benId}::uuid WHERE id=${documentId}::uuid`;
    expect(await shared.deviceOperation(boot.credential, "read", null)).toBe(benId);
    await sql`UPDATE auth.access SET permission='none' WHERE id=${documentId}::uuid`;
    await expect(shared.deviceOperation(boot.credential, "read", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await sql`UPDATE app_pwa_registration_test._cloud_pwa_visits SET last_used_at=clock_timestamp()-interval '16 minutes' WHERE id=${visit.id}::uuid`;
    expect((await shared.status(boot.credential)).visit).toBeNull();
    await expect(shared.deviceOperation(boot.credential, "read", null)).rejects.toMatchObject({ code: "EXPIRED" });
    const next = await push(registrationId);
    await sql`UPDATE app_pwa_registration_test._cloud_pwa_visits SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${next.id}::uuid`;
    await expect(shared.query(boot.credential, next.id, "owner", null)).rejects.toMatchObject({ code: "EXPIRED" });
  });

  test("registration actions pass their registration to authorizeStaff", async () => {
    const { boot, registrationId } = await registered();
    const second = await registered();
    const target = { registrationId, name: "Reception iPad" };
    // The app can hide a registration from the list without stalling its paging.
    staffAllowed = (action, _signIn, current) => !(action === "list-registrations" && current?.registrationId === second.registrationId);
    expect((await service.listRegistrations(ben)).items.map((item) => item.id)).toEqual([registrationId]);
    expect(staffTargets).toContainEqual({ action: "list-registrations", target: undefined });
    // The included registration is checked again before commit.
    expect(staffTargets.filter((entry) => entry.target?.registrationId === registrationId)).toHaveLength(2);
    expect(staffTargets).toContainEqual({
      action: "list-registrations",
      target: { registrationId: second.registrationId, name: "Reception iPad" },
    });

    staffAllowed = (action, _signIn, current) => !(action === "take-over-device" && current?.registrationId === registrationId);
    await expect(
      service.takeOverDevice(ben, { registrationId, expectedDeviceId: null, presenceCode: await code(boot.credential) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(staffTargets).toContainEqual({ action: "take-over-device", target });

    staffAllowed = (action, _signIn, current) => !(action === "revoke-registration" && current?.registrationId === registrationId);
    await expect(service.revokeRegistration(ben, registrationId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(staffTargets).toContainEqual({ action: "revoke-registration", target });
    expect(await service.revokeRegistration(ben, second.registrationId)).toEqual({ state: "revoked" });
  });
});
