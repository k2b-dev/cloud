import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import {
  assessMessage,
  countReportsPerDay,
  createPolicy,
  createProtectedIdentity,
  deletePolicy,
  deleteProtectedIdentity,
  listPolicies,
  reportMessage,
  resolveReport,
  updateSettings,
} from "./security";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string; admin: boolean }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.uid,
      givenName: user.uid,
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: user.admin ? ["admin", "user"] : ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: user.admin,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-security-${user.uid}`,
});

suite("Mail security operations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const mailboxIds: string[] = [];
  const policyIds: string[] = [];
  const identityIds: string[] = [];
  let originalAuthservIds: string[] = [];
  let adminContext: MailRequestContext;
  let userContext: MailRequestContext;

  beforeAll(async () => {
    const users = await sql<{ id: string; uid: string; admin: boolean }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`mail-security-admin-${suffix}`}, 'local', 'user', 'Mail Security Admin', true),
        (${`mail-security-user-${suffix}`}, 'local', 'user', 'Mail Security User', false)
      RETURNING id, uid, admin
    `;
    const admin = users.find((user) => user.admin);
    const user = users.find((entry) => !entry.admin);
    if (!admin || !user) throw new Error("Failed to create Mail security test users");
    userIds.push(...users.map((entry) => entry.id));
    adminContext = contextFor(admin);
    userContext = contextFor(user);
    const [settings] = await sql<{ trusted_authserv_ids: string[] }[]>`
      SELECT trusted_authserv_ids FROM mail.security_settings WHERE singleton = true
    `;
    originalAuthservIds = settings?.trusted_authserv_ids ?? [];
  });

  afterAll(async () => {
    for (const mailboxId of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      if (access.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((entry) => entry.access_id)}::jsonb))
        `;
      }
    }
    if (policyIds.length > 0) {
      await sql`DELETE FROM mail.security_policies WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${policyIds}::jsonb))`;
    }
    if (identityIds.length > 0) {
      await sql`
        DELETE FROM mail.protected_identities WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${identityIds}::jsonb))
      `;
    }
    await sql`
      UPDATE mail.security_settings
      SET trusted_authserv_ids = ${toPgTextArray(originalAuthservIds)}::text[], updated_at = now()
      WHERE singleton = true
    `;
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
  }, 15_000);

  test("fails closed for non-admins and persists exact admin configuration", async () => {
    expect((await listPolicies(userContext)).ok).toBeFalse();

    const settings = await updateSettings({
      context: adminContext,
      trustedAuthservIds: ["MX.Security.Example", "mx.security.example", "backup.security.example"],
    });
    expect(settings.ok && settings.data.trustedAuthservIds).toEqual(["mx.security.example", "backup.security.example"]);

    const created = await createPolicy({
      context: adminContext,
      input: {
        disposition: "deny",
        target: "sender_domain",
        value: `blocked-${suffix}.example`,
        note: "Security integration test",
        enabled: true,
      },
    });
    expect(created.ok).toBeTrue();
    if (!created.ok) return;
    policyIds.push(created.data.id);

    const disabled = await createPolicy({
      context: adminContext,
      input: {
        disposition: "deny",
        target: "sender_domain",
        value: `blocked-${suffix}.example`,
        enabled: false,
      },
    });
    expect(disabled.ok && disabled.data.id).toBe(created.data.id);
    expect(disabled.ok && disabled.data.enabled).toBeFalse();

    const protectedIdentity = await createProtectedIdentity({
      context: adminContext,
      input: {
        name: `Security Billing ${suffix}`,
        allowedDomains: ["billing.example", "support.billing.example"],
        enabled: true,
      },
    });
    expect(protectedIdentity.ok && protectedIdentity.data.allowedDomains).toEqual(["billing.example", "support.billing.example"]);
    if (protectedIdentity.ok) identityIds.push(protectedIdentity.data.id);

    const auditRows = await sql<{ action: string }[]>`
      SELECT action FROM audit.events
      WHERE actor_user_id = ${adminContext.accessSubject.type === "user" ? adminContext.accessSubject.userId : null}::uuid
        AND action IN (
          'mail.security.settings.update',
          'mail.security.policy.create',
          'mail.security.protected_identity.create'
        )
    `;
    expect(new Set(auditRows.map((row) => row.action))).toEqual(
      new Set(["mail.security.settings.update", "mail.security.policy.create", "mail.security.protected_identity.create"]),
    );

    expect((await deletePolicy(adminContext, created.data.id)).ok).toBeTrue();
    policyIds.splice(policyIds.indexOf(created.data.id), 1);
    if (protectedIdentity.ok) {
      expect((await deleteProtectedIdentity(adminContext, protectedIdentity.data.id)).ok).toBeTrue();
      identityIds.splice(identityIds.indexOf(protectedIdentity.data.id), 1);
    }
  });

  test("assessing and reporting a blocked message does not emit workflow events", async () => {
    const mailbox = await createMailbox(adminContext, { name: `Mail security ${suffix}` });
    expect(mailbox.ok).toBeTrue();
    if (!mailbox.ok) return;
    mailboxIds.push(mailbox.data.id);

    const senderDomain = `blocked-workflow-${suffix}.example`;
    const policy = await createPolicy({
      context: adminContext,
      input: { disposition: "deny", target: "sender_domain", value: senderDomain, enabled: true },
    });
    expect(policy.ok).toBeTrue();
    if (!policy.ok) return;
    policyIds.push(policy.data.id);

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailbox.data.id}::uuid,
        ${`<mail-security-${suffix}@example.test>`},
        'Security workflow boundary',
        'security workflow boundary',
        now(),
        128,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},
        'complete'
      )
      RETURNING id
    `;
    if (!message) throw new Error("Failed to seed Mail security message");
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES (${message.id}::uuid, 'from', 0, 'Blocked sender', ${`sender@${senderDomain}`}, ${`sender@${senderDomain}`})
    `;

    const countEvents = async () => {
      const [row] = await sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM workflows.event
        WHERE app_id = 'mail' AND scope_id = ${mailbox.data.id}
      `;
      return Number(row?.count ?? 0);
    };
    const before = await countEvents();
    const assessment = await assessMessage(mailbox.data.id, message.id);
    expect(assessment.ok && assessment.data.verdict).toBe("quarantined");
    const reported = await reportMessage({ context: adminContext, mailboxId: mailbox.data.id, messageId: message.id });
    expect(reported.ok).toBeTrue();
    if (!reported.ok) return;
    expect(await countEvents()).toBe(before);

    const dismissed = await resolveReport({
      context: adminContext,
      reportId: reported.data.id,
      status: "dismissed",
      resolutionNote: "Known integration fixture",
    });
    expect(dismissed.ok && dismissed.data.resolutionNote).toBe("Known integration fixture");
    const reopened = await reportMessage({ context: adminContext, mailboxId: mailbox.data.id, messageId: message.id });
    expect(reopened.ok && reopened.data.status).toBe("new");
    expect(reopened.ok && reopened.data.resolutionNote).toBeNull();
    expect(reopened.ok && reopened.data.reportCount).toBe(1);
    expect(await countEvents()).toBe(before);
  });

  test("reports per day: one bounded statement, days in the request's time zone, empty days zero", async () => {
    const mailbox = await createMailbox(adminContext, { name: `Mail security days ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const reportIds: string[] = [];
    for (const index of [0, 1, 2]) {
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status)
        VALUES (${newShortId()}, ${mailbox.data.id}::uuid, ${`<mail-security-day-${index}-${suffix}@example.test>`}, 'Day', 'day', now(), 64,
          ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete')
        RETURNING id`;
      const reported = await reportMessage({ context: adminContext, mailboxId: mailbox.data.id, messageId: message!.id });
      if (!reported.ok) throw new Error(reported.error.message);
      reportIds.push(reported.data.id);
    }
    // a span no other test writes: 00:30 in Berlin is still the day before in UTC, and one report lies before the window
    const at = ["2031-03-28T23:30:00Z", "2031-03-29T10:00:00Z", "2031-02-01T10:00:00Z"];
    for (const [index, id] of reportIds.entries())
      await sql`UPDATE mail.security_reports SET created_at = ${at[index]!}::timestamptz WHERE id = ${id}::uuid`;
    const now = new Date("2031-03-29T12:00:00Z");

    expect(await countReportsPerDay(userContext, { now })).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    // the first call of a process loads what the admin check caches; the meter counts a page load after that
    await countReportsPerDay(adminContext, { now, timeZone: "Europe/Berlin" });
    const meter = await meterSql();
    let berlin: Awaited<ReturnType<typeof countReportsPerDay>> | undefined;
    try {
      const statements = await meter.during(async () => {
        berlin = await countReportsPerDay(adminContext, { now, timeZone: "Europe/Berlin" });
      });
      // the admin check and the one grouped count; never a statement per report or per day
      expect(statements.filter((statement) => statement.includes("mail.security_reports"))).toHaveLength(1);
      expect(statements).toHaveLength(2);
    } finally {
      await meter.close();
    }
    if (!berlin?.ok) throw new Error("Reports per day failed");
    expect(berlin.data).toHaveLength(30);
    expect(berlin.data[0]).toEqual({ day: "2031-02-28", count: 0 });
    expect(berlin.data.at(-1)).toEqual({ day: "2031-03-29", count: 2 });
    expect(berlin.data.reduce((sum, day) => sum + day.count, 0)).toBe(2);

    const utc = await countReportsPerDay(adminContext, { now, timeZone: "Not/AZone" });
    if (!utc.ok) throw new Error(utc.error.message);
    expect(utc.data.slice(-2)).toEqual([
      { day: "2031-03-28", count: 1 },
      { day: "2031-03-29", count: 1 },
    ]);
  });

  test("a spoofed From claiming a sender identity is still assessed and reportable", async () => {
    const mailbox = await createMailbox(adminContext, { name: `Mail security spoof ${suffix}` });
    expect(mailbox.ok).toBeTrue();
    if (!mailbox.ok) return;
    mailboxIds.push(mailbox.data.id);

    const ownDomain = `spoof-${suffix}.example`;
    const ownAddress = `owner@${ownDomain}`;
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailbox.data.id}::uuid, 'Owner', 'Owner', ${ownAddress}, true, 'verified')
    `;
    const policy = await createPolicy({
      context: adminContext,
      input: { disposition: "deny", target: "sender_domain", value: ownDomain, enabled: true },
    });
    expect(policy.ok).toBeTrue();
    if (!policy.ok) return;
    policyIds.push(policy.data.id);

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailbox.data.id}::uuid,
        ${`<mail-security-spoof-${suffix}@example.test>`},
        'Please confirm your account',
        'please confirm your account',
        now(),
        128,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},
        'complete'
      )
      RETURNING id
    `;
    if (!message) throw new Error("Failed to seed spoofed Mail security message");
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES
        (${message.id}::uuid, 'from', 0, 'Owner', ${ownAddress}, ${ownAddress}),
        (${message.id}::uuid, 'reply_to', 0, 'Attacker', ${`attacker@evil-${suffix}.example`}, ${`attacker@evil-${suffix}.example`})
    `;

    const assessment = await assessMessage(mailbox.data.id, message.id);
    expect(assessment.ok && assessment.data.verdict).toBe("quarantined");
    expect((await reportMessage({ context: adminContext, mailboxId: mailbox.data.id, messageId: message.id })).ok).toBeTrue();
  });
});
