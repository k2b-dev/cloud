import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { reviewDraftComposeSafety, validateDraftComposeSafety } from "./compose-safety";
import { acquireDraftLease, releaseDraftLease } from "./draft-leases";
import { appendDraftAttachmentUpload, createDraftAttachmentUpload, finalizeDraftAttachmentUpload } from "./draft-uploads";
import { createDraft, updateDraft } from "./drafts";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");

const userContext = (id: string, uid: string, displayName: string, mail: string): MailRequestContext =>
  ({
    actor: {
      kind: "user",
      user: {
        id,
        uid,
        provider: "local",
        profile: "user",
        displayName,
        givenName: displayName,
        sn: "Owner",
        mail,
        roles: ["user"],
        memberofGroupIds: [],
        memberofGroups: [],
      },
    },
    accessSubject: { type: "user", userId: id },
    requestId: `draft-limit-test-${id}`,
  }) as never;

suite("mail draft limits", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const accessIds: string[] = [];
  let mailboxId = "";
  let identityId = "";
  let conversationId = "";
  let messageId = "";
  let owner: MailRequestContext;
  const fillerHash = `${suffix}${"d".repeat(64)}`.slice(0, 64);

  beforeAll(async () => {
    await migrate();
    const [ownerRow] = await sql<{ id: string; uid: string; display_name: string; mail: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`draft-limit-owner-${suffix}`}, 'local', 'user', 'Ada Owner', ${`draft-limit-${suffix}@example.test`})
      RETURNING id, uid, display_name, mail
    `;
    if (!ownerRow) throw new Error("Draft limit test user was not created");
    userIds.push(ownerRow.id);
    owner = userContext(ownerRow.id, ownerRow.uid, ownerRow.display_name, ownerRow.mail);

    const mailbox = await createMailbox(owner, { name: `Draft limits ${suffix}`, description: "Draft limit test" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const granted = await grantMailboxAccess({
      context: owner,
      mailboxId,
      principal: { type: "user", userId: ownerRow.id },
      permission: "write",
    });
    if (granted.ok) accessIds.push(granted.data.id);

    const [identity] = await sql<{ id: string }[]>`
      INSERT INTO mail.sender_identities (
        short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, 'Support', 'Support', 'support@example.com', 'disabled', true, 'verified'
      )
      RETURNING id
    `;
    identityId = identity!.id;
    // An identity that is not verified must never count as one of the mailbox's own addresses.
    await sql`
      INSERT INTO mail.sender_identities (
        short_id, mailbox_id, label, display_name, from_address, automation_policy, is_default, status
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, 'Claimed', 'Claimed', 'customer@example.com', 'disabled', false, 'unverified'
      )
    `;

    const internalDate = new Date(Date.now() - 60 * 60_000);
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (
        short_id, mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes,
        content_hash, hydration_status, plain_text
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${`<draft-limit-${suffix}@example.com>`}, 'Long thread', 'long thread',
        ${internalDate}, 128, ${"c".repeat(64)}, 'complete', 'Original message'
      )
      RETURNING id
    `;
    messageId = message!.id;
    await sql`
      INSERT INTO mail.message_addresses (message_id, role, position, display_name, email, normalized_email)
      VALUES
        (${messageId}::uuid, 'from', 0, 'Customer', 'customer@example.com', 'customer@example.com'),
        (${messageId}::uuid, 'to', 0, 'Support', 'support@example.com', 'support@example.com')
    `;
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Long thread', 'customer@example.com', ${internalDate}, ${internalDate})
      RETURNING id
    `;
    conversationId = conversation!.id;
    await sql`
      INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
      VALUES (${conversationId}::uuid, ${messageId}::uuid, ${internalDate.getTime()}, 'headers')
    `;
  });

  afterAll(async () => {
    if (mailboxId) {
      const rows = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      accessIds.push(...rows.map((row) => row.access_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    const uniqueAccessIds = [...new Set(accessIds)];
    if (uniqueAccessIds.length > 0) {
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${uniqueAccessIds}::jsonb))`;
    }
    if (userIds.length > 0) {
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
    }
    await sql`DELETE FROM mail.message_part_blobs WHERE content_hash = ${fillerHash}`;
  });

  test("keeps a reply editable when the thread carries more references than a MIME message can", async () => {
    const overlongReference = `<${"x".repeat(1_200)}@example.com>`;
    const references = [...Array.from({ length: 600 }, (_, index) => `<thread-${index}@example.com>`), overlongReference];
    await sql`
      UPDATE mail.message_contents
      SET reference_ids = (SELECT array_agg(value) FROM jsonb_array_elements_text(${references}::jsonb))
      WHERE id = ${messageId}::uuid
    `;

    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        conversationId,
        intent: "reply",
        sourceMessageId: messageId,
        senderIdentityId: identityId,
        to: [],
        cc: [],
        bcc: [],
        subject: "Re: Long thread",
        body: "Reply body",
        format: "plain",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    // The unverified identity claiming the sender address must not remove it from the reply.
    expect(draft.data.to).toEqual([{ name: "Customer", address: "customer@example.com" }]);

    const edited = await updateDraft({
      context: owner,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
      input: {
        senderIdentityId: identityId,
        to: draft.data.to,
        cc: [],
        bcc: [],
        subject: "Re: Long thread",
        body: "Edited reply body",
        format: "plain",
      },
    });
    expect(edited.ok && edited.data.body).toBe("Edited reply body");

    const [snapshot] = await sql<{ content_snapshot: { references: string[] } | string }[]>`
      SELECT content_snapshot
      FROM mail.draft_provider_snapshots
      WHERE draft_id = ${draft.data.id}::uuid AND direction = 'export'
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const snapshotContent =
      typeof snapshot!.content_snapshot === "string"
        ? (JSON.parse(snapshot!.content_snapshot) as { references: string[] })
        : snapshot!.content_snapshot;
    expect(snapshotContent.references.length).toBe(500);
    expect(snapshotContent.references).not.toContain(overlongReference);
    expect(snapshotContent.references.at(-1)).toBe(`<draft-limit-${suffix}@example.com>`);
  });

  test("rejects an attachment that would push a draft past the projection and send limits", async () => {
    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        senderIdentityId: identityId,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Attachment limits",
        body: "Body",
        format: "plain",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const [blob] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_size, chunk_count, complete, completed_at)
      VALUES (${fillerHash}, 1, 1048576, 1, true, now())
      RETURNING id
    `;
    const fill = async (count: number, byteLength: number): Promise<void> => {
      const shortIds = Array.from({ length: count }, () => newShortId());
      await sql`
        INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
        SELECT
          entry.short_id, ${draft.data.id}::uuid, ${blob!.id}::uuid, 'filler.bin', 'application/octet-stream',
          ${byteLength}, ${fillerHash}, 1000 + entry.ordinality::int
        FROM jsonb_array_elements_text(${shortIds}::jsonb) WITH ORDINALITY AS entry(short_id, ordinality)
      `;
    };
    const attach = async (revision: number) => {
      const upload = await createDraftAttachmentUpload({
        context: owner,
        mailboxId,
        draftId: draft.data.id,
        input: { filename: "extra.bin", contentType: "application/octet-stream", byteLength: 1 },
      });
      if (!upload.ok) throw new Error(upload.error.message);
      const appended = await appendDraftAttachmentUpload({
        context: owner,
        mailboxId,
        draftId: draft.data.id,
        uploadId: upload.data.id,
        offset: 0,
        bytes: Buffer.alloc(1, 9),
      });
      if (!appended.ok) throw new Error(appended.error.message);
      return finalizeDraftAttachmentUpload({
        context: owner,
        mailboxId,
        draftId: draft.data.id,
        uploadId: upload.data.id,
        expectedRevision: revision,
      });
    };

    await fill(200, 1);
    const beyondCount = await attach(draft.data.revision);
    expect(beyondCount.ok).toBe(false);
    if (!beyondCount.ok) {
      expect(beyondCount.error.status).toBe(400);
      expect(beyondCount.error.message).toContain("200 attachments");
    }
    await sql`DELETE FROM mail.draft_attachments WHERE draft_id = ${draft.data.id}::uuid`;

    await fill(2, 60 * 1024 * 1024);
    const beyondBytes = await attach(draft.data.revision);
    expect(beyondBytes.ok).toBe(false);
    if (!beyondBytes.ok) {
      expect(beyondBytes.error.status).toBe(400);
      expect(beyondBytes.error.message).toContain("100 MiB");
    }
  });

  test("keeps the original case of default carbon-copy recipients", async () => {
    await sql`
      UPDATE mail.sender_identities
      SET default_cc = ${[{ name: "Ops", address: "Ops@Example.com" }]}::jsonb
      WHERE id = ${identityId}::uuid
    `;
    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        senderIdentityId: identityId,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Default carbon copy",
        body: "Body",
        format: "plain",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.data.cc).toEqual([{ name: "Ops", address: "Ops@Example.com" }]);
  });

  test("lets only the current lease holder change a shared draft", async () => {
    const [collaboratorRow] = await sql<{ id: string; uid: string; display_name: string; mail: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`draft-lease-mate-${suffix}`}, 'local', 'user', 'Bea Mate', ${`draft-lease-mate-${suffix}@example.test`})
      RETURNING id, uid, display_name, mail
    `;
    if (!collaboratorRow) throw new Error("Draft lease test collaborator was not created");
    userIds.push(collaboratorRow.id);
    const collaborator = userContext(collaboratorRow.id, collaboratorRow.uid, collaboratorRow.display_name, collaboratorRow.mail);
    const granted = await grantMailboxAccess({
      context: owner,
      mailboxId,
      principal: { type: "user", userId: collaboratorRow.id },
      permission: "write",
    });
    if (granted.ok) accessIds.push(granted.data.id);

    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        senderIdentityId: identityId,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Shared draft",
        body: "Body",
        format: "plain",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    const content = {
      senderIdentityId: identityId,
      to: draft.data.to,
      cc: [],
      bcc: [],
      subject: "Shared draft",
      format: "plain" as const,
    };

    const lease = await acquireDraftLease({ context: owner, mailboxId, draftId: draft.data.id });
    expect(lease.ok).toBe(true);
    if (!lease.ok) return;

    const blocked = await updateDraft({
      context: collaborator,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
      input: { ...content, body: "Collaborator body" },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe("DRAFT_LEASE_HELD");
      expect(blocked.error.status).toBe(409);
      expect(blocked.error.message).toContain("Ada Owner");
    }
    const [copies] = await sql<{ count: string | number }[]>`
      SELECT count(*) AS count FROM mail.draft_recovery_copies WHERE draft_id = ${draft.data.id}::uuid
    `;
    expect(Number(copies!.count)).toBe(0);

    const holderSave = await updateDraft({
      context: owner,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
      input: { ...content, body: "Holder body" },
    });
    expect(holderSave.ok && holderSave.data.body).toBe("Holder body");
    if (!holderSave.ok) return;

    const released = await releaseDraftLease({ context: owner, mailboxId, draftId: draft.data.id, token: lease.data.token });
    expect(released.ok).toBe(true);

    const afterRelease = await updateDraft({
      context: collaborator,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: holderSave.data.revision,
      input: { ...content, body: "Collaborator body" },
    });
    expect(afterRelease.ok && afterRelease.data.body).toBe("Collaborator body");
  });

  test("refuses an unapproved send when template text would leave the mailbox verbatim", async () => {
    const draft = await createDraft({
      context: owner,
      mailboxId,
      input: {
        senderIdentityId: identityId,
        to: [{ name: "Customer", address: "customer@example.com" }],
        cc: [],
        bcc: [],
        subject: "Externally edited",
        body: "Regards\n{{ sender.email }}",
        format: "plain",
      },
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    const unapproved = await validateDraftComposeSafety({
      db: sql,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
    });
    expect(unapproved.ok).toBe(false);
    if (!unapproved.ok) expect(unapproved.error.status).toBe(409);

    const review = await reviewDraftComposeSafety({
      context: owner,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
    });
    expect(review.ok).toBe(true);
    if (!review.ok) return;
    expect(review.data.warnings.map((warning) => warning.id)).toContain("unrendered_template");

    const approved = await validateDraftComposeSafety({
      db: sql,
      mailboxId,
      draftId: draft.data.id,
      expectedRevision: draft.data.revision,
      approval: {
        revision: review.data.revision,
        fingerprint: review.data.fingerprint,
        warningIds: review.data.warnings.map((warning) => warning.id),
      },
    });
    expect(approved.ok).toBe(true);
  });
});
