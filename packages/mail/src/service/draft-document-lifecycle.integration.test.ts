import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { captureTableAction, fromBase64, toBase64 } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { findTables, gridLine, inspectTableStructure } from "@k2b/ui/text-editor/model";
import { sql } from "bun";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import * as access from "./access";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import * as revisionBase from "./draft-document-revision";
import { acceptDraftDocumentUpdate, lockDraftDocumentInTransaction, mailDraftDocumentLog, readDraftDocument } from "./draft-documents";
import { draftProviderContentSchema } from "./draft-provider-mime";
import { queueDraftProjectionInTransaction } from "./draft-provider-projection";
import { applyDraftTableAction } from "./draft-table-actions";
import { discardDraft, getDraft, persistDraftDocument, recoverDraftDocumentRest, restoreDraftRecoveryCopy, updateDraft } from "./drafts";
import { createMailbox } from "./mailboxes";
import { storeReadableBlob } from "./message-blobs";
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
    const [sender] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Writer', 'Writer', 'writer@example.test', 'disabled', 'verified') RETURNING id`;
    if (!sender) throw new Error("Missing fixture sender");
    senderId = sender.id;
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
    await sql`UPDATE mail.draft_provider_snapshots SET state='appending',provider_effect_started_at=now() WHERE id=${original}::uuid`;
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
      { id: string; state: string; content_snapshot: unknown }[]
    >`SELECT id,state,content_snapshot FROM mail.draft_provider_snapshots
      WHERE draft_id=${target.draftId}::uuid AND direction='export' ORDER BY cloud_revision`;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: original, state: "appending" });
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
