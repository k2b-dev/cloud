import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { sha256Json } from "./canonical";
import type { ProjectionEnvelope } from "./connectors";
import { inspectMessage } from "./message-inspector";
import { listConversationMessages } from "./messages";
import { useRemoteChangesFixture } from "./remote-changes-fixture";
import { ingestEnvelope } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-19T12:00:00Z");
const envelope = (emailId: string, fields: Partial<Omit<ProjectionEnvelope, "remoteRef">> = {}): ProjectionEnvelope => ({
  remoteRef: { kind: "jmap", folderStableKey: "inbox:500", emailId },
  providerMessageId: null,
  providerThreadId: null,
  messageId: `<${emailId}@example.test>`,
  inReplyTo: null,
  references: [],
  subject: `Projection ${emailId}`,
  sentAt: at,
  internalDate: at,
  sizeBytes: 42,
  flags: [],
  labels: [],
  addresses: {
    from: [{ name: null, address: "sender@example.test" }],
    to: [{ name: null, address: "owner@example.test" }],
    cc: [],
    bcc: [],
    replyTo: [],
  },
  mimeStructure: { type: "text/plain", part: "1" },
  ...fields,
});

suite("JMAP addresses in the shared message projection", () => {
  const fixture = useRemoteChangesFixture("jmap-projection");
  type Source = Awaited<ReturnType<typeof connect>>;
  let shortId = 0;
  const nextShortId = () => `o2c${String(++shortId).padStart(3, "0")}`;
  beforeEach(() => {
    setSystemTime(at);
    createAppEventTestHarness("mail", mailCapabilities);
  });
  afterEach(async () => {
    try {
      // Outbox FKs restrict draft/identity deletion; remove these fixture rows before the shared teardown.
      for (const mailboxId of fixture.mailboxIds) {
        await sql`DELETE FROM mail.outbox_submissions WHERE mailbox_id = ${mailboxId}::uuid`;
      }
    } finally {
      setSystemTime();
    }
  });
  const connect = async (stage: string) => {
    const source = await fixture.connect(stage, false);
    const [resource] = await sql<{ remote_resource_id: string; binding_id: string }[]>`
      SELECT folder.remote_resource_id, ref.binding_id FROM mail.folders folder
      JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id WHERE folder.id = ${source.folderId("inbox")}::uuid
    `;
    if (!resource) throw new Error(`${stage}: resource/binding fixture missing`);
    return { ...source, resourceId: resource.remote_resource_id, bindingId: resource.binding_id };
  };
  const ingest = (source: Source, message: ProjectionEnvelope, folder: "inbox" | "archive" | "all" = "inbox", receive = false) =>
    source.track(() =>
      sql.begin(async (db) => {
        const [locked] = await db<{ id: string }[]>`SELECT id FROM mail.remote_resources WHERE id = ${source.resourceId}::uuid FOR UPDATE`;
        if (!locked) throw new Error("ingest/lock: resource missing");
        return ingestEnvelope({
          db,
          mailboxId: source.mailboxId,
          remoteResourceId: source.resourceId,
          folderId: source.folderId(folder),
          message,
          captureWorkflowTriggers: receive,
        });
      }),
    );
  const conversation = async (id: string) => {
    const [row] = await sql<
      { conversation_id: string }[]
    >`SELECT conversation_id FROM mail.conversation_messages WHERE message_id = ${id}::uuid`;
    if (!row) throw new Error("read/conversation: projection missing");
    return row.conversation_id;
  };
  const counts = async (source: Source) => {
    const [row] = await sql<{ contents: number; refs: number; placements: number; receipts: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mail.message_contents WHERE mailbox_id = ${source.mailboxId}::uuid) AS contents,
        (SELECT count(*)::int FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE folder.remote_resource_id = ${source.resourceId}::uuid) AS refs,
        (SELECT count(*)::int FROM mail.message_placements placement JOIN mail.folders folder ON folder.id = placement.folder_id WHERE folder.remote_resource_id = ${source.resourceId}::uuid AND placement.deleted_at IS NULL) AS placements,
        (SELECT count(*)::int FROM events.outbox event JOIN mail.message_contents content ON content.short_id = event.payload->'subject'->>'id'
          WHERE content.mailbox_id = ${source.mailboxId}::uuid AND event.app_id = 'mail' AND event.kind = 'event' AND event.payload->>'type' = 'mail.message.received') AS receipts
    `;
    if (!row) throw new Error("read/counts: aggregate missing");
    return row;
  };

  test("P1: replay and a second folder share one content and one receipt", async () => {
    const source = await connect("repeat");
    const message = envelope("email_repeat");
    const id = await ingest(source, message, "inbox", true);
    expect(await ingest(source, message, "inbox", true), "P1: replay identity").toBe(id);
    expect(await ingest(source, message, "archive", true), "P1: second membership identity").toBe(id);
    expect(await counts(source), "P1: one projection and receipt").toEqual({ contents: 1, refs: 2, placements: 2, receipts: 1 });
    expect(
      await sql<{ remote_id: string; uid: string | null; uid_validity: string | null; modseq: string | null; connector_ref: unknown }[]>`
      SELECT remote_id, uid::text, uid_validity::text, modseq::text, connector_ref FROM mail.remote_message_refs WHERE message_id = ${id}::uuid
    `,
      "P1: only opaque locators, no providerMessageId",
    ).toEqual([
      { remote_id: "email_repeat", uid: null, uid_validity: null, modseq: null, connector_ref: {} },
      { remote_id: "email_repeat", uid: null, uid_validity: null, modseq: null, connector_ref: {} },
    ]);
  });

  test("P2: same-folder stale references reactivate and stale account copies are reused", async () => {
    const source = await connect("stale");
    const message = envelope("email_stale");
    const id = await ingest(source, message);
    const [ref] = await sql<
      { id: string }[]
    >`UPDATE mail.remote_message_refs SET stale_at = ${at}, last_seen_at = '-infinity'::timestamptz WHERE message_id = ${id}::uuid RETURNING id`;
    if (!ref) throw new Error("P2: reference missing");
    await sql`UPDATE mail.message_placements SET deleted_at = ${at} WHERE message_id = ${id}::uuid`;
    expect(await ingest(source, message, "archive"), "P2: account lookup includes stale").toBe(id);
    expect(await ingest(source, { ...message, flags: ["\\Seen"], labels: ["Updated"] }), "P2: local lookup includes stale").toBe(id);
    expect(
      await sql<{ stale_at: Date | null; seen: boolean; deleted_at: Date | null; flags: string[]; keywords: string[] }[]>`
      SELECT ref.stale_at, isfinite(ref.last_seen_at) AS seen, placement.deleted_at, placement.flags, placement.keywords
      FROM mail.remote_message_refs ref JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id WHERE ref.id = ${ref.id}::uuid
    `,
      "P2: same ref active with new flags",
    ).toEqual([{ stale_at: null, seen: true, deleted_at: null, flags: ["\\Seen"], keywords: ["Updated"] }]);
  });

  test("P3: concurrent ingests serialize on the resource and preserve both memberships", async () => {
    const source = await connect("parallel");
    const results = await Promise.allSettled([
      ingest(source, envelope("email_parallel")),
      ingest(source, envelope("email_parallel")),
      ingest(source, envelope("email_parallel"), "archive"),
    ]);
    const ids = results.map((result) => {
      if (result.status === "rejected") throw new Error("P3: concurrent ingest failed", { cause: result.reason });
      return result.value;
    });
    expect(new Set(ids).size, "P3: one identity").toBe(1);
    expect(await counts(source), "P3: no orphan content or duplicate refs").toEqual({ contents: 1, refs: 2, placements: 2, receipts: 0 });
  });

  test("P4: the same Email ID in different resources has independent content", async () => {
    const first = await connect("resource-a");
    const second = await connect("resource-b");
    const message = envelope("email_shared");
    const a = await ingest(first, message);
    const b = await ingest(second, message);
    expect(a, "P4: resource-scoped identity").not.toBe(b);
    const hashes = await sql<
      { content_hash: string }[]
    >`SELECT content_hash FROM mail.message_contents WHERE id IN (${a}::uuid, ${b}::uuid)`;
    expect(new Set(hashes.map((row) => row.content_hash)).size, "P4: resource-scoped hash").toBe(2);
  });

  test("P5: different Email IDs with identical MIME metadata never use the IMAP heuristic", async () => {
    const source = await connect("same-mime");
    const first = envelope("email_one");
    const second = {
      ...first,
      remoteRef: { kind: "jmap", folderStableKey: "inbox:500", emailId: "email_two" },
    } satisfies ProjectionEnvelope;
    expect(await ingest(source, first), "P5: separate copies").not.toBe(await ingest(source, second));
    expect(await counts(source), "P5: two contents").toEqual({ contents: 2, refs: 2, placements: 2, receipts: 0 });
  });

  test("P6: conflicting account identity fails explicitly and rolls back earlier projection writes", async () => {
    const source = await connect("conflict");
    const a = await ingest(source, envelope("email_conflict"));
    const b = await ingest(source, envelope("email_other"), "archive");
    // The schema permits two folder-local refs; the account lookup must detect different contents.
    await sql`UPDATE mail.remote_message_refs SET remote_id = 'email_conflict' WHERE message_id = ${b}::uuid`;
    const before = await counts(source);
    await expect(
      source.track(() =>
        sql.begin(async (db) => {
          await db`SELECT id FROM mail.remote_resources WHERE id = ${source.resourceId}::uuid FOR UPDATE`;
          await ingestEnvelope({
            db,
            mailboxId: source.mailboxId,
            remoteResourceId: source.resourceId,
            folderId: source.folderId("inbox"),
            message: envelope("email_rollback"),
            captureWorkflowTriggers: true,
          });
          await ingestEnvelope({
            db,
            mailboxId: source.mailboxId,
            remoteResourceId: source.resourceId,
            folderId: source.folderId("all"),
            message: envelope("email_conflict"),
          });
        }),
      ),
      "P6: explicit identity error",
    ).rejects.toMatchObject({ code: "JMAP_MESSAGE_IDENTITY_CONFLICT" });
    expect(await counts(source), "P6: content, ref, placement and receipt rollback").toEqual(before);
    expect(a, "P6: fixture has distinct conflicting contents").not.toBe(b);
  });

  test("P7: the message list and inspector read the JMAP projection", async () => {
    const source = await connect("readers");
    const id = await ingest(source, envelope("email_readers"));
    const listed = await listConversationMessages({
      context: fixture.ownerContext,
      mailboxId: source.mailboxId,
      conversationId: await conversation(id),
    });
    if (!listed.ok) throw new Error(`P7/list: ${listed.error.message}`);
    expect(
      listed.data.items.map((item) => item.id),
      "P7: message listed",
    ).toEqual([id]);
    const inspected = await inspectMessage({ context: fixture.ownerContext, mailboxId: source.mailboxId, messageId: id });
    if (!inspected.ok) throw new Error(`P7/inspect: ${inspected.error.message}`);
    expect(inspected.data.placements, "P7: one placement").toHaveLength(1);
    expect(inspected.data.placements[0], "P7: opaque locator exposed").toMatchObject({ remoteId: "email_readers" });
    expect(inspected.data.placements[0], "P7: no invented UID").not.toHaveProperty("uid");
  });

  test("P8: provider thread candidates retain the existing participant admission", async () => {
    const source = await connect("threads");
    const first = await ingest(source, envelope("email_thread_a", { providerThreadId: "Thread_Exact-42" }));
    const related = await ingest(source, envelope("email_thread_b", { providerThreadId: "Thread_Exact-42" }));
    const unrelated = await ingest(
      source,
      envelope("email_thread_c", {
        providerThreadId: "Thread_Exact-42",
        addresses: {
          from: [{ name: null, address: "stranger@example.test" }],
          to: [{ name: null, address: "owner@example.test" }],
          cc: [],
          bcc: [],
          replyTo: [],
        },
      }),
    );
    expect(await conversation(related), "P8: known participant admitted").toBe(await conversation(first));
    expect(await conversation(unrelated), "P8: unknown participant rejected").not.toBe(await conversation(first));
    expect(
      await sql<{ provider_thread_id: string }[]>`SELECT provider_thread_id FROM mail.message_contents WHERE id = ${first}::uuid`,
      "P8: exact thread ID",
    ).toEqual([{ provider_thread_id: "Thread_Exact-42" }]);
  });

  const outbox = async (source: Source, stableMessageId: string) => {
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, status)
      VALUES (${nextShortId()}, ${source.mailboxId}::uuid, 'Fixture sender', 'own@example.test', 'verified') RETURNING id`;
    if (!identity) throw new Error("outbox/identity: insert returned no row");
    const [draft] = await sql<
      { id: string }[]
    >`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind, edit_mode)
      VALUES (${nextShortId()}, ${source.mailboxId}::uuid, ${identity.id}::uuid, 'system', 'system', 'lock') RETURNING id`;
    if (!draft) throw new Error("outbox/draft: insert returned no row");
    const [command] = await sql<
      { id: string }[]
    >`INSERT INTO mail.commands (mailbox_id, kind, state, actor_kind, access_subject_kind, idempotency_key, request_hash, target, payload)
      VALUES (${source.mailboxId}::uuid, 'send', 'confirmed', 'system', 'system', ${draft.id}, ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb) RETURNING id`;
    if (!command) throw new Error("outbox/command: insert returned no row");
    const [content] = await sql<
      { id: string }[]
    >`INSERT INTO mail.message_contents (short_id, mailbox_id, message_id, subject, internal_date, content_hash)
      VALUES (${nextShortId()}, ${source.mailboxId}::uuid, ${stableMessageId}, 'Local send', ${at}, ${sha256Json({ draftId: draft.id })}) RETURNING id`;
    if (!content) throw new Error("outbox/content: insert returned no row");
    await sql`INSERT INTO mail.outbox_submissions (short_id, mailbox_id, draft_id, command_id, sender_identity_id, selected_binding_id, stable_message_id, state, requested_at, mime_date, message_id)
      VALUES (${nextShortId()}, ${source.mailboxId}::uuid, ${draft.id}::uuid, ${command.id}::uuid, ${identity.id}::uuid, ${source.bindingId}::uuid,
        ${stableMessageId}, 'sent', ${at}, ${at}, ${content.id}::uuid)`;
    return content.id;
  };
  const own = (emailId: string, messageId: string) =>
    envelope(emailId, {
      messageId,
      addresses: {
        from: [{ name: null, address: "own@example.test" }],
        to: [{ name: null, address: "recipient@example.test" }],
        cc: [],
        bcc: [],
        replyTo: [],
      },
    });

  test("P9: unique exact outbox evidence reuses local content, but a second Email ID does not", async () => {
    const source = await connect("outbox-unique");
    const stableId = "<outbox-unique@example.test>";
    const local = await outbox(source, stableId);
    expect(await ingest(source, own("email_sent", stableId), "inbox", true), "P9: unique evidence").toBe(local);
    expect(await ingest(source, own("email_sent", stableId), "archive", true), "P9: known ID wins").toBe(local);
    await sql`UPDATE mail.remote_message_refs SET stale_at = ${at} WHERE message_id = ${local}::uuid`;
    expect(await ingest(source, own("email_sent_copy", stableId)), "P9: stale foreign JMAP ID still excludes reuse").not.toBe(local);
    expect((await counts(source)).receipts, "P9: own mail emits no receipt").toBe(0);
  });

  test("P10: normalized outbox ambiguity never picks the newest submission", async () => {
    const source = await connect("outbox-ambiguous");
    const a = await outbox(source, "<ambiguous@example.test>");
    // The raw UNIQUE key allows these two strings; the exact lookup normalizes case and surrounding spaces.
    const b = await outbox(source, " <AMBIGUOUS@example.test> ");
    const id = await ingest(source, own("email_ambiguous", "<ambiguous@example.test>"));
    expect(id, "P10: no first candidate").not.toBe(a);
    expect(id, "P10: no second candidate").not.toBe(b);
  });

  test("P11: incoming and mixed From headers cannot claim an outbox content", async () => {
    const source = await connect("outbox-from");
    const stableId = "<outbox-from@example.test>";
    const local = await outbox(source, stableId);
    expect(await ingest(source, envelope("email_incoming", { messageId: stableId })), "P11: foreign From").not.toBe(local);
    const mixed = own("email_mixed", stableId);
    mixed.addresses.from.push({ name: null, address: "stranger@example.test" });
    expect(await ingest(source, mixed), "P11: every sender must be ours").not.toBe(local);
  });
});
