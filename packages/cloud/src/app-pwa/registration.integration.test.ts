import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { sql } from "../runtime/clients";
import { createTestBrowserSignIn } from "../services/session/session.test-fixture";
import { APP_PWA_LIMITS, type AppPwaOptions, type AppPwaStaffTarget, type AppPwaWebSignIn, appPwaCommand } from "./contracts";
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
    await sql`INSERT INTO auth.users(id,uid,provider,profile,display_name) VALUES
      (${annaId}::uuid,'app-pwa-reg-anna','local','user','Anna Example'),
      (${benId}::uuid,'app-pwa-reg-ben','local','user','')`;
  });
  beforeEach(async () => {
    await sql`TRUNCATE app_pwa_registration_test._cloud_pwa_attempts, app_pwa_registration_test._cloud_pwa_visits,
      app_pwa_registration_test._cloud_pwa_devices, app_pwa_registration_test._cloud_pwa_browsers,
      app_pwa_registration_test._cloud_pwa_registrations`;
    await sql`DELETE FROM audit.events WHERE metadata->>'appId' = 'reception'`;
    anna = await createTestBrowserSignIn(annaId);
    ben = await createTestBrowserSignIn(benId);
    staffAllowed = () => true;
    staffTargets = [];
  });
  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS app_pwa_registration_test CASCADE`;
    await sql`DELETE FROM audit.events WHERE metadata->>'appId' = 'reception'`;
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
  });

  test("registration actions pass their registration to authorizeStaff", async () => {
    const { boot, registrationId } = await registered();
    const second = await registered();
    const target = { registrationId, name: "Reception iPad" };
    // The app can hide a registration from the list without stalling its paging.
    staffAllowed = (action, _signIn, current) => !(action === "list-registrations" && current?.registrationId === second.registrationId);
    expect((await service.listRegistrations(ben)).items.map((item) => item.id)).toEqual([registrationId]);
    expect(staffTargets).toContainEqual({ action: "list-registrations", target: undefined });
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
