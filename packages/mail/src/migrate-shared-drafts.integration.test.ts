import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import type { Result } from "@k2b/stdlib";
import { meterSql } from "../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
import { draftContentInputSchema } from "./contracts";
import { newShortId } from "./lib/short-id";
import { migrate } from "./migrate";
import { migrateSharedDrafts, SHARED_DRAFTS_BATCH_SIZE, SHARED_DRAFTS_MIGRATION_VERSION } from "./migrate-shared-drafts";
import type { MailRequestContext } from "./service/auth";
import { stopDraftDocumentPruning } from "./service/draft-document-log";
import { migrateDraftDocumentLogPolicy, sharedDraftsSupported } from "./service/draft-document-log-policy";
import { readDraftDocument } from "./service/draft-documents";
import * as editModes from "./service/draft-edit-mode";
import { createDraft } from "./service/drafts";
import { createMailbox, updateMailbox } from "./service/mailboxes";

const suite = suiteFor("database", "nats");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};

suite("shared drafts default upgrade", () => {
  let context: MailRequestContext;
  let userId: string;
  beforeAll(async () => {
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users (uid, provider, profile, display_name, mail)
      VALUES ('shared-default-upgrade', 'local', 'user', 'Upgrade owner', 'upgrade@example.test') RETURNING id`;
    if (!user) throw new Error("Missing upgrade owner");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid: "shared-default-upgrade",
          provider: "local",
          profile: "user",
          roles: ["user"],
          displayName: "Upgrade owner",
          givenname: "Upgrade",
          sn: "Owner",
          mail: "upgrade@example.test",
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
  });
  afterEach(async () => {
    // This file owns the preload's private database, which is dropped after the file.
    await sql`TRUNCATE mail.mailboxes CASCADE`.simple();
    await sql`DELETE FROM mail.schema_migrations WHERE version = ${SHARED_DRAFTS_MIGRATION_VERSION}`;
  });
  afterAll(async () => {
    await stopDraftDocumentPruning();
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  const marker = () => sql`SELECT * FROM mail.schema_migrations WHERE version = ${SHARED_DRAFTS_MIGRATION_VERSION}`;
  const mailbox = async () => value(await createMailbox(context, { name: "Upgrade mailbox" }));
  const draft = async (mailboxId: string) => {
    const [sender] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Sender', 'Sender', 'sender@example.test', 'disabled', 'verified') RETURNING id`;
    if (!sender) throw new Error("Missing upgrade sender");
    return value(
      await createDraft({
        context,
        mailboxId,
        input: { ...draftContentInputSchema.parse({ senderIdentityId: "Sender", body: "Existing text" }), senderIdentityId: sender.id },
      }),
    );
  };
  const documentState = (draftId: string) => sql`SELECT edit_mode, doc_generation, doc_state, doc_cursor, doc_seq, revision,
    body_markdown, state FROM mail.drafts WHERE id = ${draftId}::uuid`;

  test("default creation stays shared before readiness and opening the draft gives a visible retry error", async () => {
    expect(await sharedDraftsSupported()).toBe(false);
    const box = await mailbox();
    expect(box.draftEditMode).toBe("shared");
    const created = await draft(box.id);
    expect(created.editMode).toBe("shared");
    // A fresh process may not yet have completed the history checkpoint either.
    await sql`DELETE FROM mail.draft_document_log_policy`;
    try {
      expect(await readDraftDocument({ context, mailboxId: box.id, draftId: created.id })).toMatchObject({
        ok: false,
        error: { status: 409, message: expect.stringContaining("Shared drafts are starting; try again in a moment") },
      });
      expect((await documentState(created.id))[0]).toMatchObject({ edit_mode: "shared", doc_generation: "1" });
      expect(await updateMailbox({ context, mailboxId: box.id, draftEditMode: "shared" })).toMatchObject({
        ok: false,
        error: { status: 409, code: "SHARED_DRAFTS_UNSUPPORTED" },
      });
      expect(await migrateSharedDrafts()).toBeNull();
      expect(await marker()).toEqual([]);
    } finally {
      await sql`INSERT INTO mail.draft_document_log_policy (log_id) VALUES ('cloud:mail:draft-documents') ON CONFLICT DO NOTHING`;
    }
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await stopDraftDocumentPruning();
    expect(await migrateSharedDrafts()).toMatchObject({ completed: true, mailboxes: 1 });
  });

  test("upgrade matches PATCH for open lock drafts; a later explicit lock survives schema and startup reruns", async () => {
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await stopDraftDocumentPruning();
    const patchBox = await mailbox();
    const upgradeBox = await mailbox();
    for (const box of [patchBox, upgradeBox]) value(await updateMailbox({ context, mailboxId: box.id, draftEditMode: "lock" }));
    const patchDraft = await draft(patchBox.id);
    const upgradeDraft = await draft(upgradeBox.id);
    // Exercise a noninitial generation, not just untouched default metadata.
    await sql`UPDATE mail.drafts SET doc_generation = 7, revision = 3 WHERE id IN (${patchDraft.id}::uuid, ${upgradeDraft.id}::uuid)`;
    const before = await documentState(upgradeDraft.id);
    value(await updateMailbox({ context, mailboxId: patchBox.id, draftEditMode: "shared" }));
    expect(await migrateSharedDrafts()).toMatchObject({ completed: true, mailboxes: 2, batches: 1 });
    expect(await documentState(upgradeDraft.id)).toEqual(before);
    expect(await documentState(upgradeDraft.id)).toEqual(await documentState(patchDraft.id));
    expect(await editModes.newDraftEditMode(sql, upgradeBox.id)).toBe("shared");
    const firstMarker = await marker();
    expect(await migrateSharedDrafts()).toMatchObject({ completed: true, mailboxes: 2, batches: 1 });
    expect(await marker()).toEqual(firstMarker);
    value(await updateMailbox({ context, mailboxId: upgradeBox.id, draftEditMode: "lock" }));
    await migrate();
    await migrateSharedDrafts();
    expect(await editModes.newDraftEditMode(sql, upgradeBox.id)).toBe("lock");
    expect((await mailbox()).draftEditMode).toBe("shared");
    expect(await documentState(upgradeDraft.id)).toEqual(before);
  });

  const seedMailboxes = async (count: number) => {
    await sql`INSERT INTO mail.mailboxes (id, short_id, name, draft_edit_mode)
      SELECT ('10000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, lpad(i::text, 6, '0'), 'Legacy', 'lock'
      FROM generate_series(1, ${count}) i`;
  };

  test("a committed batch resumes by durable mailbox ID without overwriting an administrator's rollback", async () => {
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await stopDraftDocumentPruning();
    await seedMailboxes(SHARED_DRAFTS_BATCH_SIZE * 2 + 1);
    const stop = new AbortController();
    const original = editModes.setMailboxDraftEditMode;
    const batches: string[][] = [];
    const switchMode = spyOn(editModes, "setMailboxDraftEditMode").mockImplementation(async (db, ids, mode) => {
      batches.push(ids);
      await original(db, ids, mode);
      stop.abort(new Error("Simulated process stop after this batch commits"));
    });
    try {
      await expect(migrateSharedDrafts(stop.signal)).rejects.toThrow("Simulated process stop");
    } finally {
      switchMode.mockRestore();
    }
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(SHARED_DRAFTS_BATCH_SIZE);
    expect(batches[0]).toEqual([...batches[0]!].sort());
    await sql`UPDATE mail.mailboxes SET draft_edit_mode = 'lock' WHERE id = ${batches[0]![0]}::uuid`;
    expect(await migrateSharedDrafts()).toMatchObject({ completed: true, mailboxes: 201, batches: 3 });
    const [locked] = await sql`SELECT count(*)::int AS count FROM mail.mailboxes WHERE draft_edit_mode = 'lock'`;
    expect(locked?.count).toBe(1);
  });

  test("10000 mailboxes and 50000 open drafts stay within the batch and statement budgets", async () => {
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await stopDraftDocumentPruning();
    await seedMailboxes(10_000);
    await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, automation_policy, status)
      SELECT short_id, id, 'Sender', 'Sender', 'sender@example.test', 'disabled', 'verified' FROM mail.mailboxes`;
    await sql`INSERT INTO mail.drafts (short_id, mailbox_id, sender_identity_id, author_kind, author_id,
      last_editor_kind, last_editor_id, body_markdown, edit_mode, doc_generation)
      SELECT lpad(((row_number() OVER (ORDER BY s.mailbox_id, n))::int)::text, 6, '0'),
        s.mailbox_id, s.id, 'user', ${userId}::uuid, 'user', ${userId}::uuid, 'Preserved text', 'lock', 7
      FROM mail.sender_identities s CROSS JOIN generate_series(1, 5) n`;
    const meter = await meterSql();
    try {
      const started = performance.now();
      console.log(`SHARED_DEFAULT_MEASURE_START ${new Date().toISOString()}`);
      const statements = await meter.during(async () => {
        expect(await migrateSharedDrafts()).toMatchObject({ mailboxes: 10_000, batches: 100, completed: true });
      });
      const durationMs = performance.now() - started;
      console.log(`SHARED_DEFAULT_MEASURE_END ${new Date().toISOString()}`);
      const selects = statements.filter((s) => s.startsWith("SELECT id FROM mail.mailboxes"));
      expect(selects).toHaveLength(101);
      expect(selects.every((s) => s.includes("ORDER BY id LIMIT $2 FOR UPDATE"))).toBe(true);
      expect(statements).toHaveLength(908);
      expect(statements.filter((s) => s === "BEGIN")).toHaveLength(101);
      expect(statements.filter((s) => /mail\.drafts\b/.test(s))).toEqual([]);
      const [preserved] = await sql`SELECT count(*)::int AS count FROM mail.drafts
        WHERE edit_mode = 'lock' AND doc_generation = 7 AND body_markdown = 'Preserved text' AND state = 'draft'`;
      expect(preserved?.count).toBe(50_000);
      console.log(JSON.stringify({ durationMs, batches: 100, transactions: 101, statements: statements.length }));
    } finally {
      await meter.close();
    }
  });
});
