import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import * as bun from "bun";
import { SQL, sql } from "bun";
import { z } from "zod";
import { databaseSuite, requireDatabaseUrl } from "../../../../scripts/fixtures/test-infra";
import { createTestBrowserSignIn } from "../services/session/session.test-fixture";
import { encryptValue } from "../services/settings/crypto";
import { type AppPwaOptions, type AppPwaWebSignIn, appPwaCommand, appPwaDeviceOperation, appPwaQuery } from "./contracts";
import { createAppPwaService } from "./service";

const suite = databaseSuite();
const ownerId = "bbaa0000-0000-4000-8000-000000000001";
const grantId = "bbaa0000-0000-4000-8000-000000000002";
const documentId = "bbaa0000-0000-4000-8000-000000000003";
const schema = "app_pwa_b_service_test";
const origin = "https://cloud.example.test";
const path = "/app/signing/customer/";
let signIn: AppPwaWebSignIn;
let authorAllowed = true;
let commandCalls = 0;
let operationCalls = 0;
let hold: { entered: () => void; release: Promise<void> } | undefined;
const subject = z.strictObject({ documentId: z.uuid(), revision: z.number().int() });
const signature = z.strictObject({ revision: z.number().int(), signature: z.string().min(1), finish: z.boolean().default(false) });
const output = z.strictObject({ saved: z.boolean() });

