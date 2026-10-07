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
import { sendEmail } from "../notifications/email";
import * as settings from "../settings";
import { coreSettings } from "../settings/api";
import { decryptValue } from "../settings/crypto";
import { mail } from "./index";
import { outgoingMailStore, resolveMailCredentials } from "./store";
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
  test("test-send and notification email reach the sink through the profile sender and explicit TLS mode", async () => {
    const sink = smtpSink();
    const read = spyOn(settings, "get").mockResolvedValue("Cloud");
    const logo = spyOn(coreSettings, "get").mockResolvedValue("");
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
      await sendEmail("notify@example.org", "Notification", { content: "Hello", messageId: "<test@cloud.invalid>" });
      expect(sink.messages).toHaveLength(2);
      expect(sink.messages[0]).toMatchObject({ from: config.fromAddress, to: ["recipient@example.org"] });
      expect(sink.messages[1]).toMatchObject({ from: config.fromAddress, to: ["notify@example.org"] });
      expect(sink.messages[1]!.raw).toContain("From: Sender <alerts@example.org>");
      expect(sink.messages[1]!.raw).toContain("Message-ID: <test@cloud.invalid>");
      expect(
        (await sql`SELECT action FROM audit.events WHERE request_id = ${context.requestId} AND action = 'outgoing_mail.profile.test'`)
          .length,
      ).toBe(1);
    } finally {
      read.mockRestore();
      logo.mockRestore();
      sink.stop();
    }
  });
});
