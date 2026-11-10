import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { captureTableAction, fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { findTables, gridLine, inspectTableStructure } from "@k2b/ui/text-editor/model";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { prepareDraftSendBinding } from "../../test/fixtures/draft-send";
import { draftContentInputSchema } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as access from "./access";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { createActorCommand } from "./commands";
import { reviewDraftComposeSafety } from "./compose-safety";
import * as revisionBase from "./draft-document-revision";
import * as documentService from "./draft-documents";
import { acceptDraftDocumentUpdate, lockDraftDocumentInTransaction, mailDraftDocumentLog, readDraftDocument } from "./draft-documents";
import { draftProviderContentSchema } from "./draft-provider-mime";
import { queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { applyDraftTableAction } from "./draft-table-actions";
import {
  createDeliveryRecoveryDraft,
  createDraft,
  createWorkflowDraftInTransaction,
  deriveDraftFromMessage,
  discardDraft,
  getDraft,
  listDraftFolder,
  materializeDraftSeed,
  persistDraftDocument,
  prepareDraftSeed,
  recoverDraftDocumentRest,
  removeDraftAttachment,
  restoreDraftRecoveryCopy,
  updateDraft,
} from "./drafts";
import { createMailbox, getMailbox, updateMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
import { cancelScheduledSend } from "./scheduled-sends";
import { loadSendContent } from "./send-content";

const suite = suiteFor("database", "nats");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const table = "| A | B |\n| --- | --- |\n| one | two |";
suite("Mail document lifecycle boundaries", () => {
  const extraUsers: string[] = [];
  const blobs: string[] = [];
  let context: MailRequestContext;
  let userId: string;
  let mailboxId: string;
  let senderId: string;
  let senderShortId: string;
  let otherWriter: MailRequestContext;
  beforeAll(async () => {
    await migrate();
    const suffix = newShortId();
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`draft-life-${suffix}`}, 'local', 'user', 'Draft Writer', ${`${suffix}@example.test`}) RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid: `draft-life-${suffix}`,
          provider: "local",
          profile: "user",
          roles: ["user"],
          displayName: "Draft Writer",
          givenname: "Draft",
          sn: "Writer",
          mail: `${suffix}@example.test`,
          avatarHash: null,
          accountExpires: null,
          lastLoginLocal: null,
          ipa: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId },
    };
    mailboxId = value(await createMailbox(context, { name: `Draft lifecycle ${suffix}`, description: "Fictional fixture" })).id;
    const [sender] = await sql<{ id: string; short_id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Writer', 'Writer', 'writer@example.test', 'disabled', 'verified') RETURNING id, short_id`;
    if (!sender) throw new Error("Missing fixture sender");
    senderId = sender.id;
    senderShortId = sender.short_id;
    await prepareDraftSendBinding(mailboxId, senderId);
    const [other] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${`draft-life-other-${suffix}`}, 'local', 'user', 'Other Writer', ${`other-${suffix}@example.test`}) RETURNING id`;
    if (!other || context.actor.kind !== "user") throw new Error("Missing other writer");
    extraUsers.push(other.id);
    otherWriter = {
      actor: { kind: "user", user: { ...context.actor.user, id: other.id, uid: `draft-life-other-${suffix}` } },
      accessSubject: { type: "user", userId: other.id },
    };
    value(await access.grantMailboxAccess({ context, mailboxId, principal: otherWriter.accessSubject, permission: "write" }));
  });
  afterAll(async () => {
    if (mailboxId) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      for (const row of grants) await sql`DELETE FROM auth.access WHERE id = ${row.access_id}::uuid`;
    }
    for (const id of blobs) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${id}::uuid`;
    for (const id of extraUsers) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  const draft = async (body = table) => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, sender_identity_id, author_kind, author_id, last_editor_kind, last_editor_id, subject, body_markdown, edit_mode, to_addresses)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${senderId}::uuid, 'user', ${userId}::uuid, 'user', ${userId}::uuid, 'Shared draft', ${body}, 'shared', ${[{ address: "recipient@example.test" }]}::jsonb) RETURNING id`;
    if (!row) throw new Error("Missing fixture draft");
    return { context, mailboxId, draftId: row.id };
  };
  const freeze = async (target: Awaited<ReturnType<typeof draft>>) =>
    sql.begin(async (db) => {
      const handle = value(await lockDraftDocumentInTransaction({ ...target, db }));
      const frozen = value(await handle.freeze({ generation: handle.generation }));
      await db`INSERT INTO mail.draft_document_freezes (draft_id,generation,revision,cursor,state)
      VALUES (${target.draftId}::uuid,${frozen.generation}::bigint,${frozen.revision},${frozen.cursor},${Buffer.from(frozen.state)})`;
      await db`UPDATE mail.drafts SET state='scheduled' WHERE id=${target.draftId}::uuid`;
      return frozen;
    });

  const review = async (target: Awaited<ReturnType<typeof draft>>) => {
    const current = value(await readDraftDocument(target));
    return value(await reviewDraftComposeSafety({ ...target, expectedRevision: current.revision }));
  };
  const send = (target: Awaited<ReturnType<typeof draft>>, checked: Awaited<ReturnType<typeof review>>, revision = checked.revision) =>
    createActorCommand({
      context: target.context,
      mailboxId,
      input: {
        kind: "send",
        draftId: target.draftId,
        senderIdentityId: senderId,
        expectedDraftRevision: revision,
        expectedContentHash: checked.contentHash,
        undoSeconds: 60,
        idempotencyKey: crypto.randomUUID(),
        safetyApproval: { revision: checked.revision, fingerprint: checked.fingerprint, warningIds: checked.warnings.map((w) => w.id) },
      },
    });
  const nothingQueued = async (draftId: string) => {
    expect(await sql`SELECT 1 FROM mail.commands WHERE target->>'draftId' = ${draftId}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM mail.outbox_submissions WHERE draft_id = ${draftId}::uuid`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM mail.draft_document_freezes WHERE draft_id = ${draftId}::uuid`).toHaveLength(0);
  };

  test("only an admin can select shared editing, and the retention gate refuses activation without changing settings", async () => {
    expect(value(await getMailbox(context, mailboxId)).draftEditMode).toBe("lock");
    expect(await updateMailbox({ context: otherWriter, mailboxId, draftEditMode: "shared" })).toMatchObject({
      ok: false,
      error: { status: 403 },
    });
    expect(await documentService.sharedDraftsSupported()).toBe(false);
    expect(await updateMailbox({ context, mailboxId, draftEditMode: "shared", name: "Must roll back" })).toMatchObject({
      ok: false,
      error: { status: 409, code: "SHARED_DRAFTS_UNSUPPORTED" },
    });
    expect(value(await getMailbox(context, mailboxId))).toMatchObject({ draftEditMode: "lock" });
    expect(value(await getMailbox(context, mailboxId)).name).not.toBe("Must roll back");
  });

  test("creation and seed materialization read the setting; rollback changes only new drafts and preserves retries", async () => {
    const publicInput = draftContentInputSchema.parse({
      senderIdentityId: senderShortId,
      to: [{ address: "recipient@example.test" }],
      body: "Created body",
    });
    // The transport validates short IDs; the service receives resolved internal IDs.
    const input = { ...publicInput, senderIdentityId: senderId };
    const locked = value(await createDraft({ context, mailboxId, input }));
    expect(locked.editMode).toBe("lock");
    const seed = value(await prepareDraftSeed({ context, mailboxId, origin: { kind: "compose", input } }));
    const supported = spyOn(documentService, "sharedDraftsSupported").mockResolvedValue(true);
    try {
      expect(value(await updateMailbox({ context, mailboxId, draftEditMode: "shared" })).draftEditMode).toBe("shared");
      expect(
        await sql`SELECT 1 FROM audit.events WHERE action='mail.mailbox.update'
        AND target_id=${mailboxId} AND metadata->'changed' ? 'draftEditMode'`,
      ).not.toHaveLength(0);
      const shared = value(await createDraft({ context, mailboxId, input }));
      expect(shared.editMode).toBe("shared");
      const materialization = { context, mailboxId, input: { idempotencyKey: seed.id, origin: seed.origin, draft: seed.content } };
      const materialized = value(await materializeDraftSeed(materialization));
      expect(materialized.editMode).toBe("shared");
      expect(value(await getDraft(context, mailboxId, locked.id)).editMode).toBe("lock");
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
      expect(value(await createDraft({ context, mailboxId, input })).editMode).toBe("lock");
      expect(value(await materializeDraftSeed(materialization))).toMatchObject({ id: materialized.id, editMode: "shared" });
      const target = { context, mailboxId, draftId: shared.id };
      const base = value(await readDraftDocument(target));
      const local = new Y.Doc();
      try {
        Y.applyUpdate(local, base.durable.state);
        local.getText("codemirror").insert(0, "After rollback ");
        expect(
          value(
            await acceptDraftDocumentUpdate({
              ...target,
              generation: base.generation,
              baseCursor: base.durable.cursor,
              update: Y.encodeStateAsUpdate(local),
            }),
          ).status,
        ).toBe("accepted");
        expect(value(await persistDraftDocument({ ...target, generation: base.generation })).durable.content.body).toBe(
          "After rollback Created body",
        );
      } finally {
        local.destroy();
      }
    } finally {
      supported.mockRestore();
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
    }
  });

  test("derived user drafts inherit shared while workflow authors retain lock editing", async () => {
    const supported = spyOn(documentService, "sharedDraftsSupported").mockResolvedValue(true);
    try {
      value(await updateMailbox({ context, mailboxId, draftEditMode: "shared" }));
      const [source] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
        (short_id, mailbox_id, message_id, subject, plain_text, hydration_status, internal_date, content_hash)
        VALUES (${newShortId()}, ${mailboxId}::uuid, '<shared-source@example.test>', 'Source', 'Original source', 'complete',
          '2026-01-01T00:00:00Z', ${"b".repeat(64)}) RETURNING id`;
      if (!source) throw new Error("Missing derivation source");
      const derived = value(
        await deriveDraftFromMessage({
          context,
          mailboxId,
          messageId: source.id,
          input: { kind: "edit_as_new", senderIdentityId: senderId, includeAttachments: false, idempotencyKey: crypto.randomUUID() },
        }),
      );
      expect(derived.editMode).toBe("shared");
      await sql`UPDATE mail.sender_identities SET automation_policy='mailbox' WHERE id=${senderId}::uuid`;
      const workflow = value(
        await sql.begin((db) =>
          createWorkflowDraftInTransaction({
            db,
            mailboxId,
            senderIdentityId: senderId,
            workflowVersionId: crypto.randomUUID(),
            draftId: crypto.randomUUID(),
            to: [{ address: "recipient@example.test" }],
            cc: [],
            bcc: [],
            subject: "Workflow",
            body: "Workflow body",
            format: "plain",
          }),
        ),
      );
      expect(value(await getDraft(context, mailboxId, workflow.id)).editMode).toBe("lock");
    } finally {
      supported.mockRestore();
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
      await sql`UPDATE mail.sender_identities SET automation_policy='disabled' WHERE id=${senderId}::uuid`;
    }
  });

  test("delivery recovery inherits the setting when materialized and keeps that mode on idempotent retry after rollback", async () => {
    const target = await draft("Ambiguous delivery");
    const command = value(await send(target, await review(target)));
    const [outbox] = await sql<{ id: string }[]>`SELECT id FROM mail.outbox_submissions WHERE command_id=${command.id}::uuid`;
    if (!outbox) throw new Error("Missing ambiguous delivery");
    await sql`UPDATE mail.outbox_submissions SET state='unknown', last_error_code='AMBIGUOUS_SMTP_OUTCOME' WHERE id=${outbox.id}::uuid`;
    const supported = spyOn(documentService, "sharedDraftsSupported").mockResolvedValue(true);
    try {
      value(await updateMailbox({ context, mailboxId, draftEditMode: "shared" }));
      const request = {
        context,
        mailboxId,
        deliveryId: outbox.id,
        input: { recipientMode: "all" as const, includeAttachments: false, idempotencyKey: crypto.randomUUID() },
      };
      const recovered = value(await createDeliveryRecoveryDraft(request));
      expect(recovered).toMatchObject({ body: "Ambiguous delivery", editMode: "shared", state: "draft" });
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
      expect(value(await createDeliveryRecoveryDraft(request))).toMatchObject({ id: recovered.id, editMode: "shared" });
    } finally {
      supported.mockRestore();
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
    }
  });

  test("two editors in the same second cannot send a previously reviewed body, even with the current revision", async () => {
    const target = await draft("Base");
    const checked = await review(target);
    const base = value(await readDraftDocument(target));
    const editors = [new Y.Doc(), new Y.Doc()];
    try {
      for (const [index, editor] of editors.entries()) {
        editor.clientID = 100 + index;
        Y.applyUpdate(editor, base.durable.state);
      }
      const clock = spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T12:00:00Z"));
      try {
        editors[0]!.getText("codemirror").insert(0, "A ");
        editors[1]!.getText("codemirror").insert(4, " B");
      } finally {
        clock.mockRestore();
      }
      for (const editor of editors) {
        expect(
          value(
            await acceptDraftDocumentUpdate({
              ...target,
              generation: base.generation,
              baseCursor: base.durable.cursor,
              update: Y.encodeStateAsUpdate(editor),
            }),
          ).status,
        ).toBe("accepted");
      }
      const current = value(await readDraftDocument(target));
      expect(current.durable.content.body).toBe("A Base B");
      expect(await send(target, checked, current.revision)).toMatchObject({
        ok: false,
        error: { code: "SEND_CONTENT_CHANGED", status: 409 },
      });
      expect(await send(target, checked)).toMatchObject({ ok: false, error: { code: "CONFLICT", status: 409 } });
      await nothingQueued(target.draftId);
    } finally {
      for (const editor of editors) editor.destroy();
    }
  });

  test.each(["headers", "attachment"] as const)("a concurrent %s change invalidates the reviewed send content", async (change) => {
    const target = await draft("Reviewed body");
    let attachmentId: string | null = null;
    if (change === "attachment") {
      const blob = await storeReadableBlob(Readable.from([Buffer.from("Concurrent attachment fixture")]));
      blobs.push(blob.id);
      const [attachment] = await sql<{ id: string }[]>`INSERT INTO mail.draft_attachments
        (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
        VALUES (${newShortId()}, ${target.draftId}::uuid, ${blob.id}::uuid, 'review.txt', 'text/plain', ${blob.byteLength}, ${blob.contentHash}, 0)
        RETURNING id`;
      if (!attachment) throw new Error("Missing review attachment");
      attachmentId = attachment.id;
    }
    const checked = await review(target);
    const base = value(await readDraftDocument(target));
    if (attachmentId) {
      value(await removeDraftAttachment({ ...target, context: otherWriter, attachmentId, expectedRevision: base.revision }));
    } else {
      value(
        await updateDraft({
          ...target,
          context: otherWriter,
          expectedRevision: base.revision,
          input: {
            ...base.durable.content,
            senderIdentityId: senderId,
            subject: "Changed subject",
            to: [{ address: "changed@example.test" }],
          },
        }),
      );
    }
    const current = value(await readDraftDocument(target));
    expect(await send(target, checked, current.revision)).toMatchObject({
      ok: false,
      error: { code: "SEND_CONTENT_CHANGED", status: 409 },
    });
    await nothingQueued(target.draftId);
  });

  test("published input with failed projection cannot send the old durable state", async () => {
    const target = await draft("Durable");
    const checked = await review(target);
    const base = value(await readDraftDocument(target));
    const editor = new Y.Doc();
    editor.clientID = 104;
    try {
      Y.applyUpdate(editor, base.durable.state);
      editor.getText("codemirror").insert(0, "Unprojected ");
      const update = Y.encodeStateAsUpdate(editor);
      const admitted = await sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ ...target, db }));
        const projection = spyOn(locked.store, "save").mockRejectedValueOnce(new Error("Fixture projection failure"));
        try {
          return value(await locked.accept({ generation: base.generation, baseCursor: base.durable.cursor, update }));
        } finally {
          projection.mockRestore();
        }
      });
      expect(admitted.status).toBe("pendingPersistence");
      const unprojected = value(await readDraftDocument(target));
      expect(unprojected.fresh.content.body).toBe("Unprojected Durable");
      expect(unprojected.fresh.cursor).toBe(admitted.status === "pendingPersistence" ? admitted.cursor : null);
      expect(unprojected.durable.cursor).toBe(base.durable.cursor);
      expect(unprojected.revision).toBe(base.revision);
      expect(await send(target, checked)).toMatchObject({ ok: false, error: { code: "SEND_CONTENT_CHANGED", status: 409 } });
      await nothingQueued(target.draftId);
      expect(value(await readDraftDocument(target)).durable.content.body).toBe("Durable");
    } finally {
      editor.destroy();
    }
  });

  test("B can undo A's mailbox-wide send after rollback; old-generation input recovers without entering the send snapshot", async () => {
    const target = await draft("Reviewed");
    const base = value(await readDraftDocument(target));
    const checked = await review(target);
    const local = new Y.Doc();
    const supported = spyOn(documentService, "sharedDraftsSupported").mockResolvedValue(true);
    try {
      value(await updateMailbox({ context, mailboxId, draftEditMode: "shared" }));
      Y.applyUpdate(local, base.durable.state);
      local.getText("codemirror").insert(8, " offline");
      const command = value(await send(target, checked));
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
      const [submission] = await sql<{ id: string }[]>`SELECT id FROM mail.outbox_submissions WHERE command_id=${command.id}::uuid`;
      if (!submission) throw new Error("Missing undo submission");
      const cancelled = value(
        await cancelScheduledSend({ context: otherWriter, mailboxId, scheduledSendId: submission.id, input: { disposition: "draft" } }),
      );
      expect(cancelled.draftId).toBe(target.draftId);
      const reopened = value(await readDraftDocument({ ...target, context: otherWriter }));
      expect(BigInt(reopened.generation)).toBe(BigInt(base.generation) + 1n);
      expect(reopened.durable.content.body).toBe("Reviewed");
      expect(value(await getDraft(context, mailboxId, target.draftId)).editMode).toBe("shared");
      const oldInput = { ...target, generation: base.generation, baseCursor: base.durable.cursor, update: Y.encodeStateAsUpdate(local) };
      expect((await acceptDraftDocumentUpdate(oldInput)).ok).toBe(false);
      const request = { ...target, generation: base.generation, clientId: crypto.randomUUID(), state: oldInput.update };
      const recovered = value(await recoverDraftDocumentRest(request));
      expect(recovered.status).toBe("recovered");
      if (recovered.status !== "recovered") throw new Error("Missing offline recovery draft");
      expect(recovered.draft).toMatchObject({ body: "Reviewed offline", editMode: "lock", state: "draft" });
      expect(value(await recoverDraftDocumentRest(request))).toEqual(recovered);
      const [outbox] = await sql<{ state: string; draft_snapshot: { body: string } }[]>`
        SELECT state, draft_snapshot FROM mail.outbox_submissions WHERE command_id=${command.id}::uuid`;
      expect(outbox?.state).toBe("cancelled");
      expect(outbox?.draft_snapshot.body).toBe("Reviewed");
      expect(await sql`SELECT 1 FROM mail.outbox_submissions WHERE draft_id=${recovered.draft.id}::uuid`).toHaveLength(0);
      expect(
        await sql`SELECT 1 FROM mail.draft_document_freezes WHERE draft_id=${target.draftId}::uuid AND generation=${base.generation}::bigint`,
      ).toHaveLength(1);
    } finally {
      local.destroy();
      supported.mockRestore();
      value(await updateMailbox({ context, mailboxId, draftEditMode: "lock" }));
    }
  });

  test("the Drafts folder lists what its rows need to delete a draft, and a scheduled draft stays out and cannot be discarded", async () => {
    const listed = await draft("Folder body");
    const blob = await storeReadableBlob(Readable.from([Buffer.from("Folder fixture attachment")]));
    blobs.push(blob.id);
    await sql`INSERT INTO mail.draft_attachments
      (short_id,draft_id,blob_id,filename,content_type,byte_length,content_hash,position)
      VALUES (${newShortId()},${listed.draftId}::uuid,${blob.id}::uuid,'folder.txt','text/plain',${blob.byteLength},${blob.contentHash},0)`;
    const scheduled = await draft("Scheduled body");
    await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${scheduled.draftId}::uuid`;
    const current = value(await getDraft(context, mailboxId, listed.draftId));
    const page = value(await listDraftFolder({ context, mailboxId }));
    expect(page.items.find((item) => item.id === listed.draftId)).toMatchObject({ revision: current.revision, attachmentCount: 1 });
    expect(page.items.some((item) => item.id === scheduled.draftId)).toBe(false);
    // Waiting for delivery: the list never offers it, and the delete path refuses it even with its current revision.
    const waitingState = async () =>
      (await sql<{ revision: string; state: string }[]>`SELECT revision, state FROM mail.drafts WHERE id = ${scheduled.draftId}::uuid`)[0]!;
    const refused = await discardDraft({ ...scheduled, expectedRevision: Number((await waitingState()).revision) });
    expect(refused.ok).toBe(false);
    expect((await waitingState()).state).toBe("scheduled");
    // A list row deletes the revision it shows; a stale one is refused and the draft stays.
    const stale = await discardDraft({ ...listed, expectedRevision: current.revision + 1 });
    expect(stale.ok ? null : stale.error.code).toBe("CONFLICT");
    expect(value(await discardDraft({ ...listed, expectedRevision: current.revision })).state).toBe("discarded");
    expect(value(await listDraftFolder({ context, mailboxId })).items.some((item) => item.id === listed.draftId)).toBe(false);
  });

  test("send marker excludes later input; Rest retains the device's whole deletion and is idempotent", async () => {
    const target = await draft("Old body");
    const base = value(await readDraftDocument(target));
    const frozen = await freeze(target);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base.durable.state);
      doc.getText("codemirror").delete(0, "Old body".length);
      const state = Y.encodeStateAsUpdate(doc);
      expect(
        (await acceptDraftDocumentUpdate({ ...target, generation: base.generation, baseCursor: base.durable.cursor, update: state })).ok,
      ).toBe(false);
      const request = { ...target, generation: frozen.generation, clientId: crypto.randomUUID(), state };
      const first = value(await recoverDraftDocumentRest(request));
      const second = value(await recoverDraftDocumentRest(request));
      expect(first.status).toBe("recovered");
      expect(second).toEqual(first);
      if (first.status !== "recovered") throw new Error("Expected Rest draft");
      expect(first.draft.body).toBe("");
      expect(first.draft.subject).toBe("Shared draft");
      doc.getText("codemirror").insert(0, "Different request");
      expect((await recoverDraftDocumentRest({ ...request, state: Y.encodeStateAsUpdate(doc) })).ok).toBe(false);
      expect(value(await recoverDraftDocumentRest({ ...request, clientId: crypto.randomUUID(), state: frozen.state })).status).toBe(
        "unchanged",
      );
    } finally {
      doc.destroy();
    }
  });

  test("unchanged Rest durably covers a device's type-then-delete identities", async () => {
    const target = await draft("Unchanged body");
    const base = value(await readDraftDocument(target));
    const frozen = await freeze(target);
    const local = new Y.Doc();
    try {
      Y.applyUpdate(local, base.durable.state);
      local.getText("codemirror").insert(0, "temporary");
      local.getText("codemirror").delete(0, "temporary".length);
      const state = Y.encodeStateAsUpdate(local);
      const request = { ...target, generation: frozen.generation, clientId: crypto.randomUUID(), state };
      const first = value(await recoverDraftDocumentRest(request));
      expect(first.status).toBe("unchanged");
      const durable = new Y.Doc();
      try {
        Y.applyUpdate(durable, first.durableSourceState);
        expect(Y.snapshotContainsUpdate(Y.snapshot(durable), state)).toBe(true);
      } finally {
        durable.destroy();
      }
      const [receipt] = await sql<{ rest_draft_id: string | null; source_state: Uint8Array }[]>`
        SELECT rest_draft_id,source_state FROM mail.draft_document_rests
        WHERE source_draft_id=${target.draftId}::uuid AND client_id=${request.clientId}::uuid
      `;
      expect(receipt?.rest_draft_id).toBeNull();
      expect(Buffer.from(receipt!.source_state)).toEqual(Buffer.from(state));
      expect(value(await recoverDraftDocumentRest(request))).toEqual(first);
    } finally {
      local.destroy();
    }
  });

  test("peer discard without a send marker preserves offline text as an idempotent new draft", async () => {
    const target = await draft("Before discard");
    const base = value(await readDraftDocument(target));
    value(await discardDraft({ ...target, expectedRevision: base.revision }));
    expect(await sql`SELECT 1 FROM mail.draft_document_freezes WHERE draft_id=${target.draftId}::uuid`).toHaveLength(0);
    const local = new Y.Doc();
    try {
      Y.applyUpdate(local, base.durable.state);
      local.getText("codemirror").insert(0, "Offline ");
      const request = { ...target, generation: base.generation, clientId: crypto.randomUUID(), state: Y.encodeStateAsUpdate(local) };
      const recovered = value(await recoverDraftDocumentRest(request));
      expect(recovered.status).toBe("recovered");
      if (recovered.status !== "recovered") throw new Error("Expected recovery draft");
      expect(recovered.draft.body).toBe("Offline Before discard");
      expect(value(await recoverDraftDocumentRest(request))).toEqual(recovered);
      const unchanged = value(await recoverDraftDocumentRest({ ...request, clientId: crypto.randomUUID(), state: base.durable.state }));
      expect(unchanged.status).toBe("recovered");
      expect(
        (await recoverDraftDocumentRest({ ...request, generation: String(BigInt(base.generation) + 1n), clientId: crypto.randomUUID() }))
          .ok,
      ).toBe(false);
    } finally {
      local.destroy();
    }
  });

  test("typing coalesces obsolete unsent exports and retains possible remote effects", async () => {
    const target = await draft("First");
    value(await readDraftDocument(target));
    const original = await sql.begin((db) => queueDraftProjectionInTransaction({ db, draftId: target.draftId }));
    expect(original).not.toBeNull();
    await sql`UPDATE mail.draft_provider_snapshots SET state='appending',attempt=1,provider_effect_started_at=now() WHERE id=${original}::uuid`;
    for (let index = 0; index < 10; index++) {
      // Provider preflight failures must not accumulate old full bodies either.
      await sql`UPDATE mail.draft_provider_snapshots SET state='needs_attention'
        WHERE draft_id=${target.draftId}::uuid AND state='prepared'`;
      await sql.begin(async (db) => {
        await db`UPDATE mail.drafts SET revision=revision+1,body_markdown=${`Input ${index}`} WHERE id=${target.draftId}::uuid`;
        await queueDraftProjectionInTransaction({ db, draftId: target.draftId });
      });
    }
    const rows = await sql<
      { id: string; state: string; attempt: number; provider_effect_started_at: Date | null; content_snapshot: unknown }[]
    >`SELECT id,state,attempt,provider_effect_started_at,content_snapshot FROM mail.draft_provider_snapshots
      WHERE draft_id=${target.draftId}::uuid AND direction='export' ORDER BY cloud_revision`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: original, state: "appending", attempt: 1 });
    expect(rows[0]?.provider_effect_started_at).toBeInstanceOf(Date);
    expect(rows[1]?.state).toBe("prepared");
    expect(draftProviderContentSchema.parse(rows[1]?.content_snapshot).body).toBe("Input 9");
  });

  test.each([true, false])("recovery exports the final attachment set (replacement=%s)", async (replace) => {
    const target = await draft("Before recovery");
    const oldBlob = await storeReadableBlob(Readable.from([Buffer.from("Old fixture attachment")]));
    blobs.push(oldBlob.id);
    await sql`INSERT INTO mail.draft_attachments
      (short_id,draft_id,blob_id,filename,content_type,byte_length,content_hash,position)
      VALUES (${newShortId()},${target.draftId}::uuid,${oldBlob.id}::uuid,'old.txt','text/plain',${oldBlob.byteLength},${oldBlob.contentHash},0)`;
    const base = value(await readDraftDocument(target));
    const content = { ...base.durable.content, senderIdentityId: senderId, body: "Recovered body" };
    const [copy] = await sql<{ id: string }[]>`INSERT INTO mail.draft_recovery_copies
      (draft_id,base_revision,content,content_hash,creator_kind,creator_id,has_attachment_snapshot)
      VALUES (${target.draftId}::uuid,${base.revision},${content}::jsonb,${sha256Json(content)},'user',${userId}::uuid,true) RETURNING id`;
    if (!copy) throw new Error("Missing recovery fixture");
    const expectedBlobs: string[] = [];
    if (replace) {
      const replacement = await storeReadableBlob(Readable.from([Buffer.from("Replacement fixture attachment")]));
      blobs.push(replacement.id);
      expectedBlobs.push(replacement.id);
      await sql`INSERT INTO mail.draft_recovery_attachments
        (recovery_copy_id,blob_id,filename,content_type,byte_length,content_hash,position)
        VALUES (${copy.id}::uuid,${replacement.id}::uuid,'replacement.txt','text/plain',${replacement.byteLength},${replacement.contentHash},0)`;
    }
    // Fail after the text publication and attachment writes. SQL must keep
    // the copy and old attachment set available for the exact retry.
    const record = spyOn(revisionBase, "recordDraftDocumentRevision").mockRejectedValueOnce(new Error("Fixture attachment rollback"));
    try {
      expect((await restoreDraftRecoveryCopy({ ...target, recoveryCopyId: copy.id, expectedRevision: base.revision })).ok).toBe(false);
    } finally {
      record.mockRestore();
    }
    const [pending] = await sql<
      { restored_at: Date | null }[]
    >`SELECT restored_at FROM mail.draft_recovery_copies WHERE id=${copy.id}::uuid`;
    expect(pending?.restored_at).toBeNull();
    const originalAttachments = await sql<{ blob_id: string }[]>`SELECT blob_id FROM mail.draft_attachments
      WHERE draft_id=${target.draftId}::uuid AND removed_at IS NULL`;
    expect(originalAttachments.map((item) => item.blob_id)).toEqual([oldBlob.id]);
    const restored = value(await restoreDraftRecoveryCopy({ ...target, recoveryCopyId: copy.id, expectedRevision: base.revision }));
    expect(restored.body).toBe("Recovered body");
    const [snapshot] = await sql<{ content_snapshot: unknown }[]>`SELECT content_snapshot FROM mail.draft_provider_snapshots
      WHERE draft_id=${target.draftId}::uuid AND cloud_revision=${restored.revision} AND direction='export'`;
    const projected = draftProviderContentSchema.parse(snapshot?.content_snapshot);
    expect(projected.body).toBe(restored.body);
    expect(projected.attachments.map((item) => item.blobId)).toEqual(expectedBlobs);
    const attachments = await sql<{ id: string }[]>`SELECT id FROM mail.draft_attachments
      WHERE draft_id=${target.draftId}::uuid AND removed_at IS NULL ORDER BY position,id`;
    expect(projected.attachments.map((item) => item.id)).toEqual(attachments.map((item) => item.id));
  });

  test("snapshot requests cannot acknowledge another generation", async () => {
    const target = await draft();
    const base = value(await readDraftDocument(target));
    expect((await persistDraftDocument({ ...target, generation: "2" })).ok).toBe(false);
    const saved = value(await persistDraftDocument({ ...target, generation: base.generation }));
    expect(saved.generation).toBe(base.generation);
    expect(saved.durable.state).toEqual(base.durable.state);
  });

  test("revision writes merge against their exact base and reads return matching content/revision", async () => {
    const target = await draft("old");
    const base = value(await readDraftDocument(target));
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base.durable.state);
      doc.getText("codemirror").insert(3, " peer");
      value(
        await acceptDraftDocumentUpdate({
          ...target,
          generation: base.generation,
          baseCursor: base.durable.cursor,
          update: Y.encodeStateAsUpdate(doc),
        }),
      );
      const saved = value(
        await updateDraft({
          ...target,
          expectedRevision: base.revision,
          input: { ...base.durable.content, senderIdentityId: senderId, body: "own" },
        }),
      );
      expect(saved.body).toBe("own peer");
      const read = value(await getDraft(context, mailboxId, target.draftId));
      expect(read.body).toBe(saved.body);
      expect(read.revision).toBe(saved.revision);
    } finally {
      doc.destroy();
    }
  });

  test("inserted-column undo retains peer input and a valid table", async () => {
    const target = await draft();
    const base = value(await readDraftDocument(target));
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base.durable.state);
      const text = doc.getText("codemirror");
      const parsed = findTables(text.toString())[0]!;
      const intent = captureTableAction(text, "colRight", {
        tableFrom: parsed.from,
        rowFrom: parsed.lines[0]!.from,
        columnFrom: parsed.lines[0]!.cells[0]!.from,
        row: 0,
        column: 0,
      });
      const actionId = crypto.randomUUID();
      const inserted = value(await applyDraftTableAction({ ...target, generation: base.generation, actionId, intent }));
      expect(inserted.persisted).toBe(true);
      expect(inserted.receipt).not.toBeNull();
      Y.applyUpdate(doc, fromBase64(inserted.receipt!.update));
      const beforePeer = Y.encodeStateVector(doc);
      const blank = gridLine(findTables(text.toString())[0]!, 1)!.cells[1]!.from;
      text.insert(blank, "PEER");
      value(
        await acceptDraftDocumentUpdate({
          ...target,
          generation: base.generation,
          baseCursor: inserted.cursor,
          update: Y.encodeStateAsUpdate(doc, beforePeer),
          originPeerId: "other-device",
        }),
      );
      const undone = value(
        await applyDraftTableAction({
          ...target,
          generation: base.generation,
          actionId: crypto.randomUUID(),
          intent: { action: "undo", receiptCursor: inserted.cursor! },
        }),
      );
      expect(undone.persisted).toBe(true);
      const body = value(await readDraftDocument(target)).durable.content.body;
      expect(body).toContain("PEER");
      expect(findTables(body)[0]!.columns).toBe(3);
      expect(inspectTableStructure(body)).toMatchObject({ extraCells: false, missingSeparator: false });
    } finally {
      doc.destroy();
    }
  });

  test("an orphan send marker permits the unchanged review, but real unprojected input does not", async () => {
    const target = await draft("Reviewed body");
    const base = value(await readDraftDocument(target));
    await expect(
      sql.begin(async (db) => {
        const handle = value(await lockDraftDocumentInTransaction({ ...target, db }));
        value(await handle.freeze({ generation: base.generation }));
        throw new Error("Outbox transaction rolled back");
      }),
    ).rejects.toThrow("Outbox transaction rolled back");
    const request = {
      db: sql,
      mailboxId,
      draftId: target.draftId,
      expectedRevision: base.revision,
      actor: { kind: "user" as const, userId },
    };
    expect((await loadSendContent(request)).ok).toBe(true);
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, base.durable.state);
      const vector = Y.encodeStateVector(doc);
      doc.getText("codemirror").insert(0, "Unprojected ");
      await mailDraftDocumentLog.topic().publish({
        tenantId: target.draftId,
        data: {
          kind: "sync",
          payload: toBase64(Y.encodeStateAsUpdate(doc, vector)),
          restoreRevision: base.generation,
          originNodeId: "test-node",
          originPeerId: "test-peer",
        },
      });
      expect((await loadSendContent(request)).ok).toBe(false);
    } finally {
      doc.destroy();
    }
  });

  test("Rest rechecks draft access after waiting for the lifecycle lock", async () => {
    const target = await draft("Sent");
    const base = value(await readDraftDocument(target));
    await freeze(target);
    const suffix = newShortId();
    const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid,provider,profile,display_name,mail)
      VALUES (${`waiting-${suffix}`},'local','user','Writer',${`${suffix}@example.test`}) RETURNING id`;
    if (!row || context.actor.kind !== "user") throw new Error("Missing writer fixture");
    extraUsers.push(row.id);
    const writer: MailRequestContext = {
      actor: { kind: "user", user: { ...context.actor.user, id: row.id, uid: `waiting-${suffix}` } },
      accessSubject: { type: "user", userId: row.id },
    };
    const grant = value(await access.grantMailboxAccess({ context, mailboxId, principal: writer.accessSubject, permission: "write" }));
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const checked = Promise.withResolvers<void>();
    const realCheck = access.requireDraftAccess;
    let first = true;
    const check = spyOn(access, "requireDraftAccess").mockImplementation(async (...args) => {
      const result = await realCheck(...args);
      if (args[0] === writer && first) {
        first = false;
        checked.resolve();
      }
      return result;
    });
    const blocker = sql.begin(async (db) => {
      await db`SELECT id FROM mail.drafts WHERE id=${target.draftId}::uuid FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    const doc = new Y.Doc();
    let recovery: ReturnType<typeof recoverDraftDocumentRest> | undefined;
    try {
      await held.promise;
      Y.applyUpdate(doc, base.durable.state);
      doc.getText("codemirror").insert(0, "Local ");
      recovery = recoverDraftDocumentRest({
        ...target,
        context: writer,
        generation: base.generation,
        clientId: crypto.randomUUID(),
        state: Y.encodeStateAsUpdate(doc),
      });
      await checked.promise;
      await sql`DELETE FROM auth.access WHERE id=${grant.id}::uuid`;
      release.resolve();
      await blocker;
      expect((await recovery).ok).toBe(false);
      const [copies] = await sql<
        { count: number }[]
      >`SELECT count(*)::int AS count FROM mail.draft_document_rests WHERE source_draft_id=${target.draftId}::uuid`;
      expect(copies?.count).toBe(0);
    } finally {
      release.resolve();
      await blocker;
      await recovery;
      check.mockRestore();
      doc.destroy();
    }
  });
});