const base: AppPwaOptions = {
  app: { id: "signing", installable: { path } },
  publicOrigin: origin,
  schema,
  subject,
  budgets: { requestBytes: 8192, responseBytes: 8192, listPageSize: 2, maxAccessIds: 10 },
  authorizeStaff: async () => authorAllowed,
  authorizeVisit: async (_signIn, value) => subject.parse(value).documentId === documentId,
  queries: {
    document: appPwaQuery({
      input: z.null(),
      output: z.strictObject({ revision: z.number() }),
      handler: async ({ actor, tx }) => {
        const resource = subject.parse(actor.subject);
        const [row] = await tx<
          { revision: number }[]
        >`SELECT revision FROM app_pwa_b_service_test.documents WHERE id=${resource.documentId}::uuid`;
        return { revision: row?.revision ?? 0 };
      },
    }),
  },
  commands: {
    sign: appPwaCommand({
      input: signature,
      output,
      handler: async (context, input) => {
        commandCalls++;
        expect(context.actor.kind).toBe("visit");
        expect("accessSubject" in context).toBe(false);
        expect("sessionToken" in context).toBe(false);
        const resource = subject.parse(context.actor.subject);
        if (hold) {
          hold.entered();
          await hold.release;
        }
        const updated = await context.tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1
      WHERE id=${resource.documentId}::uuid AND revision=${input.revision} RETURNING id`;
        if (!updated.length) throw new Error("fixture revision mismatch");
        if (input.finish) context.endVisit();
        return { saved: true };
      },
    }),
  },
  deviceOperations: {
    read: appPwaDeviceOperation({
      input: z.null(),
      output: z.strictObject({ deviceId: z.uuid() }),
      permission: "read",
      accessIds: async () => [grantId],
      handler: async ({ actor }) => {
        operationCalls++;
        expect(actor.kind).toBe("device");
        return { deviceId: actor.deviceId };
      },
    }),
  },
  devicePermissions: { read: "read" },
};
const service = createAppPwaService(base);
let seq = 100;
const id = () => `bbaa0000-0000-4000-8000-${String(seq++).padStart(12, "0")}`;
const issuedDevice = () => service.issueDevice(signIn, { requestId: id(), name: "Shop iPad" });
const paired = async () => {
  const boot = await service.bootstrap();
  const issued = await issuedDevice();
  if (!issued.qr) throw new Error("fixture has no device QR");
  const device = await service.claimDevice(boot.credential, issued.qr);
  return { boot, device, qr: issued.qr };
};
const visiting = async () => {
  const device = await paired();
  const issued = await service.issueVisit(signIn, { requestId: id(), deviceId: device.device.id, subject: { documentId, revision: 1 } });
  if (!issued.qr) throw new Error("fixture has no visit QR");
  const visit = await service.claimVisit(device.boot.credential, issued.qr);
  return { ...device, visit, visitQr: issued.qr };
};
const saved = async () =>
  Number((await sql<{ saved: number }[]>`SELECT saved FROM app_pwa_b_service_test.documents WHERE id=${documentId}::uuid`)[0]?.saved);
const idle = async (visitId: string) =>
  (
    await sql<{ last_used_at: Date }[]>`SELECT last_used_at FROM app_pwa_b_service_test._cloud_pwa_visits WHERE id=${visitId}::uuid`
  )[0]!.last_used_at.toISOString();

suite("App-PWA durable service", () => {
  beforeAll(async () => {
    await service.setup();
    await service.setup();
    await sql`CREATE TABLE IF NOT EXISTS app_pwa_b_service_test.documents(id uuid PRIMARY KEY,revision int NOT NULL,saved int NOT NULL)`;
    await sql`CREATE TABLE IF NOT EXISTS app_pwa_b_service_test.deferred_signatures(
      attempt_id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES app_pwa_b_service_test.documents(id)
      DEFERRABLE INITIALLY DEFERRED)`;
    await sql`INSERT INTO auth.users(id,uid,provider,profile) VALUES (${ownerId}::uuid,'app-pwa-b-owner','local','user')`;
  });
  beforeEach(async () => {
    await sql`TRUNCATE app_pwa_b_service_test.deferred_signatures,app_pwa_b_service_test._cloud_pwa_attempts,app_pwa_b_service_test._cloud_pwa_visits,
      app_pwa_b_service_test._cloud_pwa_devices,app_pwa_b_service_test._cloud_pwa_browsers,app_pwa_b_service_test.documents`;
    await sql`UPDATE auth.users SET auth_epoch=0,account_expires=NULL WHERE id=${ownerId}::uuid`;
    await sql`DELETE FROM settings.entries WHERE key='user.category.login.enabled'`;
    await sql`INSERT INTO auth.access(id,user_id,permission) VALUES (${grantId}::uuid,${ownerId}::uuid,'read')
      ON CONFLICT(id) DO UPDATE SET permission='read'`;
    await sql`INSERT INTO app_pwa_b_service_test.documents VALUES (${documentId}::uuid,1,0)`;
    signIn = await createTestBrowserSignIn(ownerId);
    authorAllowed = true;
    commandCalls = 0;
    operationCalls = 0;
    hold = undefined;
  });
  afterAll(async () => {
    await sql`DROP SCHEMA IF EXISTS app_pwa_b_service_test CASCADE`;
    await sql`DELETE FROM auth.access WHERE id=${grantId}::uuid`;
    await sql`DELETE FROM auth.users WHERE id=${ownerId}::uuid`;
    await sql`DELETE FROM settings.entries WHERE key='user.category.login.enabled'`;
  });

  test("bootstrap cannot select an identity, and a recreated service uses the same database authority", async () => {
    const generated = await service.bootstrap("a".repeat(43));
    expect(generated.credential).not.toBe("a".repeat(43));
    expect((await service.bootstrap(generated.credential)).credential).toBe(generated.credential);
    const f = await paired();
    const second = createAppPwaService(base);
    await second.setup();
    expect((await second.status(f.boot.credential)).device.id).toBe(f.device.id);
    expect(await second.bootstrap(f.boot.credential)).toEqual(f.boot);
  });
  test("concurrent device claims have one winner and same-browser lost-response recovery", async () => {
    const [one, two] = await Promise.all([service.bootstrap(), service.bootstrap()]);
    const issued = await issuedDevice();
    if (!issued.qr) throw new Error("missing QR");
    const results = await Promise.allSettled([
      service.claimDevice(one.credential, issued.qr),
      service.claimDevice(two.credential, issued.qr),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? one : two;
    expect((await service.claimDevice(winner.credential, issued.qr)).id).toBe(issued.id);
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET qr_expires_at=clock_timestamp()-interval '1 second' WHERE id=${issued.id}::uuid`;
    expect((await service.claimDevice(winner.credential, issued.qr)).id).toBe(issued.id);
  });
  test("lost staff issue responses rotate one pending QR without extending its deadline", async () => {
    const input = { requestId: id(), name: "iPad" };
    const one = await service.issueDevice(signIn, input);
    const two = await service.issueDevice(signIn, input);
    expect(two.id).toBe(one.id);
    expect(two.qrExpiresAt).toBe(one.qrExpiresAt);
    expect(two.qr).not.toBe(one.qr);
    const boot = await service.bootstrap();
    await expect(service.claimDevice(boot.credential, one.qr!)).rejects.toMatchObject({ code: "INVALID_QR" });
    await service.claimDevice(boot.credential, two.qr!);
    expect((await service.issueDevice(signIn, input)).qr).toBeNull();
    await expect(service.issueDevice(signIn, { ...input, name: "other" })).rejects.toMatchObject({ code: "ATTEMPT_CONFLICT" });
  });
  test("visit QR issue retry rotates only pending secrets and returns a nullable QR after claim", async () => {
    const f = await paired();
    const input = { deviceId: f.device.id, requestId: id(), subject: { documentId, revision: 1 } };
    const first = await service.issueVisit(signIn, input);
    const retry = await service.issueVisit(signIn, input);
    expect(retry.id).toBe(first.id);
    expect(retry.qrExpiresAt).toBe(first.qrExpiresAt);
    expect(retry.qr).not.toBe(first.qr);
    await expect(service.claimVisit(f.boot.credential, first.qr!)).rejects.toMatchObject({ code: "INVALID_QR" });
    await service.claimVisit(f.boot.credential, retry.qr!);
    const claimed = await service.issueVisit(signIn, input);
    expect(claimed.id).toBe(first.id);
    expect(claimed.qr).toBeNull();
    expect(claimed.state).toBe("active");
  });
  test("visit first claim binds device/browser, rejects replacement, and terminal state never resumes", async () => {
    const f = await visiting();
    const other = await paired();
    await expect(service.claimVisit(other.boot.credential, f.visitQr)).rejects.toMatchObject({ code: "INVALID_QR" });
    expect((await service.claimVisit(f.boot.credential, f.visitQr)).id).toBe(f.visit.id);
    const next = await service.issueVisit(signIn, { requestId: id(), deviceId: f.device.id, subject: { documentId, revision: 1 } });
    await expect(service.claimVisit(f.boot.credential, next.qr!)).rejects.toMatchObject({ code: "ACTIVE_VISIT" });
    await service.endVisit(f.boot.credential, f.visit.id);
    await expect(service.claimVisit(f.boot.credential, f.visitQr)).rejects.toMatchObject({ code: "REVOKED" });
    await expect(service.query(f.boot.credential, f.visit.id, "document", null)).rejects.toMatchObject({ code: "REVOKED" });
    await service.claimVisit(f.boot.credential, next.qr!);
  });
  test("polling, queries, recovery and duplicate commands do not touch idle time", async () => {
    const f = await visiting();
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET last_used_at=clock_timestamp()-interval '1 minute' WHERE id=${f.visit.id}::uuid`;
    const before = await idle(f.visit.id);
    await service.status(f.boot.credential);
    await service.query(f.boot.credential, f.visit.id, "document", null);
    await service.attempt(f.boot.credential, f.visit.id, id());
    expect(await idle(f.visit.id)).toBe(before);
    const attemptId = id();
    const input = { revision: 1, signature: "Customer", finish: false };
    const result = await service.command(f.boot.credential, f.visit.id, "sign", attemptId, input);
    expect(result).toEqual({ result: { saved: true }, replayed: false });
    const touched = await idle(f.visit.id);
    expect(touched).not.toBe(before);
    expect(await service.command(f.boot.credential, f.visit.id, "sign", attemptId, input)).toEqual({
      result: { saved: true },
      replayed: true,
    });
    expect(await service.attempt(f.boot.credential, f.visit.id, attemptId)).toEqual({
      state: "committed",
      completed: false,
    });
    expect(await idle(f.visit.id)).toBe(touched);
    expect(commandCalls).toBe(1);
    expect(await saved()).toBe(1);
    await expect(
      service.command(f.boot.credential, f.visit.id, "sign", attemptId, { ...input, signature: "Changed" }),
    ).rejects.toMatchObject({ code: "ATTEMPT_CONFLICT" });
  });
  test("concurrent attempts commit domain and stored result once; completion can only reconcile", async () => {
    const f = await visiting();
    const attemptId = id();
    const input = { revision: 1, signature: "Customer", finish: true };
    const results = await Promise.all([
      service.command(f.boot.credential, f.visit.id, "sign", attemptId, input),
      service.command(f.boot.credential, f.visit.id, "sign", attemptId, input),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await saved()).toBe(1);
    expect((await service.attempt(f.boot.credential, f.visit.id, attemptId)).state).toBe("committed");
    await expect(service.command(f.boot.credential, f.visit.id, "sign", id(), input)).rejects.toMatchObject({ code: "REVOKED" });
  });
  test("owner grant loss/missing device declaration deny Cloud operations, while customer signature remains authorized", async () => {
    const f = await visiting();
    expect(await service.deviceOperation(f.boot.credential, "read", null)).toEqual({ deviceId: f.device.id });
    await sql`UPDATE auth.access SET permission='none' WHERE id=${grantId}::uuid`;
    await expect(service.deviceOperation(f.boot.credential, "read", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const undeclared = createAppPwaService({ ...base, devicePermissions: {} });
    await undeclared.setup();
    await expect(undeclared.deviceOperation(f.boot.credential, "read", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(operationCalls).toBe(1);
    expect(
      (await service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: false })).result,
    ).toEqual({ saved: true });
    expect(await saved()).toBe(1);
  });
  test("staff callback is rechecked inside transactions; listing is owner scoped and bounded", async () => {
    await issuedDevice();
    await issuedDevice();
    await issuedDevice();
    const list = await service.listDevices(signIn);
    expect(list.items).toHaveLength(2);
    expect(list.next).not.toBeNull();
    expect((await service.listDevices(signIn, list.next!)).items).toHaveLength(1);
    authorAllowed = false;
    await expect(issuedDevice()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.listDevices(signIn)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  test("device TTL is bounded by app, browser and initiating family; expired QR never consumes", async () => {
    const short = createAppPwaService({ ...base, deviceTtlSeconds: 600 });
    await short.setup();
    const boot = await short.bootstrap();
    const issue = await short.issueDevice(signIn, { requestId: id(), name: "iPad" });
    const device = await short.claimDevice(boot.credential, issue.qr!);
    const [row] = await sql<
      { seconds: number }[]
    >`SELECT extract(epoch from(expires_at-activated_at))::float AS seconds FROM app_pwa_b_service_test._cloud_pwa_devices WHERE id=${device.id}::uuid`;
    expect(row!.seconds).toBeLessThanOrEqual(600);
    const pending = await issuedDevice();
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET qr_expires_at=clock_timestamp()-interval '1 second' WHERE id=${pending.id}::uuid`;
    await expect(service.claimDevice((await service.bootstrap()).credential, pending.qr!)).rejects.toMatchObject({ code: "EXPIRED" });
  });
  test.each(["idle", "absolute", "device"])("%s expiry fails closed including result recovery", async (kind) => {
    const f = await visiting();
    const attemptId = id();
    await service.command(f.boot.credential, f.visit.id, "sign", attemptId, { revision: 1, signature: "Customer", finish: false });
    if (kind === "idle")
      await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET last_used_at=clock_timestamp()-interval '15 minutes' WHERE id=${f.visit.id}::uuid`;
    if (kind === "absolute")
      await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.visit.id}::uuid`;
    if (kind === "device")
      await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.device.id}::uuid`;
    await expect(service.query(f.boot.credential, f.visit.id, "document", null)).rejects.toMatchObject({ code: "EXPIRED" });
    if (kind === "device")
      await expect(service.attempt(f.boot.credential, f.visit.id, attemptId)).rejects.toMatchObject({ code: "EXPIRED" });
    else expect(await service.attempt(f.boot.credential, f.visit.id, attemptId)).toEqual({ state: "committed", completed: false });
  });
  test.each(["logout", "epoch", "deactivation", "signing-key", "category"])(
    "%s invalidation is checked on every guest operation",
    async (kind) => {
      const f = await visiting();
      if (kind === "logout")
        await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp(),revocation_reason='test' WHERE sid=${signIn.sid}::uuid`;
      if (kind === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${ownerId}::uuid`;
      if (kind === "deactivation")
        await sql`UPDATE auth.users SET account_expires=clock_timestamp()-interval '1 second' WHERE id=${ownerId}::uuid`;
      if (kind === "signing-key")
        await sql`UPDATE auth.signing_keys SET state='revoked',revoked_at=clock_timestamp(),revoke_reason='test' WHERE kid=${signIn.sid}`;
      if (kind === "category")
        await sql`INSERT INTO settings.entries(key,value) VALUES ('user.category.login.enabled',${await encryptValue(false)})`;
      await expect(service.status(f.boot.credential)).rejects.toMatchObject({ code: "WEB_SESSION_REQUIRED" });
      await expect(
        service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: false }),
      ).rejects.toMatchObject({ code: "WEB_SESSION_REQUIRED" });
      expect(await saved()).toBe(0);
    },
  );
  test("revocation that completes first prevents a subsequent domain commit", async () => {
    const f = await visiting();
    await service.revokeDevice(signIn, f.device.id);
    await expect(
      service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: false }),
    ).rejects.toMatchObject({ code: "REVOKED" });
    expect(await saved()).toBe(0);
    await expect(service.claimDevice(f.boot.credential, f.qr)).rejects.toMatchObject({ code: "REVOKED" });
  });
  test.each(["device-revoke", "visit-revoke", "logout", "epoch", "deactivation", "signing-key", "category-insert"])(
    "domain completion holds authority until commit before %s",
    async (kind) => {
      const f = await visiting();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      hold = { entered: enter, release: gate };
      const completing = service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: true });
      await entered;
      let invalidated = false;
      const invalidate = async () => {
        if (kind === "device-revoke") await service.revokeDevice(signIn, f.device.id);
        if (kind === "visit-revoke") await service.revokeVisit(signIn, f.device.id, f.visit.id);
        if (kind === "logout")
          await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp(),revocation_reason='test' WHERE sid=${signIn.sid}::uuid`;
        if (kind === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${ownerId}::uuid`;
        if (kind === "deactivation") await sql`UPDATE auth.users SET account_expires=clock_timestamp() WHERE id=${ownerId}::uuid`;
        if (kind === "signing-key")
          await sql`UPDATE auth.signing_keys SET state='revoked',revoked_at=clock_timestamp(),revoke_reason='test' WHERE kid=${signIn.sid}`;
        if (kind === "category-insert")
          await sql`INSERT INTO settings.entries(key,value) VALUES ('user.category.login.enabled',${await encryptValue(false)})`;
        invalidated = true;
      };
      const invalidating = invalidate();
      try {
        // A separate DB connection confirms the invalidator is waiting on a real authority lock.
        const observer = new SQL(requireDatabaseUrl());
        try {
          const deadline = Date.now() + 2000;
          let blocked = false;
          while (Date.now() < deadline) {
            const [row] = await observer<
              { blocked: boolean }[]
            >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock') AS blocked`;
            if (row?.blocked) {
              blocked = true;
              break;
            }
          }
          expect(blocked).toBe(true);
          expect(invalidated).toBe(false);
        } finally {
          await observer.close();
        }
      } finally {
        release();
      }
      await completing;
      await invalidating;
      expect(await saved()).toBe(1);
    },
  );
  test("fresh time after lock wait prevents expiry from using transaction-start now()", async () => {
    const f = await visiting();
    const blocker = new SQL(requireDatabaseUrl());
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocking = blocker.begin(async (tx) => {
      await tx`SELECT id FROM auth.users WHERE id=${ownerId}::uuid FOR UPDATE`;
      await tx`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=${f.visit.id}::uuid`;
      entered();
      await gate;
    });
    await ready;
    const completing = service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: false });
    try {
      await blocker`SELECT pg_sleep(0.2)`;
    } finally {
      release();
      await blocking;
      await blocker.close();
    }
    await expect(completing).rejects.toMatchObject({ code: "EXPIRED" });
    expect(await saved()).toBe(0);
  });
  test("expiry during the domain handler rolls back both domain write and result", async () => {
    const f = await visiting();
    const attemptId = id();
    const slow = createAppPwaService({
      ...base,
      commands: {
        sign: appPwaCommand({
          input: signature,
          output,
          handler: async ({ tx }) => {
            await tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1 WHERE id=${documentId}::uuid`;
            await tx`SELECT pg_sleep(0.2)`;
            return { saved: true };
          },
        }),
      },
    });
    await slow.setup();
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=${f.visit.id}::uuid`;
    await expect(
      slow.command(f.boot.credential, f.visit.id, "sign", attemptId, { revision: 1, signature: "Customer", finish: false }),
    ).rejects.toMatchObject({ code: "EXPIRED" });
    expect(await saved()).toBe(0);
    expect(await sql`SELECT 1 FROM app_pwa_b_service_test._cloud_pwa_attempts WHERE attempt_id=${attemptId}::uuid`).toHaveLength(0);
  });
  test("TTLs above twelve hours clamp and expired pending/active devices have honest staff views", async () => {
    await sql`UPDATE auth.session_families SET expires_at=clock_timestamp()+interval '24 hours' WHERE sid=${signIn.sid}::uuid`;
    const capped = createAppPwaService({ ...base, deviceTtlSeconds: 86400 });
    await capped.setup();
    const boot = await capped.bootstrap();
    const pending = await capped.issueDevice(signIn, { requestId: id(), name: "iPad" });
    const device = await capped.claimDevice(boot.credential, pending.qr!);
    const [row] = await sql<{ seconds: number }[]>`SELECT extract(epoch from(expires_at-activated_at))::float AS seconds
      FROM app_pwa_b_service_test._cloud_pwa_devices WHERE id=${device.id}::uuid`;
    expect(row!.seconds).toBeLessThanOrEqual(43200);
    expect(row!.seconds).toBeGreaterThan(43190);
    const expired = await issuedDevice();
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET qr_expires_at=clock_timestamp()-interval '1 second' WHERE id=${expired.id}::uuid`;
    expect((await service.deviceStatus(signIn, expired.id)).state).toBe("expired");
    expect((await service.listDevices(signIn)).items.find((item) => item.id === expired.id)?.state).toBe("expired");
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${device.id}::uuid`;
    expect((await service.deviceStatus(signIn, device.id)).state).toBe("expired");
  });

  test.each(["logout", "family-expiry", "epoch", "signing-key"])(
    "fresh staff sign-in reports the earlier device's %s invalidation",
    async (reason) => {
      const f = await paired();
      const oldSignIn = signIn;
      if (reason === "logout") await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp() WHERE sid=${oldSignIn.sid}::uuid`;
      if (reason === "family-expiry")
        await sql`UPDATE auth.session_families SET expires_at=clock_timestamp()-interval '1 second' WHERE sid=${oldSignIn.sid}::uuid`;
      if (reason === "epoch") await sql`UPDATE auth.users SET auth_epoch=auth_epoch+1 WHERE id=${ownerId}::uuid`;
      if (reason === "signing-key") await sql`UPDATE auth.signing_keys SET state='revoked' WHERE kid=${oldSignIn.sid}`;
      signIn = await createTestBrowserSignIn(ownerId);
      const expected = reason === "family-expiry" ? "expired" : "revoked";
      expect((await service.deviceStatus(signIn, f.device.id)).state).toBe(expected);
      expect((await service.listDevices(signIn)).items.find((device) => device.id === f.device.id)?.state).toBe(expected);
    },
  );

  test("the same owner can issue a visit from another current browser while the pairing family remains live", async () => {
    const f = await paired();
    const anotherBrowser = await createTestBrowserSignIn(ownerId);
    const issued = await service.issueVisit(anotherBrowser, {
      requestId: id(),
      deviceId: f.device.id,
      subject: { documentId, revision: 1 },
    });
    expect(issued.state).toBe("pending");
    expect((await service.claimVisit(f.boot.credential, issued.qr!)).state).toBe("active");
    await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp() WHERE sid=${signIn.sid}::uuid`;
    await expect(
      service.issueVisit(anotherBrowser, {
        requestId: id(),
        deviceId: f.device.id,
        subject: { documentId, revision: 1 },
      }),
    ).rejects.toMatchObject({ code: "WEB_SESSION_REQUIRED" });
  });

  test.each(["browser-expired", "device-expired", "revoked", "logout"])(
    "bootstrap safely resets %s authority using a generated credential",
    async (kind) => {
      const f = await paired();
      if (kind === "browser-expired")
        await sql`UPDATE app_pwa_b_service_test._cloud_pwa_browsers SET expires_at=clock_timestamp()-interval '1 second'
      WHERE device_id=${f.device.id}::uuid`;
      if (kind === "device-expired")
        await sql`UPDATE app_pwa_b_service_test._cloud_pwa_devices SET expires_at=clock_timestamp()-interval '1 second'
      WHERE id=${f.device.id}::uuid`;
      if (kind === "revoked") await service.revokeDevice(signIn, f.device.id);
      if (kind === "logout") await sql`UPDATE auth.session_families SET revoked_at=clock_timestamp() WHERE sid=${signIn.sid}::uuid`;
      const fresh = await service.bootstrap(f.boot.credential);
      expect(fresh.credential).not.toBe(f.boot.credential);
      expect(await service.bootstrap(fresh.credential)).toEqual(fresh);
      await expect(service.status(fresh.credential)).rejects.toMatchObject({ code: "BROWSER_REQUIRED" });
      // A new claim is possible without clearing the browser's cookie manually.
      if (kind === "logout") signIn = await createTestBrowserSignIn(ownerId);
      const next = await issuedDevice();
      expect((await service.claimDevice(fresh.credential, next.qr!)).id).toBe(next.id);
    },
  );

  test("terminal and old-customer attempts expose committed status without stored private output", async () => {
    const f = await visiting();
    const attemptId = id();
    const privateService = createAppPwaService({
      ...base,
      commands: {
        save: appPwaCommand({
          input: z.null(),
          output: z.strictObject({ private: z.string() }),
          handler: async ({ endVisit }) => {
            endVisit();
            return { private: "PRIVATE-CUSTOMER-DOCUMENT" };
          },
        }),
      },
    });
    await privateService.setup();
    const first = await privateService.command(f.boot.credential, f.visit.id, "save", attemptId, null);
    expect(first).toEqual({ state: "committed", completed: true, result: null, replayed: false });
    const expectStatusOnly = async (completed = true) => {
      expect(await privateService.command(f.boot.credential, f.visit.id, "save", attemptId, null)).toEqual({
        state: "committed",
        completed,
        result: null,
        replayed: true,
      });
      expect(await privateService.attempt(f.boot.credential, f.visit.id, attemptId)).toEqual({ state: "committed", completed });
    };
    await expectStatusOnly();
    await service.revokeVisit(signIn, f.device.id, f.visit.id);
    await expectStatusOnly();
    await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET state='revoked',expires_at=clock_timestamp()-interval '1 second'
      WHERE id=${f.visit.id}::uuid`;
    await expectStatusOnly(false);
    const next = await service.issueVisit(signIn, { deviceId: f.device.id, requestId: id(), subject: { documentId, revision: 1 } });
    await service.claimVisit(f.boot.credential, next.qr!);
    await expectStatusOnly(false);
    await expect(service.query(f.boot.credential, f.visit.id, "document", null)).rejects.toMatchObject({ code: "REVOKED" });
    await expect(privateService.command(f.boot.credential, f.visit.id, "save", id(), null)).rejects.toMatchObject({ code: "REVOKED" });
  });

  test("a category disable INSERT committing first blocks and rolls back a concurrent command", async () => {
    const f = await visiting();
    const connection = new SQL(requireDatabaseUrl());
    let release = () => {};
    let entered = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const encrypted = await encryptValue(false);
    const disabling = connection.begin(async (tx) => {
      await tx`INSERT INTO settings.entries(key,value) VALUES ('user.category.login.enabled',${encrypted})`;
      entered();
      await gate;
    });
    await ready;
    const completing = Promise.allSettled([
      service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "Customer", finish: false }),
    ]);
    try {
      let blocked = false;
      for (let poll = 0; poll < 100; poll++) {
        const [row] = await connection<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND relation='settings.entries'::regclass) AS blocked`;
        if (row?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      release();
      await disabling;
      await connection.close();
    }
    expect(await completing).toMatchObject([{ status: "rejected", reason: { code: "WEB_SESSION_REQUIRED" } }]);
    expect(await saved()).toBe(0);
  });

  test("current grant changes serialize with a device adapter until its domain commit", async () => {
    const f = await paired();
    let entered = () => {};
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deviceService = createAppPwaService({
      ...base,
      deviceOperations: {
        read: appPwaDeviceOperation({
          input: z.null(),
          output: z.null(),
          permission: "read",
          accessIds: async () => [grantId],
          handler: async ({ tx }) => {
            entered();
            await gate;
            await tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1`;
            return null;
          },
        }),
      },
    });
    await deviceService.setup();
    const operating = deviceService.deviceOperation(f.boot.credential, "read", null);
    await ready;
    const changing = Promise.allSettled([sql`UPDATE auth.access SET permission='none' WHERE id=${grantId}::uuid`]);
    try {
      let blocked = false;
      for (let poll = 0; poll < 100; poll++) {
        const [row] = await sql<
          { blocked: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE NOT granted AND relation='auth.access'::regclass) AS blocked`;
        if (row?.blocked) {
          blocked = true;
          break;
        }
        await Bun.sleep(10);
      }
      expect(blocked).toBe(true);
    } finally {
      release();
    }
    await operating;
    expect((await changing)[0]?.status).toBe("fulfilled");
    expect(await saved()).toBe(1);
    await expect(deviceService.deviceOperation(f.boot.credential, "read", null)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  test("cancellation rolls back domain writes and a handler ignoring its signal cannot write late", async () => {
    const f = await visiting();
    let entered = () => {};
    let release = () => {};
    let finished = () => {};
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const cancelled = createAppPwaService({
      ...base,
      commands: {
        sign: appPwaCommand({
          input: signature,
          output,
          handler: async ({ tx }) => {
            await tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1`;
            const late = tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1`;
            entered();
            await gate;
            try {
              await expect(Promise.resolve(late)).rejects.toMatchObject({ code: "UNAVAILABLE" });
              expect(() => tx`UPDATE app_pwa_b_service_test.documents SET saved=saved+1`).toThrow("UNAVAILABLE");
            } finally {
              finished();
            }
            return { saved: true };
          },
        }),
      },
    });
    await cancelled.setup();
    const controller = new AbortController();
    const attemptId = id();
    const running = cancelled.command(
      f.boot.credential,
      f.visit.id,
      "sign",
      attemptId,
      { revision: 1, signature: "Customer", finish: false },
      controller.signal,
    );
    await ready;
    controller.abort();
    try {
      await expect(running).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      release();
      await done;
    }
    expect(await saved()).toBe(0);
    expect(await service.attempt(f.boot.credential, f.visit.id, attemptId)).toEqual({ state: "unknown" });
  });

  test.each(["constraints-abort", "constraints-expiry", "commit-abort", "commit-expiry"])(
    "deferred FK %s cancels the complete lifecycle and releases authority/connection locks",
    async (mode) => {
      const f = await visiting();
      const attemptId = id();
      const pool = new SQL(requireDatabaseUrl(), { max: 1 });
      const observer = new SQL(requireDatabaseUrl(), { max: 2 });
      const blocker = await observer.reserve();
      let backend = 0;
      // Normally the FK blocks at the explicit drain. This test-only driver
      // adapter leaves constraints deferred for the COMMIT cases, so the real
      // PostgreSQL COMMIT (rather than a mock) independently exercises cancellation.
      const db = mode.startsWith("commit")
        ? new Proxy(pool, {
            get(target, property) {
              if (property === "reserve")
                return async (options?: { signal?: AbortSignal }) => {
                  const connection = await target.reserve(options);
                  return new Proxy(connection, {
                    apply(target, receiver, args) {
                      if (Array.isArray(args[0]) && args[0].join("") === "SET CONSTRAINTS ALL IMMEDIATE") return target`SELECT 1`;
                      return Reflect.apply(target, receiver, args);
                    },
                  });
                };
              return Reflect.get(target, property, target);
            },
          })
        : pool;
      const deferredService = createAppPwaService({
        ...base,
        db,
        commands: {
          sign: appPwaCommand({
            input: z.null(),
            output,
            handler: async ({ tx }) => {
              const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
              backend = row!.pid;
              // Do not read/update the parent: only the deferred FK should wait.
              await tx`INSERT INTO app_pwa_b_service_test.deferred_signatures VALUES (${attemptId}::uuid,${documentId}::uuid)`;
              return { saved: true };
            },
          }),
        },
      });
      const controller = new AbortController();
      const nativeSQL = bun.SQL;
      let cancellationSent = false;
      let parentReleased = false;
      // Observe the real, separate control connection; do not fake Query.cancel.
      // Release the blocker as soon as PostgreSQL accepts the cancel signal,
      // before cancellation cleanup/ROLLBACK settles. This causally selects the
      // cancellation-won race; releasing before delivery may legitimately commit.
      Object.defineProperty(bun, "SQL", {
        value: new Proxy(nativeSQL, {
          construct(target, args) {
            const pool: SQL = Reflect.construct(target, args);
            return new Proxy(pool, {
              get(target, property) {
                if (property === "reserve")
                  return async (options?: { signal?: AbortSignal }) => {
                    const connection = await target.reserve(options);
                    return new Proxy(connection, {
                      apply(target, receiver, args) {
                        return (async () => {
                          const rows: { cancelled: boolean }[] = await Reflect.apply(target, receiver, args);
                          if (Array.isArray(args[0]) && args[0].join("").includes("pg_cancel_backend")) {
                            cancellationSent = rows[0]?.cancelled === true;
                            if (mode.endsWith("abort")) {
                              await blocker`ROLLBACK`;
                              parentReleased = true;
                            }
                          }
                          return rows;
                        })();
                      },
                    });
                  };
                return Reflect.get(target, property, target);
              },
            });
          },
        }),
      });
      let running: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await deferredService.setup();
        // This real-clock expiry case retains a bounded scheduling assumption:
        // it must reach/observe the FK wait before the two-second visit deadline.
        // The unit expiry tests independently freeze the authority clock.
        if (mode.endsWith("expiry"))
          await sql`UPDATE app_pwa_b_service_test._cloud_pwa_visits SET expires_at=clock_timestamp()+interval '2 seconds'
            WHERE id=${f.visit.id}::uuid`;
        await blocker`BEGIN`;
        await blocker`SELECT id FROM app_pwa_b_service_test.documents WHERE id=${documentId}::uuid FOR UPDATE`;
        running = Promise.allSettled([deferredService.command(f.boot.credential, f.visit.id, "sign", attemptId, null, controller.signal)]);
        let blocked = false;
        for (let poll = 0; poll < 100; poll++) {
          const [row] = await observer<{ query: string; waiting: boolean }[]>`SELECT query,wait_event_type='Lock' AS waiting
            FROM pg_stat_activity WHERE pid=${backend}`;
          const expected = mode.startsWith("commit") ? "COMMIT" : "SET CONSTRAINTS ALL IMMEDIATE";
          if (row?.waiting && row.query.trim() === expected) {
            blocked = true;
            break;
          }
          await Bun.sleep(10);
        }
        expect(blocked).toBe(true);
        if (mode.endsWith("abort")) controller.abort();
        const [result] = await running;
        expect(result?.status).toBe("rejected");
        if (result?.status === "rejected") expect(["UNAVAILABLE", "EXPIRED"]).toContain(result.reason.code);
        // Natural statement/lock expiry alone cannot satisfy this guard.
        expect(cancellationSent).toBe(true);
        expect(parentReleased).toBe(mode.endsWith("abort"));
        // The captured backend is discarded on cancellation, never reused.
        const [state] = await observer<{ clean: boolean }[]>`SELECT NOT EXISTS(
          SELECT 1 FROM pg_stat_activity WHERE pid=${backend} AND xact_start IS NOT NULL) AS clean`;
        expect(state?.clean).toBe(true);
        await blocker`ROLLBACK`;
        expect(await observer`SELECT 1 FROM app_pwa_b_service_test.deferred_signatures WHERE attempt_id=${attemptId}::uuid`).toHaveLength(
          0,
        );
        expect(await observer`SELECT 1 FROM app_pwa_b_service_test._cloud_pwa_attempts WHERE attempt_id=${attemptId}::uuid`).toHaveLength(
          0,
        );
        // NOWAIT proves authority locks are gone, without relying on a polling view.
        await blocker`BEGIN`;
        await blocker`SELECT id FROM auth.users WHERE id=${ownerId}::uuid FOR UPDATE NOWAIT`;
        await blocker`SELECT sid FROM auth.session_families WHERE sid=${signIn.sid}::uuid FOR UPDATE NOWAIT`;
        await blocker`SELECT id FROM app_pwa_b_service_test._cloud_pwa_devices WHERE id=${f.device.id}::uuid FOR UPDATE NOWAIT`;
        await blocker`SELECT id FROM app_pwa_b_service_test._cloud_pwa_visits WHERE id=${f.visit.id}::uuid FOR UPDATE NOWAIT`;
        await blocker`ROLLBACK`;
        // max:1 forces reuse (or replacement if recovery discarded the connection).
        const reused = await pool.reserve();
        try {
          expect((await reused<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid).not.toBe(backend);
          await reused`BEGIN`;
          expect((await reused<{ value: number }[]>`SELECT 1 AS value`)[0]?.value).toBe(1);
          await reused`ROLLBACK`;
        } finally {
          reused.release();
        }
        expect(await saved()).toBe(0);
        expect(await service.attempt(f.boot.credential, f.visit.id, attemptId)).toEqual({ state: "unknown" });
      } finally {
        Object.defineProperty(bun, "SQL", { value: nativeSQL });
        controller.abort();
        try {
          await blocker`ROLLBACK`;
        } finally {
          blocker.release();
          try {
            if (running) await running;
          } finally {
            await Promise.all([pool.close(), observer.close()]);
          }
        }
      }
    },
  );

  test("visit issuance authorizes the validated subject and rechecks before committing", async () => {
    const f = await paired();
    await expect(
      service.issueVisit(signIn, {
        requestId: id(),
        deviceId: f.device.id,
        subject: { documentId: grantId, revision: 1 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    let calls = 0;
    const changing = createAppPwaService({
      ...base,
      authorizeVisit: async (actor, value, tx) => {
        expect(actor).toEqual(signIn);
        expect(value).toEqual({ documentId, revision: 1 });
        expect((await tx`SELECT 1 AS ready`)[0]?.ready).toBe(1);
        return ++calls === 1;
      },
    });
    await changing.setup();
    await expect(
      changing.issueVisit(signIn, {
        requestId: id(),
        deviceId: f.device.id,
        subject: { documentId, revision: 1 },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(calls).toBe(2);
    expect((await sql`SELECT id FROM app_pwa_b_service_test._cloud_pwa_visits WHERE device_id=${f.device.id}::uuid`).length).toBe(0);
  });

  test("audit records device/visit provenance without customer input or QR secrets", async () => {
    const f = await visiting();
    await service.command(f.boot.credential, f.visit.id, "sign", id(), { revision: 1, signature: "PRIVATE-SIGNATURE", finish: true });
    const rows = await sql<
      { actor_user_id: string | null; metadata: Record<string, unknown> }[]
    >`SELECT actor_user_id,metadata FROM audit.events WHERE metadata->>'deviceId'=${f.device.id}`;
    const customer = rows.find((row) => row.metadata.actorKind === "visit");
    expect(customer?.actor_user_id).toBeNull();
    const encoded = JSON.stringify(rows);
    expect(encoded).not.toContain("PRIVATE-SIGNATURE");
    expect(encoded).not.toContain(f.qr);
    expect(encoded).not.toContain(f.boot.credential);
  });
});
