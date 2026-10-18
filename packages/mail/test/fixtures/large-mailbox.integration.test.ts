import { afterAll, beforeAll, expect, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "bun";
import { z } from "zod";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import type { MailRequestContext } from "../../src/service/auth";
import { createMailbox } from "../../src/service/mailboxes";
import { hydrateMessageFromSource } from "../../src/service/message-hydration";
import { getConversationViewCounts, listConversations, listFolders } from "../../src/service/messages";
import { ingestEnvelope } from "../../src/service/sync-runtime";
import { anchor, planLargeMailbox, seedLargeMailbox } from "./large-mailbox";

const suite = suiteFor("database", "nats", "valkey");
const mailboxIds: string[] = [],
  accessIds: string[] = [],
  blobIds: string[] = [];
let userId: string, context: MailRequestContext;
const jsonRow = z.record(z.string(), z.json());

// Outboxes, queues and audit rows are effects, not persisted mailbox read state.
const exclusions: Record<string, string> = {
  activity_events: "Audit history records actions; the fixture directly seeds final read state.",
  live_invalidations: "Legacy live queue; fixture setup does not emit user-visible changes.",
  hydration_jobs: "Work queue; fixture bodies are already complete.",
  workflow_events: "Workflow outbox; no automations run during fixture setup.",
};
async function snapshot() {
  const tables = await sql<{ table_name: string; keys: string[] }[]>`SELECT t.table_name,
    coalesce((SELECT array_agg(a.attname ORDER BY k.ordinality) FROM pg_index i
      CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
      JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
      WHERE i.indrelid=('mail.' || t.table_name)::regclass AND i.indisprimary), ARRAY[]::name[])::text[] AS keys
    FROM information_schema.tables t WHERE t.table_schema='mail' AND t.table_type='BASE TABLE' ORDER BY t.table_name`;
  const output = new Map<string, Map<string, z.infer<typeof jsonRow>>>();
  for (const { table_name, keys } of tables) {
    // Names come exclusively from Postgres metadata; quote even those identifiers.
    const table = `mail."${table_name.replaceAll('"', '""')}"`;
    const rows = await sql.unsafe<{ data: unknown }[]>(`SELECT to_jsonb(t) AS data FROM ${table} t`);
    const entries = rows.map(({ data }) => {
      const row = jsonRow.parse(data);
      return [JSON.stringify(keys.length ? keys.map((k) => row[k]) : row), row] as const;
    });
    output.set(table_name, new Map(entries));
  }
  return output;
}
function gained(before: Awaited<ReturnType<typeof snapshot>>, after: Awaited<ReturnType<typeof snapshot>>) {
  return new Map(
    [...after].flatMap(([table, rows]) => {
      const added = [...rows].filter(([key]) => !before.get(table)?.has(key)).map(([, row]) => row);
      return added.length ? [[table, added] as const] : [];
    }),
  );
}
async function mailbox(name: string) {
  const result = await createMailbox(context, { name, description: "Disposable scale fixture" });
  if (!result.ok) throw new Error(result.error.message);
  mailboxIds.push(result.data.id);
  return result.data.id;
}

suite("large mailbox fixture persistence", () => {
  beforeAll(async () => {
    const uid = `fixture-parity-${crypto.randomUUID()}`;
    const [user] = await sql<
      { id: string }[]
    >`INSERT INTO auth.users (uid,provider,profile,display_name,admin) VALUES (${uid},'local','user','Fixture reader',true) RETURNING id`;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Fixture reader",
          givenname: "Fixture",
          sn: "Reader",
          mail: "perf@example.test",
          avatarHash: null,
          roles: ["admin", "user"],
          ipa: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId },
    };
  });
  afterAll(async () => {
    for (const id of mailboxIds) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id=${id}::uuid`;
      accessIds.push(...access.map((a) => a.access_id));
      const blobs = await sql<
        { id: string }[]
      >`SELECT DISTINCT source_blob_id AS id FROM mail.message_contents WHERE mailbox_id=${id}::uuid AND source_blob_id IS NOT NULL
        UNION SELECT DISTINCT p.blob_id AS id FROM mail.message_parts p JOIN mail.message_contents m ON m.id=p.message_id WHERE m.mailbox_id=${id}::uuid AND p.blob_id IS NOT NULL`;
      blobIds.push(...blobs.map((b) => b.id));
      await sql`DELETE FROM mail.mailboxes WHERE id=${id}::uuid`;
    }
    if (accessIds.length) await sql`DELETE FROM auth.access WHERE id IN ${sql(accessIds)}`;
    // Blobs may be deduplicated with another test's rows. Never remove a referenced blob.
    if (blobIds.length)
      await sql`DELETE FROM mail.message_part_blobs b WHERE b.id IN ${sql(blobIds)}
      AND NOT EXISTS(SELECT 1 FROM mail.message_contents m WHERE m.source_blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM mail.message_parts p WHERE p.blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM mail.attachments a WHERE a.blob_id=b.id)
      AND NOT EXISTS(SELECT 1 FROM mail.draft_attachments a WHERE a.blob_id=b.id)`;
    if (userId) await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
  }, 30000);
  test("real folder, conversation and view reads agree with the declared shape", async () => {
    const id = await mailbox("Scale shape");
    const plan = planLargeMailbox({ seed: 20261001, anchor, messages: 600, conversations: 120, folders: 6 });
    await seedLargeMailbox(sql, plan, { mailboxId: id, userIds: [userId] });
    const folders = await listFolders(context, id);
    expect(folders.ok).toBe(true);
    if (!folders.ok) throw new Error(folders.error.message);
    expect(folders.data).toHaveLength(6);
    const ids = await sql<
      { id: string; short_id: string }[]
    >`SELECT f.id,f.short_id FROM mail.folders f JOIN mail.remote_resources r ON r.id=f.remote_resource_id WHERE r.mailbox_id=${id}::uuid`;
    const byUuid = new Map(ids.map((f) => [f.id, f.short_id]));
    let unread = 0,
      total = 0,
      unreadConversations = 0;
    for (const folder of folders.data) {
      const declared = plan.shape.totals[byUuid.get(folder.id)!]!;
      expect(folder.total).toBe(declared.total);
      expect(folder.unread).toBe(declared.unread);
      total += folder.total;
      unread += folder.unread;
      let cursor: string | undefined,
        conversations = 0;
      do {
        const result = await listConversations({ context, mailboxId: id, folderId: folder.id, cursor, limit: 50 });
        if (!result.ok) throw new Error(result.error.message);
        conversations += result.data.items.length;
        unreadConversations += result.data.items.filter((item) => item.unread).length;
        cursor = result.data.nextCursor ?? undefined;
      } while (cursor);
      expect(conversations).toBe(declared.conversations);
    }
    expect(total).toBe(plan.shape.messages);
    expect(unread).toBe(plan.shape.unread);
    expect(unreadConversations).toBe(plan.shape.unreadConversations);
    const counts = await getConversationViewCounts({ context, mailboxId: id });
    if (!counts.ok) throw new Error(counts.error.message);
    expect(counts.data.recently_active).toBe(plan.conversations.length);
    const follows = plan.conversations.filter((c) => !["trash", "junk"].includes(plan.folders[c.folder]!.role));
    expect(counts.data.needs_action).toBe(follows.filter((c) => c.status === "needs_action" && !c.snoozedUntil).length);
    expect(counts.data.waiting).toBe(follows.filter((c) => c.status === "waiting" && !c.snoozedUntil).length);
    expect(counts.data.snoozed).toBe(follows.filter((c) => c.snoozedUntil).length);
    expect(counts.data.done).toBe(plan.conversations.filter((c) => c.status === "done").length);
  }, 30000);
  test("fixture covers every persisted ingest/hydration table and non-null column", async () => {
    const ingestedMailbox = await mailbox("Ingest parity");
    const setup = planLargeMailbox({ seed: 17, anchor, messages: 1, conversations: 1, folders: 6 });
    const boundary = await seedLargeMailbox(sql, setup, { mailboxId: ingestedMailbox, userIds: [userId] });
    const before = await snapshot();
    const date = new Date("2026-09-30T23:00:00Z"),
      messageHeader = "<fixture-ingest-parity@example.test>";
    const messageId = await sql.begin((tx) =>
      ingestEnvelope({
        db: tx,
        mailboxId: ingestedMailbox,
        remoteResourceId: boundary.remoteResourceId,
        folderId: boundary.inboxId,
        captureWorkflowTriggers: false,
        message: {
          remoteRef: { folderStableKey: "perf-folder-0", uidValidity: "1", uid: "900000", modseq: "1" },
          providerMessageId: null,
          providerThreadId: null,
          messageId: messageHeader,
          inReplyTo: null,
          references: [],
          subject: "Hydration parity",
          sentAt: date,
          internalDate: date,
          sizeBytes: 2048,
          flags: [],
          labels: [],
          mimeStructure: {},
          addresses: {
            from: [{ name: "Customer", address: "customer@example.test" }],
            to: [{ name: "Performance", address: "perf@example.test" }],
            cc: [],
            bcc: [],
            replyTo: [],
          },
        },
      }),
    );
    const source = Buffer.from(
      [
        `Message-ID: ${messageHeader}`,
        `Date: ${date.toUTCString()}`,
        "From: Customer <customer@example.test>",
        "To: Performance <perf@example.test>",
        "Subject: Hydration parity",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="parity"',
        "",
        "--parity",
        "Content-Type: text/html; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        "<p>HTML parity body with an attachment.</p>",
        "--parity",
        'Content-Type: text/plain; name="report.txt"',
        'Content-Disposition: attachment; filename="report.txt"',
        "Content-Transfer-Encoding: 7bit",
        "",
        "Report attachment",
        "--parity--",
        "",
      ].join("\r\n"),
    );
    await hydrateMessageFromSource({ messageId, source: Readable.from([source]), expectedSize: source.length });
    const ingestRows = gained(before, await snapshot());
    expect(ingestRows.has("message_contents")).toBe(true);
    expect(ingestRows.has("attachments")).toBe(true);
    expect(ingestRows.has("message_parts")).toBe(true);
    const fixtureMailbox = await mailbox("Seed parity");
    const beforeSeed = await snapshot();
    await seedLargeMailbox(sql, planLargeMailbox({ seed: 118, anchor, messages: 600, conversations: 120, folders: 6 }), {
      mailboxId: fixtureMailbox,
      userIds: [userId],
    });
    const fixtureRows = gained(beforeSeed, await snapshot());
    for (const [table, rows] of ingestRows) {
      if (exclusions[table]) continue;
      const seeded = fixtureRows.get(table);
      expect(seeded, `Missing fixture table mail.${table}`).toBeDefined();
      const columns = new Set(
        rows.flatMap((row) =>
          Object.entries(row)
            .filter(([, v]) => v !== null)
            .map(([key]) => key),
        ),
      );
      for (const column of columns)
        expect(
          seeded?.some((row) => row[column] !== undefined && row[column] !== null),
          `Fixture lacks non-null mail.${table}.${column}`,
        ).toBe(true);
    }
  }, 30000);
});
