import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import type { Result } from "@k2b/stdlib";
import { sql } from "bun";
import * as Y from "yjs";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { type DraftEditableContent, draftEditableContentInputSchema } from "../contracts";
import { createDraftRevisionUpdate, readDraftDocument as readModel } from "../lib/draft-document";
import { newShortId } from "../lib/short-id";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { DRAFT_REVISION_HISTORY_BYTES, DRAFT_REVISION_OPERATION_ORIGIN } from "./draft-document-operation";
import { acceptDraftDocumentUpdate, lockDraftDocumentInTransaction, mailDraftDocumentLog, readDraftDocument } from "./draft-documents";
import { appendDraftAttachmentUpload, createDraftAttachmentUpload, finalizeDraftAttachmentUpload } from "./draft-uploads";
import { removeDraftAttachment } from "./drafts";
import { createMailbox } from "./mailboxes";

const suite = suiteFor("database", "nats");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
};
const decode = (state: Uint8Array) => {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state);
    return readModel(doc);
  } finally {
    doc.destroy();
  }
};
const deadline = () => Date.now() + 10_000;

suite("Mail shared draft transaction store", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const users: string[] = [];
  const mailboxes: string[] = [];
  const blobs: string[] = [];
  let owner: MailRequestContext;
  let reader: MailRequestContext;
  let outsider: MailRequestContext;
  let assigned: MailRequestContext;
  let mailboxId: string;
  let otherMailboxId: string;
  let identity: { id: string; short_id: string };
  let otherIdentity: { id: string; short_id: string };
  let unverified: { id: string; short_id: string };
  let signature: { id: string; short_id: string };
  let privateSignature: { id: string; short_id: string };

  const user = async (label: string): Promise<MailRequestContext> => {
    const uid = `mail-doc-${label}-${suffix}`;
    const [created] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES (${uid}, 'local', 'user', ${label}, ${`${uid}@example.test`}) RETURNING id
    `;
    if (!created) throw new Error("Missing test user");
    users.push(created.id);
    return {
      actor: {
        kind: "user",
        user: {
          id: created.id,
          uid,
          provider: "local",
          profile: "user",
          roles: ["user"],
          displayName: label,
          givenname: label,
          sn: "Test",
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
      accessSubject: { type: "user", userId: created.id },
    };
  };
  const sender = async (box: string, status = "verified") => {
    const [created] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${box}::uuid, 'Sender', 'Sender', ${`sender-${newShortId()}@example.test`}, 'disabled', ${status})
      RETURNING id, short_id
    `;
    if (!created) throw new Error("Missing test sender");
    return created;
  };
  const template = async (scope: "mailbox" | "private", ownerId: string | null) => {
    const [created] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.compose_templates (
        short_id, mailbox_id, kind, scope, owner_user_id, name, normalized_name, shortcut,
        body_template, created_by_actor_kind, created_by_actor_id
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, 'signature', ${scope}, ${ownerId}::uuid,
        ${`Signature ${scope}`}, ${`signature ${scope}`}, ${`sig_${scope}`}, 'Regards, Example', 'user', ${users[0]}::uuid
      ) RETURNING id, short_id
    `;
    if (!created) throw new Error("Missing test signature");
    return created;
  };
  const draft = async (
    options: {
      mode?: "lock" | "shared";
      signature?: string | null;
      body?: string;
      subject?: string;
      author?: "user" | "workflow";
      recipients?: Partial<Pick<DraftEditableContent, "to" | "cc" | "bcc">>;
    } = {},
  ) => {
    const content = draftEditableContentInputSchema.parse({
      senderIdentityId: identity.short_id,
      signatureTemplateId: options.signature ? signature.short_id : null,
      to: [{ address: "to@example.test", name: "To" }],
      cc: [{ address: "cc@example.test", name: null }],
      bcc: [{ address: "bcc@example.test", name: "Hidden" }],
      ...options.recipients,
      subject: options.subject ?? "Subject 😀",
      body: options.body ?? "First line\n\n| A | B |\n| --- | --- |\n| x | y |\nLast line 😀",
      format: "markdown",
      priority: "high",
      requestDeliveryReceipt: true,
      requestReadReceipt: true,
    });
    const [created] = await sql<{ id: string }[]>`
      INSERT INTO mail.drafts (
        short_id, mailbox_id, sender_identity_id, signature_template_id, author_kind, author_id,
        last_editor_kind, last_editor_id, to_addresses, cc_addresses, bcc_addresses, subject, body_markdown,
        body_format, priority, request_delivery_receipt, request_read_receipt, edit_mode
      ) VALUES (
        ${newShortId()}, ${mailboxId}::uuid, ${identity.id}::uuid, ${options.signature ?? null}::uuid,
        ${options.author ?? "user"}, ${users[0]}::uuid, 'user', ${users[0]}::uuid,
        ${content.to}::jsonb, ${content.cc}::jsonb, ${content.bcc}::jsonb, ${content.subject}, ${content.body},
        ${content.format}, ${content.priority}, ${content.requestDeliveryReceipt}, ${content.requestReadReceipt}, ${options.mode ?? "shared"}
      ) RETURNING id
    `;
    if (!created) throw new Error("Missing test draft");
    return { id: created.id, content };
  };
  const read = (id: string, context = owner) => readDraftDocument({ context, mailboxId, draftId: id });
  const update = async (id: string, content: DraftEditableContent, base?: Awaited<ReturnType<typeof initial>>) => {
    const captured = base ?? (await initial(id));
    const bytes = await createDraftRevisionUpdate(captured.fresh.state, content, { deadline: deadline() });
    return acceptDraftDocumentUpdate({
      context: owner,
      mailboxId,
      draftId: id,
      generation: captured.generation,
      baseCursor: captured.fresh.cursor,
      update: bytes,
    });
  };
  const initial = async (id: string) => value(await read(id));

  beforeAll(async () => {
    owner = await user("owner");
    reader = await user("reader");
    outsider = await user("outsider");
    assigned = await user("assigned");
    mailboxId = value(await createMailbox(owner, { name: `Draft documents ${suffix}`, description: "Test fixture" })).id;
    otherMailboxId = value(await createMailbox(owner, { name: `Other documents ${suffix}`, description: "Test fixture" })).id;
    mailboxes.push(mailboxId, otherMailboxId);
    value(await grantMailboxAccess({ context: owner, mailboxId, principal: reader.accessSubject, permission: "read" }));
    value(
      await grantMailboxAccess({ context: owner, mailboxId, principal: assigned.accessSubject, permission: "write", scope: "assigned" }),
    );
    identity = await sender(mailboxId);
    otherIdentity = await sender(otherMailboxId);
    unverified = await sender(mailboxId, "unverified");
    signature = await template("mailbox", null);
    privateSignature = await template("private", users[2]!);
  });
  afterAll(async () => {
    const access = await sql<{ access_id: string }[]>`
      SELECT access_id FROM mail.mailbox_access WHERE mailbox_id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxes}::jsonb))
    `;
    await sql`DELETE FROM mail.mailboxes WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${mailboxes}::jsonb))`;
    await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobs}::jsonb))`;
    await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((x) => x.access_id)}::jsonb))`;
    await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${users}::jsonb))`;
  });

  test("concurrent lazy loads seed once, preserving exact headers/body and only public IDs", async () => {
    const created = await draft({ signature: signature.id });
    const [left, right] = await Promise.all([read(created.id), read(created.id)]);
    const a = value(left);
    const b = value(right);
    expect(a.durable.content).toEqual(created.content);
    expect(a.durable.state).toEqual(b.durable.state);
    expect(a.revision).toBe(1);
    expect(a.fresh).toEqual(a.durable);
    const [count] = await sql<
      { n: number }[]
    >`SELECT count(*)::int AS n FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid`;
    expect(count?.n).toBe(1);
    expect(JSON.stringify(decode(a.durable.state))).not.toContain(identity.id);
    expect(JSON.stringify(decode(a.durable.state))).not.toContain(signature.id);
  });

  test("lock mode, workflows, frozen lifecycle and incomplete history fail before seed/publication", async () => {
    for (const kind of ["lock", "workflow", "scheduled", "incomplete"] as const) {
      const created = await draft({ mode: kind === "lock" ? "lock" : "shared", author: kind === "workflow" ? "workflow" : "user" });
      if (kind === "scheduled") await sql`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${created.id}::uuid`;
      if (kind === "incomplete") await sql`UPDATE mail.drafts SET doc_history_complete = false WHERE id = ${created.id}::uuid`;
      const result = await read(created.id);
      expect(result.ok).toBe(false);
      const [row] = await sql<{ doc_state: Uint8Array | null }[]>`SELECT doc_state FROM mail.drafts WHERE id = ${created.id}::uuid`;
      expect(row?.doc_state).toBeNull();
      expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
    }
  });

  test("enforces mailbox/draft permissions on reads, admits, and the bound store", async () => {
    const created = await draft();
    expect((await read(created.id, outsider)).ok).toBe(false);
    expect((await read(created.id, assigned)).ok).toBe(false);
    const base = value(await read(created.id, reader));
    expect((await readDraftDocument({ context: owner, mailboxId: otherMailboxId, draftId: created.id })).ok).toBe(false);
    const bytes = await createDraftRevisionUpdate(base.fresh.state, { ...created.content, body: "Forbidden" }, { deadline: deadline() });
    expect(
      (
        await acceptDraftDocumentUpdate({
          context: reader,
          mailboxId,
          draftId: created.id,
          generation: base.generation,
          baseCursor: base.fresh.cursor,
          update: bytes,
        })
      ).ok,
    ).toBe(false);
    await sql.begin(async (db) => {
      const locked = value(
        await lockDraftDocumentInTransaction({ db, context: reader, mailboxId, draftId: created.id, permission: "read" }),
      );
      await expect(
        locked.store.save(
          created.id,
          {
            state: base.fresh.state,
            text: created.content.body,
            cursor: base.fresh.cursor!,
            restoreRevision: base.generation,
            requestedAt: 0,
            actor: null,
            contributors: [],
          },
          undefined,
        ),
      ).rejects.toThrow();
      await expect(locked.store.load(crypto.randomUUID(), {})).rejects.toThrow("another draft");
    });
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
  });

  test("projects complete merged headers/body, exact revision base, and provider projection only once", async () => {
    const created = await draft();
    const base = await initial(created.id);
    const next = {
      ...created.content,
      subject: "New subject",
      body: "New body 😀",
      to: [],
      cc: [],
      bcc: [{ address: "moved@example.test", name: "Moved" }],
      priority: "low" as const,
      format: "plain" as const,
      requestDeliveryReceipt: false,
      requestReadReceipt: false,
      signatureTemplateId: signature.short_id,
    };
    const admitted = value(await update(created.id, next, base));
    expect(admitted.status).toBe("accepted");
    if (admitted.status !== "accepted") throw new Error("Admission did not persist");
    expect(admitted.revision).toBe(2);
    expect(admitted.durable.content).toEqual(next);
    const [row] = await sql<
      {
        sender_identity_id: string;
        signature_template_id: string;
        body_markdown: string;
        subject: string;
        to_addresses: unknown;
        cc_addresses: unknown;
        bcc_addresses: unknown;
        body_format: string;
        priority: string;
        request_delivery_receipt: boolean;
        request_read_receipt: boolean;
      }[]
    >`SELECT * FROM mail.drafts WHERE id = ${created.id}::uuid`;
    expect(row).toMatchObject({
      sender_identity_id: identity.id,
      signature_template_id: signature.id,
      body_markdown: next.body,
      subject: next.subject,
      to_addresses: [],
      cc_addresses: [],
      bcc_addresses: next.bcc,
      body_format: "plain",
      priority: "low",
      request_delivery_receipt: false,
      request_read_receipt: false,
    });
    const [revision] = await sql<{ state: Uint8Array; cursor: string }[]>`
      SELECT state, cursor FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid AND generation = 1 AND revision = 2
    `;
    expect(revision?.state).toEqual(admitted.durable.state);
    expect(revision?.cursor).toBe(admitted.cursor);
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      const projected = value(await locked.project());
      expect(projected.status).toBe("covered");
      expect(projected.revision).toBe(2);
    });
    const [counts] = await sql<{ revisions: number; projections: number }[]>`
      SELECT (SELECT count(*)::int FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid) AS revisions,
        (SELECT count(*)::int FROM mail.draft_provider_snapshots WHERE draft_id = ${created.id}::uuid AND cloud_revision = 2) AS projections
    `;
    expect(counts?.revisions).toBe(2);
    expect(counts?.projections).toBe(1);
  });

  test("assigned-only visibility is rechecked after the draft is locked", async () => {
    const created = await draft();
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Assigned draft', 'customer@example.test', ${new Date("2026-01-01T12:00:00Z")})
      RETURNING id
    `;
    if (!conversation) throw new Error("Missing conversation");
    await sql`UPDATE mail.drafts SET conversation_id = ${conversation.id}::uuid WHERE id = ${created.id}::uuid`;
    await sql`INSERT INTO mail.conversation_assignees (conversation_id, user_id) VALUES (${conversation.id}::uuid, ${users[3]}::uuid)`;
    const base = value(await read(created.id, assigned));
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: assigned, mailboxId, draftId: created.id }));
      await db`DELETE FROM mail.conversation_assignees WHERE conversation_id = ${conversation.id}::uuid`;
      const bytes = await createDraftRevisionUpdate(
        base.fresh.state,
        { ...created.content, subject: "Must not publish" },
        { deadline: deadline() },
      );
      expect((await locked.accept({ generation: "1", baseCursor: base.fresh.cursor, update: bytes })).ok).toBe(false);
    });
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
  });

  test("rejects cross-mailbox/unverified senders, private signatures and invalid merged headers before publishing", async () => {
    const created = await draft();
    const base = await initial(created.id);
    for (const changed of [
      { senderIdentityId: otherIdentity.short_id },
      { senderIdentityId: unverified.short_id },
      { signatureTemplateId: privateSignature.short_id },
      { subject: "x".repeat(999) },
    ]) {
      let bytes: Uint8Array;
      if (typeof changed.subject === "string") {
        const doc = new Y.Doc();
        try {
          Y.applyUpdate(doc, base.fresh.state);
          const vector = Y.encodeStateVector(doc);
          doc.getText("mail.subject").insert(0, changed.subject);
          bytes = Y.encodeStateAsUpdate(doc, vector);
        } finally {
          doc.destroy();
        }
      } else bytes = await createDraftRevisionUpdate(base.fresh.state, { ...created.content, ...changed }, { deadline: deadline() });
      const result = value(
        await acceptDraftDocumentUpdate({
          context: owner,
          mailboxId,
          draftId: created.id,
          generation: base.generation,
          baseCursor: base.fresh.cursor,
          update: bytes,
        }),
      );
      expect(result.status).toBe("recoveryRequired");
      expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
    }
  });

  test("authenticates old revision bases and merges their edits without replacing newer peer text or Bcc moves", async () => {
    const created = await draft({ body: "One\nTwo\nThree" });
    const base = await initial(created.id);
    value(
      await update(
        created.id,
        { ...created.content, body: "One peer\nTwo\nThree", to: [], bcc: [...created.content.bcc, ...created.content.to] },
        base,
      ),
    );
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      const result = value(
        await locked.writeRevision({
          generation: "1",
          expectedRevision: 1,
          content: { ...created.content, body: "One\nTwo\nThree agent" },
          deadline: deadline(),
        }),
      );
      expect(result.status).toBe("accepted");
      const current = value(await locked.read());
      expect(current.fresh.content.body).toBe("One peer\nTwo\nThree agent");
      expect(current.fresh.content.to).toEqual([]);
      expect(current.fresh.content.bcc).toEqual([...created.content.bcc, ...created.content.to]);
      expect(
        value(await locked.writeRevision({ generation: "1", expectedRevision: 999, content: created.content, deadline: deadline() }))
          .status,
      ).toBe("recoveryRequired");
      expect(
        (await locked.writeRevision({ generation: "2", expectedRevision: 1, content: created.content, deadline: deadline() })).ok,
      ).toBe(false);
    });
  });

  test.each([false, true])("revision PUT retries preserve text and peers exactly once (omitted names: %s)", async (omitNames) => {
    const created = await draft({
      body: "",
      subject: "",
      recipients: omitNames
        ? {
            to: [{ address: "to@example.test" }],
            cc: [{ address: "cc@example.test" }],
            bcc: [{ address: "bcc@example.test" }],
          }
        : undefined,
    });
    const base = await initial(created.id);
    const content = { ...created.content, body: "x", subject: "x" };
    const expected = { ...base.durable.content, body: "x", subject: "x" };
    const write = () =>
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        return value(await locked.writeRevision({ generation: "1", expectedRevision: 1, content, deadline: deadline() }));
      });
    const first = await write();
    expect(first.status).toBe("accepted");
    const firstHead = await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id });
    const duplicate = await write();
    expect(duplicate.status).toBe("accepted");
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(firstHead);
    expect((await initial(created.id)).durable.content).toEqual(expected);

    const current = await initial(created.id);
    const peer = new Y.Doc();
    let bytes: Uint8Array;
    try {
      Y.applyUpdate(peer, current.fresh.state);
      peer.clientID = 424242;
      const vector = Y.encodeStateVector(peer);
      peer.getText("codemirror").insert(1, " peer");
      peer.getText("mail.subject").insert(1, " peer");
      bytes = Y.encodeStateAsUpdate(peer, vector);
    } finally {
      peer.destroy();
    }
    expect(
      value(
        await acceptDraftDocumentUpdate({
          context: owner,
          mailboxId,
          draftId: created.id,
          generation: "1",
          baseCursor: current.fresh.cursor,
          update: bytes,
        }),
      ).status,
    ).toBe("accepted");
    const peerHead = await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id });
    const retried = await write();
    expect(retried.status).toBe("accepted");
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(peerHead);
    expect((await initial(created.id)).durable.content).toEqual({ ...expected, body: "x peer", subject: "x peer" });
    expect((await initial(created.id)).revision).toBe(3);
    expect(base.revision).toBe(1);
  });

  test.each([false, true])("revision receipt survives first-write SQL rollback (omitted names: %s)", async (omitNames) => {
    const created = await draft({
      body: "",
      subject: "",
      recipients: omitNames
        ? {
            to: [{ address: "to@example.test" }],
            cc: [{ address: "cc@example.test" }],
            bcc: [{ address: "bcc@example.test" }],
          }
        : undefined,
    });
    const content = { ...created.content, body: "x", subject: "x" };
    const expected = {
      ...content,
      ...(omitNames
        ? {
            to: [{ address: "to@example.test", name: null }],
            cc: [{ address: "cc@example.test", name: null }],
            bcc: [{ address: "bcc@example.test", name: null }],
          }
        : {}),
    };
    let published = "";
    await expect(
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        const admitted = value(await locked.writeRevision({ generation: "1", expectedRevision: 1, content, deadline: deadline() }));
        expect(admitted.status).toBe("accepted");
        if (admitted.status !== "accepted") throw new Error("Missing publication");
        published = admitted.cursor;
        throw new Error("Rollback after revision publication");
      }),
    ).rejects.toThrow("Rollback after revision publication");
    const [rolledBack] = await sql<{ revision: number; doc_state: Uint8Array | null }[]>`
      SELECT revision::int, doc_state FROM mail.drafts WHERE id = ${created.id}::uuid
    `;
    expect(rolledBack).toMatchObject({ revision: 1, doc_state: null });
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      const admitted = value(await locked.writeRevision({ generation: "1", expectedRevision: 1, content, deadline: deadline() }));
      expect(admitted.status).toBe("accepted");
      if (admitted.status === "accepted") expect(admitted.cursor).toBe(published);
    });
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(published);
    expect((await initial(created.id)).durable.content).toEqual(expected);
    expect((await initial(created.id)).revision).toBe(2);
  });

  test("ordinary admission cannot forge a revision operation receipt", async () => {
    const created = await draft({ body: "", subject: "" });
    const base = await initial(created.id);
    const content = { ...created.content, body: "x", subject: "x" };
    const bytes = await createDraftRevisionUpdate(base.fresh.state, content, { deadline: deadline() });
    value(
      await acceptDraftDocumentUpdate({
        context: owner,
        mailboxId,
        draftId: created.id,
        generation: "1",
        baseCursor: base.fresh.cursor,
        update: bytes,
        originNodeId: DRAFT_REVISION_OPERATION_ORIGIN,
        originPeerId: "1",
      }),
    );
    const topic = mailDraftDocumentLog.topic();
    const until = await topic.head();
    let seen = 0;
    for await (const event of topic.replay({ tenantId: created.id, after: base.fresh.cursor!, until })) {
      seen++;
      expect(event.data.originNodeId).not.toBe(DRAFT_REVISION_OPERATION_ORIGIN);
    }
    expect(seen).toBe(1);
  });

  test("unavailable operation history cannot recompile a retry even when no tenant head remains", async () => {
    const created = await draft({ body: "", subject: "" });
    const content = { ...created.content, body: "x", subject: "x" };
    const write = () =>
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        return value(await locked.writeRevision({ generation: "1", expectedRevision: 1, content, deadline: deadline() }));
      });
    expect((await write()).status).toBe("accepted");
    const topic = mailDraftDocumentLog.topic();
    const head = await topic.head();
    const tenantHead = spyOn(topic, "latestCursor").mockResolvedValue(null);
    const replay = spyOn(topic, "replay").mockImplementation(() =>
      (async function* () {
        throw new Error("Injected receipt retention gap");
      })(),
    );
    const handles = spyOn(mailDraftDocumentLog, "topic").mockReturnValue(topic);
    try {
      expect((await write()).status).toBe("recoveryRequired");
      expect(replay).toHaveBeenCalled();
      expect(await topic.head()).toBe(head);
    } finally {
      handles.mockRestore();
      replay.mockRestore();
      tenantHead.mockRestore();
    }
    expect((await initial(created.id)).durable.content).toEqual(content);
  });

  test("historical bases have a byte budget; retained stale bases merge and evicted bases require recovery", async () => {
    const created = await draft({ body: "a".repeat(2 * 1024 * 1024 - 64) });
    await initial(created.id);
    // Exercise the public unchanged-base writer used by attachment revisions.
    // Large initial text gives the real byte policy a small, finite fixture.
    for (let edit = 1; edit <= 8; edit++) {
      await sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        await db`UPDATE mail.drafts SET revision = revision + 1 WHERE id = ${created.id}::uuid`;
        expect(value(await locked.recordRevisionBase()).revision).toBe(edit + 1);
      });
    }
    expect(value(await update(created.id, { ...created.content, body: `${created.content.body}:peer` })).status).toBe("accepted");
    const bases = await sql<{ revision: number; state: Uint8Array; bytes: number }[]>`
      SELECT revision::int, state, octet_length(state)::int AS bytes FROM mail.draft_document_revisions
      WHERE draft_id = ${created.id}::uuid ORDER BY revision
    `;
    expect(bases[0]!.revision).toBeGreaterThan(1);
    expect(bases.at(-1)!.revision).toBe(10);
    expect(bases.slice(0, -1).reduce((total, row) => total + row.bytes, 0)).toBeLessThanOrEqual(DRAFT_REVISION_HISTORY_BYTES);
    expect(bases.at(-1)!.state).toEqual((await initial(created.id)).durable.state);
    const retained = bases[0]!;
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      const stale = decode(retained.state);
      expect(
        value(
          await locked.writeRevision({
            generation: "1",
            expectedRevision: retained.revision,
            content: { ...stale, body: `${stale.body} retained` },
            deadline: deadline(),
          }),
        ).status,
      ).toBe("accepted");
      const before = value(await locked.read());
      expect(before.durable.content.body).toContain("retained");
      expect(before.durable.content.body).toContain("peer");
      expect(
        value(
          await locked.writeRevision({
            generation: "1",
            expectedRevision: 1,
            content: { ...created.content, subject: "Must remain recoverable" },
            deadline: deadline(),
          }),
        ).status,
      ).toBe("recoveryRequired");
      expect(value(await locked.read())).toEqual(before);
      const frozen = value(await locked.freeze({ generation: "1" }));
      const [pinned] = await db<{ state: Uint8Array }[]>`
        SELECT state FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid
          AND generation = 1 AND revision = ${frozen.revision}
      `;
      expect(pinned?.state).toEqual(frozen.state);
      await db`SELECT mail.trim_draft_document_revisions(${created.id}::uuid)`;
      const after = value(await locked.read());
      expect(after.frozen?.state).toEqual(frozen.state);
      expect(after.durable.state).toEqual(frozen.state);
      // Storage-level fixture: current and frozen tuples must be pinned
      // independently, including when a frozen tuple names an old generation.
      // Lifecycle transitions themselves remain covered by the parent suite.
      await db`UPDATE mail.drafts SET doc_generation = 2, revision = revision + 1 WHERE id = ${created.id}::uuid`;
      await db`INSERT INTO mail.draft_document_revisions (draft_id, generation, revision, state, cursor)
        VALUES (${created.id}::uuid, 2, ${frozen.revision + 1}, ${Buffer.from(frozen.state)}, ${frozen.cursor})`;
      const pins = await db<{ generation: number; revision: number; state: Uint8Array }[]>`
        SELECT generation::int, revision::int, state FROM mail.draft_document_revisions
        WHERE draft_id = ${created.id}::uuid ORDER BY generation, revision
      `;
      expect(pins).toEqual([
        { generation: 1, revision: frozen.revision, state: frozen.state },
        { generation: 2, revision: frozen.revision + 1, state: frozen.state },
      ]);
    });
  });

  test("a published save failure remains pending, with separate fresh/durable states and replay-only recovery", async () => {
    const created = await draft();
    const base = await initial(created.id);
    const next = { ...created.content, body: "Retained despite failed save", subject: "Retained header" };
    const bytes = await createDraftRevisionUpdate(base.fresh.state, next, { deadline: deadline() });
    let published = "";
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      const broken = spyOn(locked.store, "save").mockRejectedValueOnce(new Error("Injected projection failure"));
      try {
        const result = value(await locked.accept({ generation: "1", baseCursor: base.fresh.cursor, update: bytes }));
        expect(result.status).toBe("pendingPersistence");
        if (result.status === "pendingPersistence") published = result.cursor;
      } finally {
        broken.mockRestore();
      }
    });
    const pending = await initial(created.id);
    expect(pending.fresh.content).toEqual(next);
    expect(pending.fresh.cursor).toBe(published);
    expect(pending.durable).toEqual(base.durable);
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      expect(value(await locked.project()).status).toBe("saved");
    });
    const recovered = await initial(created.id);
    expect(recovered.fresh).toEqual(recovered.durable);
    expect(recovered.durable.cursor).toBe(published);
    expect(recovered.revision).toBe(2);
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(published);
  });

  test("first-write rollback recovers from the deterministic seed without losing a published header/body", async () => {
    const created = await draft();
    let published = "";
    const next = { ...created.content, subject: "Header survives rollback", body: "Body survives rollback" };
    await expect(
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        const base = value(await locked.read());
        const bytes = await createDraftRevisionUpdate(base.fresh.state, next, { deadline: deadline() });
        const admitted = value(await locked.accept({ generation: "1", baseCursor: base.fresh.cursor, update: bytes }));
        if (admitted.status !== "accepted") throw new Error("Unexpected admission failure");
        published = admitted.cursor;
        throw new Error("Injected transaction rollback");
      }),
    ).rejects.toThrow("Injected transaction rollback");
    const pending = await initial(created.id);
    expect(pending.fresh.content).toEqual(next);
    expect(pending.durable.content).toEqual(created.content);
    expect(pending.fresh.cursor).toBe(published);
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      value(await locked.project());
    });
    expect((await initial(created.id)).durable.content).toEqual(next);
  });

  test("freeze holds the send row lock, records an exact base, and fences a waiting admission", async () => {
    const created = await draft();
    const base = await initial(created.id);
    const bytes = await createDraftRevisionUpdate(
      base.fresh.state,
      { ...created.content, body: "Late device text" },
      { deadline: deadline() },
    );
    const waiting: { late?: ReturnType<typeof acceptDraftDocumentUpdate> } = {};
    let marker = "";
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      // A separate connection proves this is a real Postgres row lock.
      await expect(
        sql.begin(async (other) => {
          await other`SET LOCAL lock_timeout = '100ms'`;
          await other`UPDATE mail.drafts SET subject = subject WHERE id = ${created.id}::uuid`;
        }),
      ).rejects.toThrow();
      waiting.late = acceptDraftDocumentUpdate({
        context: owner,
        mailboxId,
        draftId: created.id,
        generation: "1",
        baseCursor: base.fresh.cursor,
        update: bytes,
      });
      const frozen = value(await locked.freeze({ generation: "1" }));
      marker = frozen.cursor;
      expect(frozen.content).toEqual(created.content);
      expect(decode(frozen.state)).toEqual(created.content);
      expect((await locked.accept({ generation: "1", baseCursor: base.fresh.cursor, update: bytes })).ok).toBe(false);
      await db`UPDATE mail.drafts SET state = 'scheduled' WHERE id = ${created.id}::uuid`;
    });
    if (!waiting.late) throw new Error("Missing waiting admission");
    expect((await waiting.late).ok).toBe(false);
    const frozen = await initial(created.id);
    expect(frozen.frozen?.cursor).toBe(marker);
    expect(frozen.frozen?.state).toEqual(frozen.durable.state);
    expect(frozen.frozen?.generation).toBe("1");
    expect(frozen.frozen?.revision).toBe(frozen.revision);
    expect(frozen.fresh.content).toEqual(created.content);
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(marker);
    // Reopen is parent-owned; even after clearing the marker the old lineage
    // cannot enter the new generation.
    await sql`UPDATE mail.drafts SET state = 'draft', doc_generation = doc_generation + 1,
      doc_frozen_cursor = NULL, doc_frozen_state = NULL, doc_frozen_generation = NULL, doc_frozen_revision = NULL
      WHERE id = ${created.id}::uuid`;
    expect(
      (
        await acceptDraftDocumentUpdate({
          context: owner,
          mailboxId,
          draftId: created.id,
          generation: "1",
          baseCursor: base.fresh.cursor,
          update: bytes,
        })
      ).ok,
    ).toBe(false);
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBe(marker);
  });

  test("a rolled-back freeze marker is inert and later admission can project the same generation", async () => {
    const created = await draft();
    const base = await initial(created.id);
    await expect(
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        value(await locked.freeze({ generation: "1" }));
        throw new Error("Send transaction rolled back");
      }),
    ).rejects.toThrow("Send transaction rolled back");
    const current = await initial(created.id);
    expect(current.frozen).toBeNull();
    // The original offline base crosses the inert marker transparently.
    const accepted = value(await update(created.id, { ...created.content, body: "Still editable" }, base));
    expect(accepted.status).toBe("accepted");
    expect((await initial(created.id)).durable.content.body).toBe("Still editable");
    expect(base.generation).toBe(current.generation);
  });

  test("invalid tables remain recoverable content but cannot acquire a send marker", async () => {
    const created = await draft({ body: "| A | B |\n| --- | --- |\n| first | second | EXTRA MUST SURVIVE |" });
    const base = await initial(created.id);
    expect(base.durable.content.body).toContain("EXTRA MUST SURVIVE");
    await expect(
      sql.begin(async (db) => {
        const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
        await locked.freeze({ generation: "1" });
      }),
    ).rejects.toThrow("tables require review");
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
    expect((await initial(created.id)).durable.content.body).toBe(created.content.body);
  });

  test("a merged body beyond the public UTF-16 budget stays unconfirmed", async () => {
    const created = await draft({ body: "" });
    const base = await initial(created.id);
    const doc = new Y.Doc();
    let bytes: Uint8Array;
    try {
      Y.applyUpdate(doc, base.fresh.state);
      const vector = Y.encodeStateVector(doc);
      doc.getText("codemirror").insert(0, "x".repeat(2 * 1024 * 1024 + 1));
      bytes = Y.encodeStateAsUpdate(doc, vector);
    } finally {
      doc.destroy();
    }
    const admitted = value(
      await acceptDraftDocumentUpdate({
        context: owner,
        mailboxId,
        draftId: created.id,
        generation: "1",
        baseCursor: base.fresh.cursor,
        update: bytes,
      }),
    );
    expect(admitted.status).toBe("recoveryRequired");
    expect(await mailDraftDocumentLog.topic().latestCursor({ tenantId: created.id })).toBeNull();
    expect((await initial(created.id)).durable.content.body).toBe("");
  });

  test("attachment-only revisions get the exact unchanged base, and divergent SQL cannot masquerade as one", async () => {
    const created = await draft();
    const base = await initial(created.id);
    await sql.begin(async (db) => {
      const locked = value(await lockDraftDocumentInTransaction({ db, context: owner, mailboxId, draftId: created.id }));
      await db`UPDATE mail.drafts SET revision = revision + 1 WHERE id = ${created.id}::uuid`;
      expect(value(await locked.recordRevisionBase()).revision).toBe(2);
      expect(value(await locked.recordRevisionBase()).revision).toBe(2);
      const [exact] = await db<{ state: Uint8Array; cursor: string | null }[]>`
        SELECT state, cursor FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid AND revision = 2
      `;
      expect(exact?.state).toEqual(base.durable.state);
      expect(exact?.cursor).toBe(base.durable.cursor);
      await db`UPDATE mail.drafts SET revision = revision + 1, subject = 'Unlogged replacement' WHERE id = ${created.id}::uuid`;
      expect((await locked.recordRevisionBase()).ok).toBe(false);
      const [count] = await db<{ n: number }[]>`
        SELECT count(*)::int AS n FROM mail.draft_document_revisions WHERE draft_id = ${created.id}::uuid AND revision = 3
      `;
      expect(count?.n).toBe(0);
    });
  });

  test("attachment add/remove authenticate omitted-name SQL after lazy seeding without changing document identities", async () => {
    const recipients = {
      to: [{ address: "to@example.test" }],
      cc: [{ address: "cc@example.test" }],
      bcc: [{ address: "bcc@example.test" }],
    };
    const created = await draft({ recipients });
    const target = { context: owner, mailboxId, draftId: created.id };
    const bytes = Buffer.from(`Mail document attachment ${suffix}`);
    const upload = value(
      await createDraftAttachmentUpload({
        ...target,
        input: { filename: "document.txt", contentType: "text/plain", byteLength: bytes.length },
      }),
    );
    const [blob] = await sql<{ blob_id: string }[]>`
      SELECT blob_id FROM mail.draft_attachment_uploads WHERE id = ${upload.id}::uuid
    `;
    if (!blob) throw new Error("Missing attachment blob");
    blobs.push(blob.blob_id);
    value(await appendDraftAttachmentUpload({ ...target, uploadId: upload.id, offset: 0, bytes }));
    const [unseeded] = await sql<{ doc_state: Uint8Array | null; revision: number }[]>`
      SELECT doc_state, revision::int FROM mail.drafts WHERE id = ${created.id}::uuid
    `;
    expect(unseeded).toMatchObject({ doc_state: null, revision: 1 });

    // Finalization bumps the revision, then lazily seeds and records its base.
    const added = value(await finalizeDraftAttachmentUpload({ ...target, uploadId: upload.id, expectedRevision: 1 }));
    expect(added.revision).toBe(2);
    expect(added.attachments).toHaveLength(1);
    const attachment = added.attachments[0];
    if (!attachment) throw new Error("Missing finalized attachment");
    const seeded = await initial(created.id);
    expect(seeded.durable.content).toEqual({
      ...created.content,
      to: [{ address: "to@example.test", name: null }],
      cc: [{ address: "cc@example.test", name: null }],
      bcc: [{ address: "bcc@example.test", name: null }],
    });
    const [unchangedSQL] = await sql<{ to_addresses: unknown; cc_addresses: unknown; bcc_addresses: unknown }[]>`
      SELECT to_addresses, cc_addresses, bcc_addresses FROM mail.drafts WHERE id = ${created.id}::uuid
    `;
    expect(unchangedSQL).toEqual({ to_addresses: recipients.to, cc_addresses: recipients.cc, bcc_addresses: recipients.bcc });

    const removed = value(await removeDraftAttachment({ ...target, attachmentId: attachment.id, expectedRevision: 2 }));
    expect(removed.revision).toBe(3);
    expect(removed.attachments).toEqual([]);
    const current = await initial(created.id);
    expect(current.durable.state).toEqual(seeded.durable.state);
    expect(current.durable.cursor).toBe(seeded.durable.cursor);
    const bases = await sql<{ revision: number; state: Uint8Array; cursor: string | null }[]>`
      SELECT revision::int, state, cursor FROM mail.draft_document_revisions
      WHERE draft_id = ${created.id}::uuid AND generation = 1 ORDER BY revision
    `;
    expect(bases).toEqual([2, 3].map((revision) => ({ revision, state: seeded.durable.state, cursor: seeded.durable.cursor })));
  });
});
