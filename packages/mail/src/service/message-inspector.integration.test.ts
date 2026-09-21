import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import { inspectMessage, openMessageSource, previewMessageSource } from "./message-inspector";
import { createAttachmentStream } from "./messages";

const suite = suiteFor("database", "nats");

const contextFor = (user: { id: string; uid: string; displayName: string }): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.displayName,
      givenName: user.displayName,
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `mail-inspector-${user.uid}`,
});

suite("mail message inspector", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let messageId = "";
  let folderId = "";
  let missingSourceMessageId = "";
  let sourceBlobId = "";
  let readerAccessId = "";
  let ownerContext: MailRequestContext;
  let readerContext: MailRequestContext;
  let sourceBytes: Buffer;

  beforeAll(async () => {
    await migrate();
    const createUser = async (role: string) => {
      const uid = `mail-inspector-${role}-${suffix}`;
      const displayName = `${role} message inspector`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${displayName}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create ${role} user`);
      userIds.push(row.id);
      return { id: row.id, uid, displayName };
    };
    const owner = await createUser("owner");
    const reader = await createUser("reader");
    ownerContext = contextFor(owner);
    readerContext = contextFor(reader);

    const mailbox = await createMailbox(ownerContext, { name: `Inspector ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const readerAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: reader.id },
      permission: "read",
    });
    if (!readerAccess.ok) throw new Error(readerAccess.error.message);
    readerAccessId = readerAccess.data.id;
    accessIds.push(readerAccessId);

    sourceBytes = Buffer.concat([
      Buffer.from(
        [
          `Message-ID: <inspector-${suffix}@example.test>`,
          "Received: from first.example.test",
          "Received: from second.example.test",
          "Subject: Inspector fixture",
          "\tfolded continuation",
          "Content-Type: multipart/mixed; boundary=missing",
          "",
          "This deliberately malformed MIME source remains byte exact.\r\n",
        ].join("\r\n"),
      ),
      Buffer.alloc(1024 * 1024 + 64 * 1024, 97),
    ]);
    const sourceBlob = await storeReadableBlob(Readable.from([sourceBytes]), sourceBytes.byteLength);
    sourceBlobId = sourceBlob.id;

    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active')
      RETURNING id
    `;
    const [folder] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource!.id}::uuid, ${`inspector-${suffix}`}, 'Inspector Inbox', 'inbox', 'current')
      RETURNING id, short_id
    `;
    folderId = folder!.id;
    const internalDate = new Date("2026-07-23T12:00:00.000Z");
    const [message] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id,
        message_id,
        in_reply_to,
        reference_ids,
        subject,
        internal_date,
        sent_at,
        size_bytes,
        selected_headers,
        mime_structure,
        source_hash,
        source_blob_id,
        protocol_facts,
        content_hash,
        hydration_status,
        hydration_error_code
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<inspector-${suffix}@example.test>`},
        '<parent@example.test>',
        ARRAY['<root@example.test>', '<parent@example.test>']::text[],
        'Inspector fixture',
        ${internalDate},
        ${internalDate},
        ${sourceBytes.byteLength},
        '{}'::jsonb,
        '{}'::jsonb,
        ${sourceBlob.contentHash},
        ${sourceBlob.id}::uuid,
        '{"version":1,"contentType":"multipart/mixed; boundary=missing"}'::jsonb,
        ${"d".repeat(64)},
        'failed',
        'malformed_mime'
      )
      RETURNING id, short_id
    `;
    messageId = message!.id;
    const [remoteRef] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid, modseq)
      VALUES (${folder!.id}::uuid, ${messageId}::uuid, 42, 7, 9)
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (
        ${remoteRef!.id}::uuid,
        ${folder!.id}::uuid,
        ${messageId}::uuid,
        ARRAY['\\Seen']::text[],
        ARRAY['important']::text[]
      )
    `;
    await sql`
      INSERT INTO mail.message_parts (
        message_id, part_path, content_type, charset, transfer_encoding, disposition, size_bytes, hydration_status
      ) VALUES (
        ${messageId}::uuid, 'normalized-plain', 'text/plain', 'utf-8', '8bit', 'inline', 64, 'failed'
      )
    `;
    const [missingSource] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, internal_date, size_bytes, content_hash, hydration_status
      ) VALUES (${newShortId()},
        ${mailboxId}::uuid,
        ${`<missing-source-${suffix}@example.test>`},
        'Missing source',
        ${internalDate},
        12,
        ${"e".repeat(64)},
        'headers'
      )
      RETURNING id
    `;
    missingSourceMessageId = missingSource!.id;
  });

  afterAll(async () => {
    if (mailboxId) {
      const rows = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid
      `;
      accessIds.push(...rows.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (sourceBlobId) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${sourceBlobId}::uuid`;
    if (accessIds.length > 0) {
      await sql`
        DELETE FROM auth.access
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${[...new Set(accessIds)]}::jsonb))
      `;
    }
    if (userIds.length > 0) {
      await sql`
        DELETE FROM auth.users
        WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))
      `;
    }
  });

  test("bounds previews, reports malformed data, preserves exact bytes, and fails closed after revocation", async () => {
    const inspection = await inspectMessage({ context: readerContext, mailboxId, messageId });
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.data.headers.filter((header) => header.name === "Received")).toHaveLength(2);
    expect(inspection.data.headers.find((header) => header.name === "Subject")?.value).toBe("Inspector fixture folded continuation");
    expect(inspection.data.placements).toHaveLength(1);
    expect(inspection.data).toMatchObject({ id: messageId });
    expect(inspection.data.placements[0]).toMatchObject({ folderId });
    expect(inspection.data.placements[0]).not.toHaveProperty("remoteMessageRefId");
    expect(inspection.data.parts).toHaveLength(1);
    expect(inspection.data.parts[0]).not.toHaveProperty("id");
    for (const attachment of inspection.data.attachments) expect(attachment).not.toHaveProperty("partId");
    expect(inspection.data.warnings).toContain("Message hydration failed (malformed_mime).");
    expect(inspection.data.source).toMatchObject({
      available: true,
      exact: true,
      byteLength: sourceBytes.byteLength,
    });

    const preview = await previewMessageSource({ context: readerContext, mailboxId, messageId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.truncated).toBe(true);
    expect(preview.data.messageId).toBe(messageId);
    expect(preview.data.previewByteLength).toBe(256 * 1024);
    expect(preview.data.byteLength).toBe(sourceBytes.byteLength);

    const missingInspection = await inspectMessage({
      context: readerContext,
      mailboxId,
      messageId: missingSourceMessageId,
    });
    expect(missingInspection.ok && missingInspection.data.source.available).toBe(false);
    expect(missingInspection.ok && missingInspection.data.warnings.includes("The exact original message source is unavailable.")).toBe(
      true,
    );
    expect(
      (
        await previewMessageSource({
          context: readerContext,
          mailboxId,
          messageId: missingSourceMessageId,
        })
      ).ok,
    ).toBe(false);

    const opened = await openMessageSource({ context: readerContext, mailboxId, messageId });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.data.messageId).toBe(messageId);
    let accessChecks = 0;
    let releaseNextAccessCheck: (() => void) | undefined;
    const nextAccessCheck = new Promise<void>((resolve) => {
      releaseNextAccessCheck = resolve;
    });
    const stream = createAttachmentStream({
      blobId: opened.data.blobId,
      chunkSize: opened.data.chunkSize,
      chunkCount: opened.data.chunkCount,
      start: 0,
      endExclusive: opened.data.total,
      assertCurrentAccess: async () => {
        accessChecks += 1;
        if (accessChecks > 1) await nextAccessCheck;
        const current = await openMessageSource({ context: readerContext, mailboxId, messageId });
        if (!current.ok || current.data.blobId !== opened.data.blobId) throw new Error("access revoked");
      },
    });
    const streamReader = stream.getReader();
    const first = await streamReader.read();
    expect(first.done).toBe(false);
    expect(first.value?.byteLength).toBe(1024 * 1024);

    const revoked = await revokeMailboxAccess({ context: ownerContext, mailboxId, accessId: readerAccessId });
    expect(revoked.ok).toBe(true);
    releaseNextAccessCheck?.();
    await expect(streamReader.read()).rejects.toThrow("access revoked");
    expect((await inspectMessage({ context: readerContext, mailboxId, messageId })).ok).toBe(false);
    expect((await openMessageSource({ context: readerContext, mailboxId, messageId })).ok).toBe(false);

    const ownerDownload = await openMessageSource({ context: ownerContext, mailboxId, messageId });
    expect(ownerDownload.ok && ownerDownload.data.total).toBe(sourceBytes.byteLength);
    if (!ownerDownload.ok) return;
    const exactBytes = new Uint8Array(
      await new Response(
        createAttachmentStream({
          blobId: ownerDownload.data.blobId,
          chunkSize: ownerDownload.data.chunkSize,
          chunkCount: ownerDownload.data.chunkCount,
          start: 0,
          endExclusive: ownerDownload.data.total,
        }),
      ).arrayBuffer(),
    );
    expect(exactBytes).toEqual(new Uint8Array(sourceBytes));
  });
});
