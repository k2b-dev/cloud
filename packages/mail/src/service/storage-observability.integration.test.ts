import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailStorageSummarySchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import { getMailStorageSummary, reconcileMailStorageUsage, requestMailStorageReconciliation } from "./storage-observability";

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
      mail: `${user.uid}@example.com`,
      roles: user.admin ? ["admin", "user"] : ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
      admin: user.admin,
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `storage-observability-${user.uid}`,
});

suite("Mail storage observability", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const blobIds: string[] = [];
  let adminContext: MailRequestContext;
  let userContext: MailRequestContext;
  let mailboxId: string;
  let mailboxShortId: string;

  beforeAll(async () => {
    await migrate();
    const users = await sql<{ id: string; uid: string; admin: boolean }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES
        (${`storage-admin-${suffix}`}, 'local', 'user', 'Storage Admin', true),
        (${`storage-user-${suffix}`}, 'local', 'user', 'Storage User', false)
      RETURNING id, uid, admin
    `;
    const admin = users.find((user) => user.admin);
    const user = users.find((entry) => !entry.admin);
    if (!admin || !user) throw new Error("Failed to create storage users");
    userIds.push(...users.map((entry) => entry.id));
    adminContext = contextFor(admin);
    userContext = contextFor(user);

    const mailbox = await createMailbox(adminContext, { name: `Storage ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxIdentity] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
    `;
    mailboxShortId = mailboxIdentity!.short_id;

    const receivedBlob = await storeReadableBlob(Readable.from([Buffer.alloc(200, 1)]), 200);
    const draftBlob = await storeReadableBlob(Readable.from([Buffer.alloc(300, 2)]), 300);
    blobIds.push(receivedBlob.id, draftBlob.id);
    const [activeUploadBlob] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_count, complete)
      VALUES (${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 400, 0, false)
      RETURNING id
    `;
    blobIds.push(activeUploadBlob!.id);

    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, ${`<storage-${suffix}@example.com>`}, 'Storage fixture', now(), 1000,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete'
      )
      RETURNING id
    `;
    const [part] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status
      ) VALUES (
        ${message!.id}::uuid, '1', 'application/octet-stream', 'attachment', 'received.bin', 200,
        ${receivedBlob.id}::uuid, 'complete'
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
      VALUES (${newShortId()},
        ${message!.id}::uuid, ${part!.id}::uuid, 'received.bin', 'application/octet-stream', 'attachment',
        200, ${receivedBlob.id}::uuid
      )
    `;

    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Storage', 'Storage', ${`storage-${suffix}@example.com`})
      RETURNING id
    `;
    const actorId = adminContext.accessSubject.type === "user" ? adminContext.accessSubject.userId : "";
    const [draft] = await sql<{ id: string }[]>`
      INSERT INTO mail.drafts (short_id,
        mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid, ${identity!.id}::uuid, 'user', ${actorId}::uuid, 'user', ${actorId}::uuid
      )
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
      VALUES (${newShortId()},
        ${draft!.id}::uuid, ${draftBlob.id}::uuid, 'draft.bin', 'application/octet-stream', 300,
        ${draftBlob.contentHash}, 0
      )
    `;
    await sql`
      INSERT INTO mail.draft_attachment_uploads (
        draft_id, blob_id, filename, content_type, byte_length, received_bytes, state, creator_kind, creator_id
      ) VALUES (
        ${draft!.id}::uuid, ${activeUploadBlob!.id}::uuid, 'uploading.bin', 'application/octet-stream', 400, 40,
        'uploading', 'user', ${actorId}::uuid
      )
    `;
    await sql`
      INSERT INTO mail.attachment_links (
        mailbox_id, blob_id, source_kind, source_id, filename, content_type, byte_length,
        token_hash, created_by_actor_kind, created_by_actor_id
      ) VALUES (
        ${mailboxId}::uuid, ${receivedBlob.id}::uuid, 'message', ${message!.id}::uuid, 'received.bin',
        'application/octet-stream', 200, ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")},
        'user', ${actorId}::uuid
      )
    `;
  });

  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
    `;
    await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    if (access.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))`;
    }
    await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  test("reconciles bounded aggregates without double-counting received attachments or public references", async () => {
    const reconciled = await reconcileMailStorageUsage();
    expect(reconciled.mailboxes).toBeGreaterThanOrEqual(1);

    const summary = await getMailStorageSummary(adminContext);
    expect(summary.ok).toBe(true);
    if (!summary.ok) return;
    const mailbox = summary.data.mailboxes.find((entry) => entry.mailboxId === mailboxShortId);
    expect(mailbox).toMatchObject({
      messageCount: 1,
      messageBytes: 1_000,
      receivedAttachmentBytes: 200,
      draftAttachmentBytes: 340,
      externalLinkBytes: 200,
      logicalTotalBytes: 1_340,
    });
    expect(summary.data.physicalBlobBytes).toBeGreaterThanOrEqual(500);
    expect(summary.data.mailboxes.some((entry) => entry.mailboxId === mailboxId)).toBe(false);
    expect(
      mailStorageSummarySchema.safeParse({
        ...summary.data,
        mailboxes: summary.data.mailboxes.map((entry) => ({ ...entry, mailboxId })),
      }).success,
    ).toBe(false);
  });

  test("requires current Cloud Admin access for snapshots and reconciliation requests", async () => {
    expect((await getMailStorageSummary(userContext)).ok).toBe(false);
    expect((await requestMailStorageReconciliation(userContext)).ok).toBe(false);
  });
});
