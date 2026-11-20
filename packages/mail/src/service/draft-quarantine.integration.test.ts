import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { Result } from "@k2b/stdlib";
import { ConflictError } from "@k2b/sync";
import { Hono } from "hono";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import api from "../api";
import type { MailApiContext } from "../api/public-resource-boundary";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { drainDraftDocumentPruning, mailDraftDocumentLog, stopDraftDocumentPruning } from "./draft-document-log";
import { migrateDraftDocumentLogPolicy } from "./draft-document-log-policy";
import { readDraftDocument } from "./draft-documents";
import * as drafts from "./drafts";
import { createMailbox } from "./mailboxes";

const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};
const suite = suiteFor("database", "nats");
suite("Mailbox admin recovery of quarantined shared drafts", () => {
  let context: MailRequestContext;
  let userId: string;
  let mailboxId: string;
  let senderId: string;
  beforeAll(async () => {
    const uid = `mail-c4-${newShortId()}`;
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid,provider,profile,display_name,mail)
      VALUES (${uid},'local','user','Retention Writer',${`${uid}@example.test`}) RETURNING id`;
    if (!user) throw new Error("Missing fixture user");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          roles: ["user"],
          displayName: "Retention Writer",
          givenname: "Retention",
          sn: "Writer",
          mail: `${uid}@example.test`,
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
    mailboxId = value(await createMailbox(context, { name: uid, description: "Retention fixture" })).id;
    const [sender] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id,mailbox_id,label,display_name,from_address,automation_policy,status)
      VALUES (${newShortId()},${mailboxId}::uuid,'Sender','Sender','sender@example.test','disabled','verified') RETURNING id`;
    if (!sender) throw new Error("Missing fixture sender");
    senderId = sender.id;
    await migrateDraftDocumentLogPolicy();
    await stopDraftDocumentPruning();
  });
  afterAll(async () => {
    await stopDraftDocumentPruning();
    await drainDraftDocumentPruning();
    if (mailboxId) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id=${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id=${mailboxId}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id=${grant.access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
  });
  const draft = async (body = "Base") => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id,mailbox_id,sender_identity_id,author_kind,author_id,last_editor_kind,last_editor_id,subject,body_markdown,edit_mode,to_addresses)
      VALUES (${newShortId()},${mailboxId}::uuid,${senderId}::uuid,'user',${userId}::uuid,'user',${userId}::uuid,
        'Retention',${body},'shared',${[{ address: "to@example.test" }]}::jsonb) RETURNING id`;
    if (!row) throw new Error("Missing fixture draft");
    return { context, mailboxId, draftId: row.id };
  };
  const row = async (draftId: string) => (await sql`SELECT * FROM mail.drafts WHERE id = ${draftId}::uuid`)[0];
  const quarantine = async (target: Awaited<ReturnType<typeof draft>>) => {
    const snapshot = value(await readDraftDocument(target));
    await sql`UPDATE mail.drafts SET doc_history_complete = false, revision = revision + 1 WHERE id = ${target.draftId}::uuid`;
    return snapshot;
  };
  const recover = async (target: Awaited<ReturnType<typeof draft>>, requestId = crypto.randomUUID()) => {
    const current = await row(target.draftId);
    return drafts.recoverQuarantinedDraft({
      ...target,
      input: {
        expectedRevision: Number(current.revision),
        generation: String(current.doc_generation),
        requestId,
      },
    });
  };

  test("public quarantine recovery route repairs a blocked draft", async () => {
    const target = await draft("Public recovery");
    await quarantine(target);
    const current = await row(target.draftId);
    const fixture = new Hono<MailApiContext>();
    fixture.use("*", async (c, next) => {
      c.set("actor", context.actor);
      c.set("accessSubject", context.accessSubject);
      c.set("internalMailboxId", mailboxId);
      c.set("internalDraftId", target.draftId);
      await next();
    });
    // Keep the real validator, response localization and public-ID conversion.
    // Identity authentication belongs to Cloud; services enforce mailbox admin.
    for (const route of api.routes)
      if (route.method === "POST" && route.path === "/mailboxes/:mailboxId/drafts/:draftId/quarantine/recover")
        fixture.on(route.method, route.path, route.handler);
    const response = await fixture.request("/mailboxes/Mail01/drafts/Draft1/quarantine/recover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: Number(current.revision), generation: "1", requestId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ outcome: "original_repaired", reviewRequired: false, draft: { id: current.short_id } });
    expect(value(await readDraftDocument(target)).fresh.content.body).toBe("Public recovery");
  });

  test("repairs only a strictly replayable original seed, fencing old clients and retaining source bytes", async () => {
    const target = await draft("Complete seed");
    const seeded = value(await readDraftDocument(target));
    const local = new Y.Doc();
    Y.applyUpdate(local, seeded.durable.state);
    const vector = Y.encodeStateVector(local);
    local.getText("codemirror").insert(local.getText("codemirror").length, " + accepted edit");
    await mailDraftDocumentLog.topic().publish({
      tenantId: target.draftId,
      data: {
        kind: "sync",
        payload: Buffer.from(Y.encodeStateAsUpdate(local, vector)).toString("base64"),
        originNodeId: "quarantine-fixture",
        originPeerId: null,
        restoreRevision: "1",
      },
    });
    local.destroy();
    await quarantine(target);
    const before = await row(target.draftId);
    expect(await drafts.getDraft(context, mailboxId, target.draftId)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(value(await drafts.inspectDraftQuarantine(target))).toMatchObject({ historyComplete: false, originalRepairPossible: true });
    expect(await row(target.draftId)).toEqual(before);
    const requestId = crypto.randomUUID();
    const repaired = value(await recover(target, requestId));
    expect(repaired).toMatchObject({
      outcome: "original_repaired",
      reviewRequired: false,
      draft: { id: target.draftId, body: "Complete seed + accepted edit", generation: "2", revision: Number(before.revision) + 1 },
    });
    expect(value(await readDraftDocument(target)).fresh.content.body).toBe("Complete seed + accepted edit");
    expect(value(await drafts.getDraft(context, mailboxId, target.draftId)).id).toBe(target.draftId);
    const [retained] = await sql`SELECT source_state FROM mail.draft_document_rests
      WHERE source_draft_id = ${target.draftId}::uuid AND client_id = ${requestId}::uuid`;
    expect(Buffer.from(retained.source_state)).toEqual(Buffer.from(before.doc_state));
    const after = await row(target.draftId);
    expect(
      value(
        await drafts.recoverQuarantinedDraft({
          ...target,
          input: {
            expectedRevision: Number(before.revision),
            generation: "1",
            requestId,
          },
        }),
      ).outcome,
    ).toBe("original_repaired");
    expect(await row(target.draftId)).toEqual(after);
  });

  test("a rejected replacement marker is typed and rolls back the recovery receipt", async () => {
    const target = await draft("Unchanged on conflict");
    await quarantine(target);
    const before = await row(target.draftId);
    const topic = mailDraftDocumentLog.topic();
    const handle = spyOn(mailDraftDocumentLog, "topic").mockReturnValue(topic);
    const publish = spyOn(topic, "publish").mockRejectedValueOnce(new ConflictError("fixture expectedAfter conflict"));
    try {
      expect(await recover(target)).toMatchObject({ ok: false, error: { code: "DRAFT_QUARANTINE_RECOVERY_CHANGED", status: 409 } });
    } finally {
      publish.mockRestore();
      handle.mockRestore();
    }
    expect(await row(target.draftId)).toEqual(before);
    expect(await sql`SELECT 1 FROM mail.draft_document_rests WHERE source_draft_id = ${target.draftId}::uuid`).toHaveLength(0);
  });

  // This destructive prune follows the original-repair cases: the topic is
  // shared by this process, and losing any prefix deliberately disables repair.
  test("later idle coverage cannot rehabilitate a pruned original; one linked copy preserves the reply slot", async () => {
    const target = await draft("Please review this retained text");
    await quarantine(target);
    const [conversation] = await sql<{ id: string }[]>`INSERT INTO mail.conversations (short_id, mailbox_id, subject, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Recovery conversation', '2026-11-19T00:00:00Z') RETURNING id`;
    if (!conversation) throw new Error("Missing conversation");
    const [message] = await sql<{ id: string }[]>`INSERT INTO mail.message_contents
      (short_id, mailbox_id, message_id, subject, internal_date, content_hash, hydration_status, plain_text)
      VALUES (${newShortId()}, ${mailboxId}::uuid, '<quarantine-fixture@example.test>', 'Recovery',
        '2026-11-19T00:00:00Z', ${"c".repeat(64)}, 'complete', 'Original message') RETURNING id`;
    if (!message) throw new Error("Missing source message");
    await sql`UPDATE mail.drafts SET conversation_id = ${conversation.id}::uuid, source_message_id = ${message.id}::uuid,
      intent = 'reply' WHERE id = ${target.draftId}::uuid`;
    const topic = mailDraftDocumentLog.topic();
    const marker = await topic.publish({
      tenantId: crypto.randomUUID(),
      data: {
        kind: "freeze",
        payload: "",
        originNodeId: "quarantine-fixture",
        originPeerId: null,
      },
    });
    await topic.prune({ through: marker.cursor });
    await sql`UPDATE mail.drafts SET doc_idle_through = ${topic.cursorSequence(marker.cursor)}, revision = revision + 2
      WHERE id = ${target.draftId}::uuid`;
    const before = await row(target.draftId);
    expect(value(await drafts.inspectDraftQuarantine(target)).originalRepairPossible).toBe(false);
    const requestId = crypto.randomUUID();
    const copied = value(await recover(target, requestId));
    expect(copied).toMatchObject({
      outcome: "recovery_copy",
      reviewRequired: true,
      draft: { intent: "new", body: before.body_markdown, conversationId: null, sourceMessageId: null },
    });
    expect(copied.draft.id).not.toBe(target.draftId);
    expect(copied.draft.restSourceDraftId).toBe(before.short_id);
    expect(await row(target.draftId)).toEqual(before);
    expect(value(await drafts.getDraft(context, mailboxId, copied.draft.id)).body).toBe(before.body_markdown);
    expect(value(await recover(target, requestId)).draft.id).toBe(copied.draft.id);
    expect(await row(target.draftId)).toEqual(before);
  });

  test("a missing seed makes a review copy with active attachments and preserves incomplete Yjs bytes", async () => {
    const target = await draft("Last durable text");
    await quarantine(target);
    await sql`DELETE FROM mail.draft_document_revisions WHERE draft_id = ${target.draftId}::uuid`;
    const missing = new Y.Doc();
    const later = new Y.Doc();
    missing.getText("codemirror").insert(0, "missing predecessor");
    Y.applyUpdate(later, Y.encodeStateAsUpdate(missing));
    const vector = Y.encodeStateVector(later);
    later.getText("codemirror").insert(0, "pending");
    const pending = Y.encodeStateAsUpdate(later, vector);
    const stored = await row(target.draftId);
    const state = Y.mergeUpdates([stored.doc_state, pending]);
    missing.destroy();
    later.destroy();
    await sql`UPDATE mail.drafts SET doc_state = ${Buffer.from(state)} WHERE id = ${target.draftId}::uuid`;
    const [blob] = await sql<{ id: string }[]>`INSERT INTO mail.message_part_blobs (content_hash, byte_length, chunk_count, complete)
      VALUES (${"a".repeat(64)}, 1, 0, true) RETURNING id`;
    if (!blob) throw new Error("Missing attachment blob");
    await sql`INSERT INTO mail.draft_attachments (short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position)
      VALUES (${newShortId()}, ${target.draftId}::uuid, ${blob.id}::uuid, 'review.txt', 'text/plain', 1, ${"a".repeat(64)}, 0)`;
    const before = await row(target.draftId);
    const recovered = value(await recover(target));
    expect(recovered).toMatchObject({
      outcome: "recovery_copy",
      draft: { body: "Last durable text", attachments: [{ filename: "review.txt", contentHash: "a".repeat(64) }] },
    });
    const [rest] = await sql`SELECT source_state FROM mail.draft_document_rests WHERE rest_draft_id = ${recovered.draft.id}::uuid`;
    expect(Buffer.from(rest.source_state)).toEqual(Buffer.from(state));
    expect(await row(target.draftId)).toEqual(before);
  });

  test("rejects stale revisions and generations without changing the source", async () => {
    const target = await draft();
    await quarantine(target);
    const before = await row(target.draftId);
    for (const input of [
      { expectedRevision: 1, generation: "1", requestId: crypto.randomUUID() },
      { expectedRevision: Number(before.revision), generation: "2", requestId: crypto.randomUUID() },
    ])
      expect(await drafts.recoverQuarantinedDraft({ ...target, input })).toMatchObject({ ok: false, error: { status: 409 } });
    expect(await row(target.draftId)).toEqual(before);
  });

  test("requires mailbox admin, including inspection", async () => {
    const target = await draft();
    await quarantine(target);
    const before = await row(target.draftId);
    await sql`UPDATE auth.access SET permission = 'write' WHERE id IN
      (SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid)`;
    try {
      expect(await drafts.inspectDraftQuarantine(target)).toMatchObject({ ok: false, error: { status: 403 } });
      expect(await recover(target)).toMatchObject({ ok: false, error: { status: 403 } });
    } finally {
      await sql`UPDATE auth.access SET permission = 'admin' WHERE id IN
        (SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid)`;
    }
    expect(await row(target.draftId)).toEqual(before);
  });

  test("blocks recovery while a send is queued or executing", async () => {
    const target = await draft();
    await quarantine(target);
    const before = await row(target.draftId);
    const [command] = await sql<{ id: string }[]>`INSERT INTO mail.commands
      (mailbox_id, kind, actor_kind, actor_id, access_subject_kind, access_subject_id, idempotency_key, request_hash, target, payload)
      VALUES (${mailboxId}::uuid, 'send', 'user', ${userId}::uuid, 'user', ${userId}::uuid,
        ${crypto.randomUUID()}, ${"b".repeat(64)}, ${{ draftId: target.draftId }}::jsonb, '{}'::jsonb) RETURNING id`;
    if (!command) throw new Error("Missing send command");
    try {
      for (const state of ["queued", "executing", "ambiguous"]) {
        await sql`UPDATE mail.commands SET state = ${state} WHERE id = ${command.id}::uuid`;
        expect(await recover(target)).toMatchObject({ ok: false, error: { code: "DRAFT_RECOVERY_SEND_PENDING", status: 409 } });
      }
    } finally {
      await sql`DELETE FROM mail.commands WHERE id = ${command.id}::uuid`;
    }
    expect(await row(target.draftId)).toEqual(before);
  });

  test("a replay transport failure produces no copy and does not change the original", async () => {
    const target = await draft();
    await quarantine(target);
    const before = await row(target.draftId);
    const probe = spyOn(mailDraftDocumentLog, "firstSequence").mockRejectedValueOnce(new Error("fixture transport unavailable"));
    try {
      expect(await recover(target)).toMatchObject({ ok: false, error: { status: 500 } });
    } finally {
      probe.mockRestore();
    }
    expect(await row(target.draftId)).toEqual(before);
    expect(await sql`SELECT 1 FROM mail.draft_document_rests WHERE source_draft_id = ${target.draftId}::uuid`).toHaveLength(0);
  });
});
