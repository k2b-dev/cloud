import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import type { User } from "@k2b/cloud/contracts";
import { unwrap } from "@k2b/stdlib";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { applyConversationAssignments, applyConversationCompletions } from "./collaboration";
import type { ConnectorEnvelope } from "./connectors";
import { createMailbox } from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats");
const contextFor = (user: User): MailRequestContext => ({
  actor: { kind: "user", user },
  accessSubject: { type: "user", userId: user.id },
  requestId: `completion-${user.id}`,
});

suite("batch conversation completion", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const mailboxIds: string[] = [];
  const userIds: string[] = [];
  let owner: User;
  let writer: User;
  let reader: User;
  let outsider: User;
  let mailboxId = "";
  let otherMailboxId = "";
  let remoteResourceId = "";
  let folderId = "";
  let uid = 0;

  const createUser = async (role: string): Promise<User> => {
    const uid = `mail-completion-${role}-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', ${role}, false) RETURNING id
    `;
    if (!row) throw new Error("User fixture missing");
    userIds.push(row.id);
    return {
      id: row.id,
      uid,
      roles: ["user"],
      provider: "local",
      profile: "user",
      givenname: role,
      sn: "Test",
      displayName: role,
      mail: `${uid}@example.test`,
      avatarHash: null,
      ipa: null,
      accountExpires: null,
      lastLoginLocal: null,
      memberofGroup: [],
      memberofGroupIds: [],
      manages: [],
      managesGroupIds: [],
    };
  };

  beforeAll(async () => {
    await migrate();
    owner = await createUser("owner");
    writer = await createUser("writer");
    reader = await createUser("reader");
    outsider = await createUser("outsider");
    mailboxId = unwrap(await createMailbox(contextFor(owner), { name: `Completion ${suffix}` })).id;
    mailboxIds.push(mailboxId);
    otherMailboxId = unwrap(await createMailbox(contextFor(owner), { name: `Other completion ${suffix}` })).id;
    mailboxIds.push(otherMailboxId);
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: writer.id },
        permission: "write",
        scope: "assigned",
      }),
    );
    unwrap(
      await grantMailboxAccess({
        context: contextFor(owner),
        mailboxId,
        principal: { type: "user", userId: reader.id },
        permission: "read",
      }),
    );
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"c".repeat(64)}, 'active') RETURNING id
    `;
    if (!resource) throw new Error("Resource fixture missing");
    remoteResourceId = resource.id;
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${remoteResourceId}::uuid, ${`completion-${suffix}`}, 'Inbox', 'inbox', 'current') RETURNING id
    `;
    if (!folder) throw new Error("Folder fixture missing");
    folderId = folder.id;
  });

  afterAll(async () => {
    const accessIds: string[] = [];
    const blobIds: string[] = [];
    for (const id of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`
        SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${id}::uuid
        UNION ALL
        SELECT access_id FROM mail.mailbox_assigned_access WHERE mailbox_id = ${id}::uuid
      `;
      accessIds.push(...access.map((row) => row.access_id));
      const blobs = await sql<{ source_blob_id: string }[]>`
        SELECT source_blob_id FROM mail.message_contents WHERE mailbox_id = ${id}::uuid AND source_blob_id IS NOT NULL
      `;
      blobIds.push(...blobs.map((row) => row.source_blob_id));
      await sql`DELETE FROM mail.mailboxes WHERE id = ${id}::uuid`;
    }
    if (blobIds.length > 0)
      await sql`DELETE FROM mail.message_part_blobs WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${blobIds}::jsonb))`;
    if (accessIds.length > 0)
      await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    if (userIds.length > 0)
      await sql`DELETE FROM auth.users WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${userIds}::jsonb))`;
  });

  const hydrate = async (messageId: string, externalId: string, subject: string) => {
    const source = Buffer.from(
      [
        `Message-ID: ${externalId}`,
        `Subject: ${subject}`,
        "From: customer@example.test",
        "To: support@example.test",
        "Date: Thu, 01 Oct 2026 10:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Completion test body",
      ].join("\r\n"),
    );
    await hydrateMessageFromSource({ messageId, source: Readable.from([source]), expectedSize: source.byteLength });
  };
  const conversation = async (hydrated = true) => {
    const index = ++uid;
    const externalId = `<completion-${suffix}-${index}@example.test>`;
    const subject = `Completion ${suffix} ${index}`;
    const message: ConnectorEnvelope = {
      remoteRef: { folderStableKey: `completion-${suffix}`, uidValidity: "1", uid: String(index), modseq: null },
      providerMessageId: null,
      providerThreadId: null,
      messageId: externalId,
      inReplyTo: null,
      references: [],
      protocolFacts: { ...EMPTY_MESSAGE_PROTOCOL_FACTS, returnPath: "<customer@example.test>", contentType: "text/plain; charset=utf-8" },
      subject,
      sentAt: new Date("2026-10-01T10:00:00.000Z"),
      internalDate: new Date("2026-10-01T10:00:00.000Z"),
      sizeBytes: 256,
      flags: [],
      labels: [],
      mimeStructure: {},
      addresses: {
        from: [{ name: null, address: "customer@example.test" }],
        to: [{ name: null, address: "support@example.test" }],
        replyTo: [],
        cc: [],
        bcc: [],
      },
    };
    const messageId = await ingestEnvelope({ db: sql, mailboxId, remoteResourceId, folderId, message });
    if (hydrated) await hydrate(messageId, externalId, subject);
    const [row] = await sql<{ id: string; short_id: string; revision: number }[]>`
      SELECT c.id, c.short_id, c.revision::int AS revision FROM mail.conversations c
      JOIN mail.conversation_messages link ON link.conversation_id = c.id WHERE link.message_id = ${messageId}::uuid
    `;
    if (!row) throw new Error("Conversation fixture missing");
    return { ...row, messageId, externalId, subject };
  };
  const complete = (conversationIds: string[], completion: "done" | "open", user = owner) =>
    applyConversationCompletions({ context: contextFor(user), mailboxId, conversationIds, completion });
  const activities = (id: string) => sql<{ id: string }[]>`
    SELECT id FROM mail.activity_events WHERE conversation_id = ${id}::uuid AND action = 'conversation.collaboration_updated'
  `;
  const state = async (id: string) => {
    const [row] = await sql<{ work_status: string; revision: number }[]>`
      SELECT work_status, revision::int AS revision FROM mail.conversations WHERE id = ${id}::uuid
    `;
    return row;
  };

  test("done covers every link, including an unhydrated message; retries are silent and reopen derives inbound status", async () => {
    const first = await conversation();
    const second = await conversation();
    const pending = await conversation(false);
    const ordered = [pending, first, second];
    const ids = ordered.map((row) => row.short_id);
    const done = unwrap(await complete(ids, "done"));
    expect(done).toEqual({
      completion: "done",
      results: ordered.map((row) => ({
        conversationId: row.short_id,
        status: "ok",
        workStatus: "done",
        revision: row.revision + 1,
      })),
    });
    for (const row of ordered) expect(await activities(row.id)).toHaveLength(1);
    const [link] = await sql<{ status_covered: boolean | null }[]>`
      SELECT status_covered FROM mail.conversation_messages WHERE message_id = ${pending.messageId}::uuid
    `;
    expect(link?.status_covered).toBe(true);
    await hydrate(pending.messageId, pending.externalId, pending.subject);
    expect(await state(pending.id)).toEqual({ work_status: "done", revision: pending.revision + 1 });
    const reconciled = await sql<{ id: string }[]>`
      SELECT id FROM mail.activity_events WHERE conversation_id = ${pending.id}::uuid
        AND action = 'conversation.work_state_changed' AND outcome = 'reconciled'
    `;
    expect(reconciled).toHaveLength(0);
    expect(unwrap(await complete(ids, "done"))).toEqual(done);
    for (const row of ordered) expect(await activities(row.id)).toHaveLength(1);
    const reopened = unwrap(await complete(ids, "open"));
    expect(reopened).toEqual({
      completion: "open",
      results: ordered.map((row) => ({
        conversationId: row.short_id,
        status: "ok",
        workStatus: "needs_action",
        revision: row.revision + 2,
      })),
    });
    for (const row of ordered) expect(await activities(row.id)).toHaveLength(2);
    expect(unwrap(await complete(ids, "open"))).toEqual(reopened);
    for (const row of ordered) expect(await activities(row.id)).toHaveLength(2);
  });

  test("foreign and missing ids report not_found while valid ids are applied in request order", async () => {
    const own = await conversation();
    const foreign = newShortId();
    const missing = newShortId();
    await sql`INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${foreign}, ${otherMailboxId}::uuid, 'Other', 'Customer', '2026-10-01T10:00:00Z')`;
    expect(unwrap(await complete([foreign, own.short_id, missing], "done"))).toEqual({
      completion: "done",
      results: [
        { conversationId: foreign, status: "not_found" },
        { conversationId: own.short_id, status: "ok", workStatus: "done", revision: own.revision + 1 },
        { conversationId: missing, status: "not_found" },
      ],
    });
    const [unchanged] = await sql<{ work_status: string }[]>`SELECT work_status FROM mail.conversations WHERE short_id = ${foreign}`;
    expect(unchanged?.work_status).toBe("needs_action");
  });

  test("rejects zero and 51 ids and refuses callers without write access for the whole request", async () => {
    for (const ids of [[], Array.from({ length: 51 }, () => newShortId())]) {
      const result = await complete(ids, "done");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("BAD_INPUT");
    }
    const own = await conversation();
    for (const user of [outsider, reader]) {
      const result = await complete([own.short_id], "done", user);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.status).toBe(403);
    }
    expect(await state(own.id)).toEqual({ work_status: "needs_action", revision: own.revision });
    expect(await activities(own.id)).toHaveLength(0);
  });

  test("assigned-only writers can complete their conversation; invisible ids look missing and remain unchanged", async () => {
    const assigned = await conversation();
    const hidden = await conversation();
    unwrap(
      await applyConversationAssignments({
        context: contextFor(owner),
        mailboxId,
        conversationIds: [assigned.short_id],
        assigneeUserIds: [writer.id],
        mode: "add",
      }),
    );
    const before = await state(assigned.id);
    expect(unwrap(await complete([hidden.short_id, assigned.short_id], "done", writer))).toEqual({
      completion: "done",
      results: [
        { conversationId: hidden.short_id, status: "not_found" },
        { conversationId: assigned.short_id, status: "ok", workStatus: "done", revision: before!.revision + 1 },
      ],
    });
    expect(await state(hidden.id)).toEqual({ work_status: "needs_action", revision: hidden.revision });
    expect(await activities(hidden.id)).toHaveLength(0);
    const reopened = unwrap(await complete([assigned.short_id], "open", writer));
    expect(reopened.results).toEqual([
      { conversationId: assigned.short_id, status: "ok", workStatus: "needs_action", revision: before!.revision + 2 },
    ]);
  });
});
