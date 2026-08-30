import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Readable } from "node:stream";
import { sql } from "bun";
import { createConfig } from "@k2b/ssr";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import {
  claimPublicAttachmentDownload,
  createPublicAttachmentLink,
  hashAttachmentLinkToken,
  listPublicAttachmentLinks,
  revokePublicAttachmentLink,
  unlockPublicAttachmentLink,
} from "./attachment-links";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";

const ssrRoot = mkdtempSync(resolve(tmpdir(), "mail-attachment-link-ssr-tests-"));
const { plugin } = createConfig({ dev: true, rootDir: ssrRoot });
Bun.plugin(plugin());
process.once("exit", () => rmSync(ssrRoot, { recursive: true, force: true }));

const { publicAttachmentRoutes } = await import("../frontend/public-attachments");

const suite = process.env.MAIL_INTEGRATION_TESTS === "1" ? describe : describe.skip;

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
      mail: `${user.uid}@example.com`,
      roles: user.admin ? ["admin", "user"] : ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: user.admin,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `attachment-links-${user.uid}`,
});

suite("public attachment links", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  const blobIds: string[] = [];
  const bytes = Buffer.from("public attachment bytes");
  let adminContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let mailboxId: string;
  let messageId: string;
  let attachmentId: string;

  beforeAll(async () => {
    await migrate();
    const users = await sql<{ id: string; uid: string; admin: boolean }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`attachment-admin-${suffix}`}, 'local', 'user', 'Attachment Admin', true),
        (${`attachment-writer-${suffix}`}, 'local', 'user', 'Attachment Writer', false)
      RETURNING id, uid, admin
    `;
    const admin = users.find((user) => user.admin);
    const writer = users.find((user) => !user.admin);
    if (!admin || !writer) throw new Error("Failed to create attachment-link users");
    userIds.push(...users.map((user) => user.id));
    adminContext = contextFor(admin);
    writerContext = contextFor(writer);

    const mailbox = await createMailbox(adminContext, { name: `Attachment links ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const writerAccess = await grantMailboxAccess({
      context: adminContext,
      mailboxId,
      principal: { type: "user", userId: writer.id },
      permission: "write",
    });
    if (!writerAccess.ok) throw new Error(writerAccess.error.message);
    accessIds.push(writerAccess.data.id);

    const blob = await storeReadableBlob(Readable.from([bytes]), bytes.byteLength);
    blobIds.push(blob.id);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, ${`<attachment-links-${suffix}@example.com>`}, 'Public attachment', now(),
        ${bytes.byteLength}, ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete'
      )
      RETURNING id
    `;
    if (!message) throw new Error("Failed to create attachment-link message");
    messageId = message.id;
    const [part] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${messageId}::uuid, '1', 'text/plain', 'attachment', 'private-name.txt', ${bytes.byteLength},
        ${blob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    const [attachment] = await sql<{ id: string }[]>`
      INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      VALUES (${newShortId()},
        ${messageId}::uuid, ${part!.id}::uuid, 'private-name.txt', 'text/plain', 'attachment',
        ${bytes.byteLength}, ${blob.id}::uuid
      )
      RETURNING id
    `;
    if (!attachment) throw new Error("Failed to create attachment-link attachment");
    attachmentId = attachment.id;
  });

  afterAll(async () => {
    const ownerAccess = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
    `;
    accessIds.push(...ownerAccess.map((row) => row.access_id));
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (accessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (blobIds.length > 0) {
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    }
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  const createLink = (input: { password?: string; maxDownloads?: number; expiresAt?: string } = {}) =>
    createPublicAttachmentLink({
      context: adminContext,
      mailboxId,
      sourceKind: "message",
      sourceId: messageId,
      attachmentId,
      input,
    });

  test("enforces Admin access, stores only hashes, and paginates every link", async () => {
    const first = await createLink({ password: " exact secret ", maxDownloads: 5, expiresAt: "2099-01-01T00:00:00.000Z" });
    const second = await createLink();
    const third = await createLink();
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    expect(first.data.link).toMatchObject({ mailboxId, sourceKind: "message", sourceId: messageId });

    const denied = await createPublicAttachmentLink({
      context: writerContext,
      mailboxId,
      sourceKind: "message",
      sourceId: messageId,
      attachmentId,
      input: {},
    });
    expect(denied.ok).toBe(false);

    const token = first.data.url.split("/").at(-1)!;
    const [stored] = await sql<{ token_hash: string; password_hash: string | null }[]>`
      SELECT token_hash, password_hash FROM mail.attachment_links WHERE id = ${first.data.link.id}::uuid
    `;
    expect(stored?.token_hash).toBe(hashAttachmentLinkToken(token));
    expect(stored?.token_hash).not.toContain(token);
    expect(stored?.password_hash).not.toBe(" exact secret ");

    await sql`UPDATE mail.attachment_links SET created_at = '2026-07-21T10:00:00Z' WHERE id = ${first.data.link.id}::uuid`;
    await sql`UPDATE mail.attachment_links SET created_at = '2026-07-21T11:00:00Z' WHERE id = ${second.data.link.id}::uuid`;
    await sql`UPDATE mail.attachment_links SET created_at = '2026-07-21T12:00:00Z' WHERE id = ${third.data.link.id}::uuid`;

    const newest = await listPublicAttachmentLinks(adminContext, mailboxId, { limit: 2 });
    expect(newest.ok).toBe(true);
    if (!newest.ok) return;
    expect(newest.data.items.map((link) => link.id)).toEqual([third.data.link.id, second.data.link.id]);
    expect(newest.data.nextCursor).not.toBeNull();
    expect(newest.data.items[0]).not.toHaveProperty("url");

    const older = await listPublicAttachmentLinks(adminContext, mailboxId, { limit: 2, cursor: newest.data.nextCursor! });
    expect(older.ok).toBe(true);
    if (!older.ok) return;
    expect(older.data.items.some((link) => link.id === first.data.link.id)).toBe(true);
    expect(older.data.nextCursor).toBeNull();

    const malformed = await listPublicAttachmentLinks(adminContext, mailboxId, { cursor: "not-a-cursor" });
    expect(malformed.ok).toBe(false);
    const revoked = await revokePublicAttachmentLink({ context: adminContext, mailboxId, linkId: first.data.link.id });
    expect(revoked.ok && revoked.data.revokedAt).toBeTruthy();
  });

  test("allows only one first claim at a one-download limit", async () => {
    const created = await createLink({ maxDownloads: 1 });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const token = created.data.url.split("/").at(-1)!;
    const [grantA, grantB] = await Promise.all([unlockPublicAttachmentLink(token), unlockPublicAttachmentLink(token)]);
    expect(grantA.ok && grantB.ok).toBe(true);
    if (!grantA.ok || !grantB.ok) return;

    const claims = await Promise.all([
      claimPublicAttachmentDownload({ publicToken: token, grantToken: grantA.data.grantToken }),
      claimPublicAttachmentDownload({ publicToken: token, grantToken: grantB.data.grantToken }),
    ]);
    expect(claims.filter((claim) => claim.ok)).toHaveLength(1);
    const winner = claims[0]!.ok ? grantA.data.grantToken : grantB.data.grantToken;
    expect((await claimPublicAttachmentDownload({ publicToken: token, grantToken: winner })).ok).toBe(true);
    const [count] = await sql<{ download_count: string | number }[]>`
      SELECT download_count FROM mail.attachment_links WHERE id = ${created.data.link.id}::uuid
    `;
    expect(Number(count?.download_count)).toBe(1);
  });

  test("public HTTP rejects abuse, preserves password spaces, and counts a ranged session once", async () => {
    const ranged = await createLink({ maxDownloads: 1 });
    expect(ranged.ok).toBe(true);
    if (!ranged.ok) return;
    const token = ranged.data.url.split("/").at(-1)!;
    const path = `/attachments/${token}`;

    const invalidRange = await publicAttachmentRoutes.request(path, {
      headers: { Range: "bytes=999-", "X-Forwarded-For": `198.51.100.${suffix.charCodeAt(0)}` },
    });
    expect(invalidRange.status).toBe(416);
    const [grantCount] = await sql<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM mail.attachment_link_grants
      WHERE link_id = ${ranged.data.link.id}::uuid
    `;
    expect(grantCount?.count).toBe(0);
    let [count] = await sql<{ download_count: string | number }[]>`
      SELECT download_count FROM mail.attachment_links WHERE id = ${ranged.data.link.id}::uuid
    `;
    expect(Number(count?.download_count)).toBe(0);

    const firstRange = await publicAttachmentRoutes.request(path, {
      headers: { Range: "bytes=0-5", "X-Forwarded-For": `198.51.101.${suffix.charCodeAt(0)}` },
    });
    expect(firstRange.status).toBe(206);
    expect(Buffer.from(await firstRange.arrayBuffer()).toString()).toBe(bytes.subarray(0, 6).toString());
    const cookie = firstRange.headers.get("set-cookie")?.split(";", 1)[0];
    expect(cookie).toBeTruthy();
    if (process.env.NODE_ENV !== "development") expect(firstRange.headers.get("set-cookie")).toContain("Secure");

    const resumed = await publicAttachmentRoutes.request(path, {
      headers: {
        Range: "bytes=6-11",
        Cookie: cookie!,
        "X-Forwarded-For": `198.51.102.${suffix.charCodeAt(0)}`,
      },
    });
    expect(resumed.status).toBe(206);
    expect(Buffer.from(await resumed.arrayBuffer()).toString()).toBe(bytes.subarray(6, 12).toString());
    [count] = await sql<{ download_count: string | number }[]>`
      SELECT download_count FROM mail.attachment_links WHERE id = ${ranged.data.link.id}::uuid
    `;
    expect(Number(count?.download_count)).toBe(1);

    const protectedLink = await createLink({ password: " secret with spaces " });
    expect(protectedLink.ok).toBe(true);
    if (!protectedLink.ok) return;
    const protectedToken = protectedLink.data.url.split("/").at(-1)!;
    const protectedPath = `/attachments/${protectedToken}`;
    const locked = await publicAttachmentRoutes.request(protectedPath, {
      headers: { "X-Forwarded-For": `203.0.113.${suffix.charCodeAt(0)}` },
    });
    expect(locked.status).toBe(200);
    const lockedHtml = await locked.text();
    expect(lockedHtml).toContain("minimal-layout-preferences--bottom-right");
    expect(lockedHtml).toContain('name="password"');
    expect(lockedHtml).not.toContain("private-name.txt");

    const wrong = await publicAttachmentRoutes.request(protectedPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.201" },
      body: new URLSearchParams({ password: "wrong" }),
    });
    expect(wrong.status).toBe(404);
    expect(await wrong.text()).not.toContain("private-name.txt");

    const oversized = await publicAttachmentRoutes.request(protectedPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.202" },
      body: `password=${"x".repeat(5_000)}`,
    });
    expect(oversized.status).toBe(404);

    const unlocked = await publicAttachmentRoutes.request(protectedPath, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Forwarded-For": "203.0.113.203" },
      body: new URLSearchParams({ password: " secret with spaces " }),
    });
    expect(unlocked.status).toBe(303);
  });
});
