import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { sql } from "bun";
import { smtpSink } from "../../../../../scripts/fixtures/smtp-sink";
import { databaseSuite, useFreshDatabase } from "../../../../../scripts/fixtures/test-infra";
import { migrate as migrateAudit } from "../../../../core/src/migrate/core/audit";
import { migrate } from "../../../../core/src/migrate/core/outgoing-mail";
import { bindProcessApplicationId, clearProcessApplicationId } from "../../_internal/process-identity";
import * as registry from "../../_internal/registry";
import type { AppRegistryEntry } from "../../contracts/registry";
import { audit } from "../audit";
import * as settings from "../settings";
import { decryptValue } from "../settings/crypto";
import { mail } from "./index";
import { listImapMailProfiles, outgoingMailStore, resolveImapMailCredentials, resolveMailCredentials, saveImapMailCheck } from "./store";
import { outgoingMailTest } from "./test-send";

const config = {
  name: "Alerts",
  fromAddress: "alerts@example.org",
  fromName: null,
  smtpHost: "smtp.example.org",
  smtpPort: 587,
  smtpSecure: false,
  smtpUser: null,
  pacePerMinute: 60,
  dailyRecipientLimit: null,
  maxAttachmentBytes: 15728640,
};
const context = { actor: { uid: "outgoing-mail-test" }, requestId: crypto.randomUUID() };
const app = (id: string, declared = true): AppRegistryEntry => ({
  id,
  name: id,
  icon: "mail",
  description: id,
  routes: [],
  baseUrl: "http://test",
  platformPermissions: declared ? ["mail:send"] : [],
});
databaseSuite()("outgoing mail store and delivery", () => {
  const prefix = `test-${crypto.randomUUID().slice(0, 8)}`;
  const a = `${prefix}-a`,
    b = `${prefix}-b`,
    appId = `${prefix}-app`;
  let registered: ReturnType<typeof spyOn<typeof registry, "listApps">>;
  let fresh: Awaited<ReturnType<typeof useFreshDatabase>>;
  beforeAll(async () => {
    fresh = await useFreshDatabase("outgoing_mail_store");
    await sql`CREATE SCHEMA settings`.simple();
    await sql`CREATE TABLE settings.entries(key TEXT PRIMARY KEY, value TEXT NOT NULL)`.simple();
    await migrate();
    await migrateAudit();
    registered = spyOn(registry, "listApps").mockResolvedValue([app("core"), app(appId)]);
  });
  beforeEach(async () => {
    clearProcessApplicationId();
    bindProcessApplicationId("core", ["mail:send"]);
    await sql`DELETE FROM outgoing_mail.app_profiles`;
    await sql`DELETE FROM outgoing_mail.app_access`;
    await sql`DELETE FROM outgoing_mail.profiles`;
    await sql`DELETE FROM audit.events`;
  });
  afterAll(async () => {
    clearProcessApplicationId();
    registered?.mockRestore();
    await sql.close();
    await fresh?.drop();
  });
  test("passwords stay encrypted, omission preserves them, and revisions prevent lost updates", async () => {
    const first = await outgoingMailStore.put(a, { ...config, smtpPassword: "smtp-secret" }, context);
    expect(first.profile.isDefault).toBe(true);
    expect(first.profile.hasPassword).toBe(true);
    expect(JSON.stringify(first)).not.toContain("smtp-secret");
    expect(JSON.stringify(first)).not.toContain("smtpPassword");
    expect((await resolveMailCredentials(a)).smtpPassword).toBe("smtp-secret");
    for (const appId of ["gateway-ops", "inventory"]) {
      clearProcessApplicationId();
      bindProcessApplicationId(appId);
      expect((await resolveMailCredentials(a)).smtpPassword).toBe("smtp-secret");
    }
    const [stored] = await sql<
      { smtp_password_encrypted: string }[]
    >`SELECT smtp_password_encrypted FROM outgoing_mail.profiles WHERE key = ${a}`;
    expect(stored!.smtp_password_encrypted).not.toBe("smtp-secret");
    const replaced = await outgoingMailStore.put(a, { ...config, name: "Changed", revision: first.profile.revision }, context);
    expect((await resolveMailCredentials(a)).smtpPassword).toBe("smtp-secret");
    await expect(outgoingMailStore.put(a, config, context)).rejects.toMatchObject({ code: "profile_exists" });
    await expect(outgoingMailStore.put(a, { ...config, revision: first.profile.revision }, context)).rejects.toMatchObject({
      code: "revision_conflict",
    });
    await outgoingMailStore.put(a, { ...config, smtpPassword: null, revision: replaced.profile.revision }, context);
    expect((await outgoingMailStore.get(a)).hasPassword).toBe(false);
  });
  test("changing SMTP hosts requires replacing or removing a stored password", async () => {
    const first = await outgoingMailStore.put(a, { ...config, smtpPassword: "original-secret" }, context);
    const before = await sql`SELECT smtp_host, smtp_password_encrypted, revision FROM outgoing_mail.profiles WHERE key = ${a}`;
    const replacement = { ...config, smtpHost: "new.example.org", revision: first.profile.revision };
    await expect(outgoingMailStore.put(a, replacement, context)).rejects.toMatchObject({
      code: "invalid_profile",
      status: 400,
      message: "Enter the SMTP password again, or remove it, when you change the SMTP host.",
    });
    expect(await sql`SELECT smtp_host, smtp_password_encrypted, revision FROM outgoing_mail.profiles WHERE key = ${a}`).toEqual(before);
    const replaced = await outgoingMailStore.put(a, { ...replacement, smtpPassword: "new-secret" }, context);
    const [stored] = await sql<
      { smtp_host: string; smtp_password_encrypted: string }[]
    >`SELECT smtp_host, smtp_password_encrypted FROM outgoing_mail.profiles WHERE key = ${a}`;
    expect(stored!.smtp_host).toBe(replacement.smtpHost);
    expect(await decryptValue(stored!.smtp_password_encrypted)).toBe("new-secret");
    const sameHost = await outgoingMailStore.put(
      a,
      { ...replacement, smtpHost: "  NEW.EXAMPLE.ORG  ", revision: replaced.profile.revision },
      context,
    );
    expect(sameHost.profile.hasPassword).toBe(true);
    expect((await resolveMailCredentials(a)).smtpPassword).toBe("new-secret");
    const cleared = await outgoingMailStore.put(
      a,
      { ...replacement, smtpHost: "another.example.org", smtpPassword: null, revision: sameHost.profile.revision },
      context,
    );
    expect(cleared.profile.hasPassword).toBe(false);
    expect((await resolveMailCredentials(a)).smtpPassword).toBeNull();
  });

  test("IMAP passwords are encrypted, host changes require replacement, and disabling clears all IMAP state", async () => {
    const imap = { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX" };
    let current = (await outgoingMailStore.put(a, { ...config, imap: { ...imap, password: "imap-secret" } }, context)).profile;
    expect(current.imap).toEqual({ ...imap, hasPassword: true });
    expect(current.bounces).toEqual({ checkedAt: null, error: null });
    expect(JSON.stringify(current)).not.toContain("imap-secret");
    const [polling] = await listImapMailProfiles();
    expect(polling).toBeDefined();
    expect(await resolveImapMailCredentials(polling!)).toBe("imap-secret");
    const [stored] = await sql<
      { imap_password_encrypted: string }[]
    >`SELECT imap_password_encrypted FROM outgoing_mail.profiles WHERE key = ${a}`;
    expect(stored!.imap_password_encrypted).not.toBe("imap-secret");
    await saveImapMailCheck(polling!, { uidValidity: "42", lastUid: 200 });
    current = (await outgoingMailStore.put(a, { ...config, imap, revision: current.revision }, context)).profile;
    expect(current.imap?.hasPassword).toBe(true);
    expect(current.bounces?.checkedAt).not.toBeNull();
    expect(
      await sql<
        Record<string, unknown>[]
      >`SELECT imap_uid_validity::text AS validity, imap_last_uid::int AS uid FROM outgoing_mail.profiles WHERE key = ${a}`,
    ).toEqual([{ validity: "42", uid: 200 }]);
    await expect(
      outgoingMailStore.put(a, { ...config, imap: { ...imap, host: "other.example.org" }, revision: current.revision }, context),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    current = (
      await outgoingMailStore.put(
        a,
        { ...config, imap: { ...imap, host: "other.example.org", password: null }, revision: current.revision },
        context,
      )
    ).profile;
    expect(current.imap?.hasPassword).toBe(false);
    expect(
      await sql<
        Record<string, unknown>[]
      >`SELECT imap_uid_validity, imap_last_uid, imap_error FROM outgoing_mail.profiles WHERE key = ${a}`,
    ).toEqual([{ imap_uid_validity: null, imap_last_uid: null, imap_error: null }]);
    current = (
      await outgoingMailStore.put(a, { ...config, imap: { ...imap, password: "new-secret" }, revision: current.revision }, context)
    ).profile;
    expect(await resolveImapMailCredentials((await listImapMailProfiles())[0]!)).toBe("new-secret");
    for (const off of [null, undefined]) {
      current = (await outgoingMailStore.put(a, { ...config, imap: off, revision: current.revision }, context)).profile;
      expect(current.imap).toBeNull();
      expect(current.bounces).toBeNull();
      expect(await listImapMailProfiles()).toEqual([]);
      const [disabled] = await sql<
        Record<string, unknown>[]
      >`SELECT imap_host, imap_port, imap_secure, imap_user, imap_password_encrypted, imap_folder,
        imap_uid_validity, imap_last_uid, imap_checked_at, imap_error FROM outgoing_mail.profiles WHERE key = ${a}`;
      expect(Object.values(disabled ?? {})).toEqual(Array(10).fill(null));
    }
  });
  test.each(["port", "user", "folder"])("changing IMAP %s resets its cursor and check status", async (field) => {
    const imap = { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX" };
    const current = (await outgoingMailStore.put(a, { ...config, imap }, context)).profile;
    await sql`UPDATE outgoing_mail.profiles SET imap_uid_validity = 42, imap_last_uid = 200, imap_error = 'old failure', imap_checked_at = now() WHERE key = ${a}`;
    const changed = { ...imap, ...(field === "port" ? { port: 143 } : field === "user" ? { user: "other" } : { folder: "Reports" }) };
    await outgoingMailStore.put(a, { ...config, imap: changed, revision: current.revision }, context);
    expect(
      await sql<
        Record<string, unknown>[]
      >`SELECT imap_uid_validity, imap_last_uid, imap_error, imap_checked_at FROM outgoing_mail.profiles WHERE key = ${a}`,
    ).toEqual([{ imap_uid_validity: null, imap_last_uid: null, imap_error: null, imap_checked_at: null }]);
  });
  test("cursor CAS prevents overlapping checks and old configuration from overwriting newer progress", async () => {
    const imap = { host: "imap.example.org", port: 993, secure: true, user: "sender", folder: "INBOX" };
    const current = (await outgoingMailStore.put(a, { ...config, imap }, context)).profile;
    const [polling] = await listImapMailProfiles();
    await saveImapMailCheck(polling!, { uidValidity: "42", lastUid: 20 });
    await saveImapMailCheck(polling!, { uidValidity: "42", lastUid: 10 });
    await saveImapMailCheck(polling!, { error: "stale failure" });
    expect(
      await sql<
        Record<string, unknown>[]
      >`SELECT imap_uid_validity::text AS validity, imap_last_uid::int AS uid, imap_error FROM outgoing_mail.profiles WHERE key = ${a}`,
    ).toEqual([{ validity: "42", uid: 20, imap_error: null }]);
    const [newer] = await listImapMailProfiles();
    await saveImapMailCheck(newer!, { error: "connection failed" });
    expect((await outgoingMailStore.get(a)).bounces?.error).toBe("connection failed");
    await outgoingMailStore.put(a, { ...config, imap: { ...imap, folder: "Other" }, revision: current.revision }, context);
    await saveImapMailCheck(newer!, { uidValidity: "42", lastUid: 30 });
    expect(await sql<Record<string, unknown>[]>`SELECT imap_last_uid FROM outgoing_mail.profiles WHERE key = ${a}`).toEqual([
      { imap_last_uid: null },
    ]);
  });
  test("defaults remain unique and cannot be deleted, access follows default/selected/empty modes", async () => {
    await outgoingMailStore.put(a, config, context);
    const aProfile = await outgoingMailStore.get(a);
    await outgoingMailStore.put(a, { ...config, revision: aProfile.revision }, context);
    await outgoingMailStore.put(b, { ...config, name: "Other" }, context);
    await outgoingMailStore.setDefault(a, context);
    expect((await outgoingMailStore.list()).filter((p) => p.isDefault)).toHaveLength(1);
    await expect(outgoingMailStore.delete(a, context)).rejects.toMatchObject({ code: "profile_is_default" });
    clearProcessApplicationId();
    bindProcessApplicationId(appId);
    expect(await mail.profiles()).toMatchObject({ ok: false, error: { code: "mail_not_declared" } });
    bindProcessApplicationId(appId, ["mail:send"]);
    expect(await mail.profiles()).toMatchObject({ ok: true, data: [{ key: a, quota: { usedLast24h: 0 } }] });
    await outgoingMailStore.setAppAccess(appId, { mode: "selected", profiles: [a, b] }, context);
    const selected = await mail.profiles();
    expect(selected.ok && selected.data.map((p) => p.key)).toEqual([a, b]);
    expect(JSON.stringify(selected)).not.toContain("smtp");
    await outgoingMailStore.setAppAccess(appId, { mode: "selected", profiles: [] }, context);
    expect(await mail.profiles()).toEqual({ ok: true, data: [] });
    await expect(outgoingMailStore.setAppAccess(appId, { mode: "selected", profiles: ["unknown"] }, context)).rejects.toMatchObject({
      code: "profile_unknown",
      status: 400,
    });
    await outgoingMailStore.setAppAccess(appId, { mode: "default" }, context);
    expect(await sql`SELECT * FROM outgoing_mail.app_access WHERE app_id = ${appId}`).toHaveLength(0);
    expect(await sql`SELECT * FROM outgoing_mail.app_profiles WHERE app_id = ${appId}`).toHaveLength(0);
    clearProcessApplicationId();
    bindProcessApplicationId("core", ["mail:send"]);
    await outgoingMailStore.setDefault(b, context);
    await outgoingMailStore.delete(a, context);
    expect((await outgoingMailStore.list()).filter((p) => p.isDefault).map((p) => p.key)).toEqual([b]);
    const events = await audit.list({ filter: { target: a } });
    expect(events.items.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "outgoing_mail.profile.create",
        "outgoing_mail.profile.update",
        "outgoing_mail.profile.delete",
        "outgoing_mail.profile.set_default",
      ]),
    );
    const accessEvents =
      await sql`SELECT action FROM audit.events WHERE request_id = ${context.requestId} AND action = 'outgoing_mail.app_access.update'`;
    expect(accessEvents.length).toBe(3);
  });
  test("concurrent first creations leave one default and atomic audit records", async () => {
    const results = await Promise.all([outgoingMailStore.put(a, config, context), outgoingMailStore.put(b, config, context)]);
    expect(results.filter((result) => result.profile.isDefault)).toHaveLength(1);
    expect((await outgoingMailStore.list()).filter((profile) => profile.isDefault)).toHaveLength(1);
    const [event] = await sql<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM audit.events WHERE action = 'outgoing_mail.profile.create'`;
    expect(event!.count).toBe(2);
    const failingAudit = spyOn(audit, "record").mockRejectedValue(new Error("Audit unavailable"));
    try {
      await expect(outgoingMailStore.put(`${prefix}-rollback`, config, context)).rejects.toThrow("Audit unavailable");
      expect(await sql`SELECT key FROM outgoing_mail.profiles WHERE key = ${`${prefix}-rollback`}`).toHaveLength(0);
    } finally {
      failingAudit.mockRestore();
    }
  });
  test("app counts and offline policies reflect default and selected access", async () => {
    await outgoingMailStore.put(a, config, context);
    await outgoingMailStore.put(b, config, context);
    expect((await outgoingMailStore.get(a)).appCount).toBe(2);
    await outgoingMailStore.setAppAccess(appId, { mode: "selected", profiles: [b] }, context);
    expect((await outgoingMailStore.get(a)).appCount).toBe(1);
    expect((await outgoingMailStore.get(b)).appCount).toBe(1);
    await outgoingMailStore.setAppAccess("offline", { mode: "selected", profiles: [b] }, context);
    expect((await outgoingMailStore.apps()).items.find((app) => app.appId === "offline")).toEqual({
      appId: "offline",
      name: "offline",
      registered: false,
      declared: false,
      mode: "selected",
      profiles: [b],
    });
    expect((await outgoingMailStore.get(b)).appCount).toBe(2);
    await outgoingMailStore.delete(b, context);
    expect((await outgoingMailStore.apps()).items.find((app) => app.appId === "offline")?.profiles).toEqual([]);
  });
  test("test-send reaches the sink through the profile sender and explicit TLS mode", async () => {
    const sink = smtpSink();
    const read = spyOn(settings, "get").mockResolvedValue("Cloud");
    try {
      const current = (await outgoingMailStore.put(b, config, context)).profile;
      await outgoingMailStore.put(
        b,
        {
          ...config,
          smtpHost: sink.host,
          smtpPort: sink.port,
          smtpUser: "user",
          smtpPassword: "password",
          fromName: "Sender",
          revision: current.revision,
        },
        context,
      );
      await outgoingMailTest.send(b, "recipient@example.org", context);
      expect(sink.messages).toHaveLength(1);
      expect(sink.messages[0]).toMatchObject({ from: config.fromAddress, to: ["recipient@example.org"] });
      expect(sink.messages[0]!.raw).toContain("From: Sender <alerts@example.org>");
      expect(
        (await sql`SELECT action FROM audit.events WHERE request_id = ${context.requestId} AND action = 'outgoing_mail.profile.test'`)
          .length,
      ).toBe(1);
    } finally {
      read.mockRestore();
      sink.stop();
    }
  });
});
