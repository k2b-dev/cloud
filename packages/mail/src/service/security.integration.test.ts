import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { toPgTextArray } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { __test as draftCopies } from "./drafts";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import { openMessageSource, previewMessageSource } from "./message-inspector";
import { createAttachmentStream, openAttachment } from "./messages";
import {
  assessMessage,
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

  test("a message whose links a deny policy disables refuses its attachments; a clear message still opens them", async () => {
    const mailbox = await createMailbox(adminContext, { name: `Mail security attachments ${suffix}` });
    expect(mailbox.ok).toBeTrue();
    if (!mailbox.ok) return;
    mailboxIds.push(mailbox.data.id);
    const blockedDomain = `blocked-attachment-${suffix}.example`;
    const policy = await createPolicy({
      context: adminContext,
      input: { disposition: "deny", target: "sender_domain", value: blockedDomain, enabled: true },
    });
    expect(policy.ok).toBeTrue();
    if (!policy.ok) return;
    policyIds.push(policy.data.id);
    const withAttachment = async (label: string, sender: string) => {
      const bytes = Buffer.from(`${label} attachment`);
      const blob = await storeReadableBlob(Readable.from([bytes]), bytes.length);
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date,
          size_bytes, content_hash, hydration_status, source_blob_id)
        VALUES (${newShortId()}, ${mailbox.data.id}::uuid, ${`<${label}-${suffix}@example.test>`}, ${label}, ${label},
          now(), ${bytes.length}, ${blob.contentHash}, 'complete', ${blob.id}::uuid)
        RETURNING id`;
      if (!message) throw new Error("Failed to seed the attachment message");
      await sql`INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
        VALUES (${message.id}::uuid, 'from', 0, 'Sender', ${sender}, ${sender})`;
      const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts
        (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
        VALUES (${message.id}::uuid, '2', 'text/plain', 'attachment', 'offer.txt', ${bytes.length}, ${blob.id}::uuid, 'complete')
        RETURNING id`;
      if (!part) throw new Error("Failed to seed the attachment part");
      const [attachment] = await sql<{ id: string }[]>`INSERT INTO mail.attachments
        (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
        VALUES (${newShortId()}, ${message.id}::uuid, ${part.id}::uuid, 'offer.txt', 'text/plain', 'attachment', ${bytes.length}, ${blob.id}::uuid)
        RETURNING id`;
      if (!attachment) throw new Error("Failed to seed the attachment");
      return { mailboxId: mailbox.data.id, messageId: message.id, attachmentId: attachment.id };
    };
    const blocked = await withAttachment("blocked", `sender@${blockedDomain}`);
    const clear = await withAttachment("clear", `sender@clear-${suffix}.example`);
    const closed = { ok: false, error: { code: "ATTACHMENTS_BLOCKED", status: 403 } };
    expect(await openAttachment({ context: adminContext, ...blocked })).toMatchObject(closed);
    expect(await openAttachment({ context: adminContext, ...clear })).toMatchObject({ ok: true, data: { filename: "offer.txt" } });
    // a stream between its first and last chunk keeps only the access check
    expect(await openAttachment({ context: adminContext, ...blocked, assess: false })).toMatchObject({ ok: true });
    // the exact source carries the attachments: closed as well, for the preview and the download
    const source = (message: typeof blocked) => ({ context: adminContext, mailboxId: message.mailboxId, messageId: message.messageId });
    expect(await previewMessageSource(source(blocked))).toMatchObject(closed);
    expect(await openMessageSource(source(blocked))).toMatchObject(closed);
    expect(await previewMessageSource(source(clear))).toMatchObject({ ok: true });
    expect(await openMessageSource(source(clear))).toMatchObject({ ok: true });
    // a forward or "Use as new" copies no attachment of the closed message, and all of a clear one
    expect(await draftCopies.prepareSourceAttachments(sql, blocked.messageId)).toEqual({ ok: true, data: [] });
    expect(
      await draftCopies.copyForwardAttachments({
        db: sql,
        draftId: crypto.randomUUID(),
        sourceMessageId: blocked.messageId,
        forwarded: true,
      }),
    ).toEqual({
      ok: true,
      data: 0,
    });
    expect(await draftCopies.prepareSourceAttachments(sql, clear.messageId)).toMatchObject({ ok: true, data: [{ filename: "offer.txt" }] });
  });

  test("a download of three chunks checks the rule when it opens and before its last chunk, not before each", async () => {
    const mailbox = await createMailbox(adminContext, { name: `Mail security chunks ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxIds.push(mailbox.data.id);
    const bytes = Buffer.alloc(3 * 1024 * 1024 - 7, 7);
    const blob = await storeReadableBlob(Readable.from([bytes]), bytes.length);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, normalized_subject, internal_date,
        size_bytes, content_hash, hydration_status)
      VALUES (${newShortId()}, ${mailbox.data.id}::uuid, ${`<chunks-${suffix}@example.test>`}, 'Chunks', 'chunks',
        now(), ${bytes.length}, ${blob.contentHash}, 'complete')
      RETURNING id`;
    if (!message) throw new Error("Failed to seed the chunked message");
    const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts
      (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
      VALUES (${message.id}::uuid, '2', 'application/octet-stream', 'attachment', 'plan.bin', ${bytes.length}, ${blob.id}::uuid, 'complete')
      RETURNING id`;
    const [attachment] = await sql<{ id: string }[]>`INSERT INTO mail.attachments
      (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      VALUES (${newShortId()}, ${message.id}::uuid, ${part!.id}::uuid, 'plan.bin', 'application/octet-stream', 'attachment', ${bytes.length}, ${blob.id}::uuid)
      RETURNING id`;
    const params = { context: adminContext, mailboxId: mailbox.data.id, messageId: message.id, attachmentId: attachment!.id };
    const meter = await meterSql();
    try {
      let received = 0;
      // as the download route: open with the rule, then each chunk re-checks access and the last one the rule too
      const statements = await meter.during(async () => {
        const opened = await openAttachment(params);
        if (!opened.ok) throw new Error(opened.error.message);
        expect(opened.data.chunkCount).toBe(3);
        const stream = createAttachmentStream({
          ...opened.data,
          start: 0,
          endExclusive: opened.data.total,
          assertCurrentAccess: async (last) => {
            const current = await openAttachment({ ...params, assess: last });
            if (!current.ok) throw new Error(current.error.message);
          },
        });
        for await (const chunk of stream) received += chunk.byteLength;
      });
      expect(received).toBe(bytes.length);
      const assessments = statements.filter((statement) => statement.includes("selected_headers")).length;
      expect({ assessments, statements: statements.length }).toEqual({ assessments: 2, statements: 35 });
    } finally {
      await meter.close();
    }
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
