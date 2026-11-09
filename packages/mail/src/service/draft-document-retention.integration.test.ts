import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { getProcessSync, sql } from "@k2b/cloud";
import { captureTableAction } from "@k2b/cloud/shared-text";
import type { Result } from "@k2b/stdlib";
import { ResourceDriftError, RetentionGapError } from "@k2b/sync";
import { findTables } from "@k2b/ui/text-editor/model";
import { DiscardPolicy, type JetStreamManager, jetstreamManager } from "@nats-io/jetstream";
import * as Y from "yjs";
import { connectTestNats, suiteFor } from "../../../../scripts/fixtures/test-infra";
import { prepareDraftSendBinding } from "../../test/fixtures/draft-send";
import { newShortId } from "../lib/short-id";
import type { MailRequestContext } from "./auth";
import { sha256Json } from "./canonical";
import { createActorCommand } from "./commands";
import { reviewDraftComposeSafety } from "./compose-safety";
import {
  DRAFT_DOCUMENT_COVERAGE_LOCK,
  drainDraftDocumentPruning,
  lockDraftDocumentCoverage,
  mailDraftDocumentLog,
  pruneDraftDocumentLog,
  replayDraftDocument,
  withDraftDocumentCommit,
} from "./draft-document-log";
import { migrateDraftDocumentLogPolicy, sharedDraftsSupported } from "./draft-document-log-policy";
import { acceptDraftDocumentUpdate, lockDraftDocumentInTransaction, readDraftDocument } from "./draft-documents";
import { applyDraftTableAction } from "./draft-table-actions";
import { persistDraftDocument, restoreDraftRecoveryCopy, updateDraft } from "./drafts";
import { createMailbox } from "./mailboxes";
import { loadSendContent } from "./send-content";

const suite = suiteFor("database", "nats");
const value = <T>(result: Result<T>): T => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
};
suite("Mail snapshot-covered retention on real JetStream and Postgres", () => {
  let context: MailRequestContext;
  let userId: string;
  let mailboxId: string;
  let senderId: string;
  let manager: JetStreamManager;
  let connection: Awaited<ReturnType<typeof connectTestNats>>;
  let stream: string;
  beforeAll(async () => {
    connection = await connectTestNats();
    manager = await jetstreamManager(connection);
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
    await prepareDraftSendBinding(mailboxId, senderId);
  });
  afterAll(async () => {
    await drainDraftDocumentPruning();
    if (mailboxId) {
      const grants = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id=${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id=${mailboxId}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id=${grant.access_id}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id=${userId}::uuid`;
    await connection?.close();
  });
  const draft = async (body = "Base") => {
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id,mailbox_id,sender_identity_id,author_kind,author_id,last_editor_kind,last_editor_id,subject,body_markdown,edit_mode,to_addresses)
      VALUES (${newShortId()},${mailboxId}::uuid,${senderId}::uuid,'user',${userId}::uuid,'user',${userId}::uuid,
        'Retention',${body},'shared',${[{ address: "to@example.test" }]}::jsonb) RETURNING id`;
    if (!row) throw new Error("Missing fixture draft");
    return { context, mailboxId, draftId: row.id };
  };
  const read = async (target: Awaited<ReturnType<typeof draft>>) => value(await readDraftDocument(target));
  const marker = (id: string) =>
    mailDraftDocumentLog.topic().publish({
      tenantId: id,
      data: {
        kind: "freeze",
        payload: "",
        restoreRevision: "1",
        originNodeId: "retention-fixture",
        originPeerId: null,
      },
    });
  const holdCoverage = async () => {
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const task = sql.begin(async (db) => {
      await lockDraftDocumentCoverage(db);
      held.resolve();
      await release.promise;
    });
    await held.promise;
    return async () => {
      release.resolve();
      await task;
      await drainDraftDocumentPruning();
    };
  };
  const retire = async (...targets: Awaited<ReturnType<typeof draft>>[]) => {
    for (const target of targets) await sql`UPDATE mail.drafts SET state='discarded' WHERE id=${target.draftId}::uuid`;
  };

  // The broker side (an old discard/age stream changed in place, sequences kept)
  // is covered in packages/cloud/src/_internal/sync-budget.integration.test.ts.
  test("flags only drafts that may have lost events to an expired prefix, once", async () => {
    expect(await sharedDraftsSupported()).toBe(false);
    await sql`DELETE FROM mail.draft_document_log_policy`;
    const lost = await draft();
    const idle = await draft();
    const recent = await draft();
    const unopened = await draft();
    await marker(lost.draftId);
    await marker(lost.draftId);
    const kept = await marker(lost.draftId);
    for await (const info of manager.streams.list())
      if (
        info.config.metadata?.["sync.id"] === mailDraftDocumentLog.id &&
        info.config.subjects.some((subject) => subject.endsWith(".t.*.event"))
      )
        stream = info.config.name;
    // What the old seven-day age did: every event before the last one is gone.
    await manager.streams.purge(stream, { seq: mailDraftDocumentLog.topic().cursorSequence(kept.cursor) });
    const before = await manager.streams.info(stream);
    expect(before.state.first_seq).toBeGreaterThan(2);
    // Before the marking ran, no shared draft is read, and none is sent.
    expect(await readDraftDocument(unopened)).toMatchObject({ ok: false, error: { status: 409 } });
    expect(
      await loadSendContent({ db: sql, mailboxId, draftId: unopened.draftId, expectedRevision: 1, actor: { kind: "user", userId } }),
    ).toMatchObject({ ok: false, error: { code: "SEND_CONTENT_CHANGED" } });
    // A snapshot older than the window may have lost events even when none of
    // them is retained any more; a snapshot inside the window lost nothing.
    await sql`UPDATE mail.drafts SET doc_state='\\x00'::bytea, doc_seq=1 WHERE id=${idle.draftId}::uuid`;
    await sql`UPDATE mail.drafts SET doc_state='\\x00'::bytea, doc_seq=${before.state.last_seq} WHERE id=${recent.draftId}::uuid`;
    const incomplete = async () =>
      (
        await sql<{ id: string }[]>`SELECT id FROM mail.drafts WHERE id IN
          (${lost.draftId}::uuid, ${idle.draftId}::uuid, ${recent.draftId}::uuid, ${unopened.draftId}::uuid) AND NOT doc_history_complete`
      )
        .map((row) => row.id)
        .sort();
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await drainDraftDocumentPruning();
    expect(await sharedDraftsSupported()).toBe(true);
    // The unopened draft has neither a snapshot nor retained events: nothing was acknowledged.
    expect(await incomplete()).toEqual([lost.draftId, idle.draftId].sort());
    expect((await readDraftDocument(lost)).ok).toBe(false);
    // The checkpoint makes a second start a no-op: no new flags, no prune of uncovered events.
    await sql`UPDATE mail.drafts SET doc_history_complete=true WHERE id IN (${lost.draftId}::uuid, ${idle.draftId}::uuid)`;
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await drainDraftDocumentPruning();
    expect(await incomplete()).toEqual([]);
    expect((await manager.streams.info(stream)).state.first_seq).toBe(before.state.first_seq);
    await retire(lost, idle, recent, unopened);
  });

  test("repeats recovery marking after the stream changed but the checkpoint never committed", async () => {
    const target = await draft();
    await marker(crypto.randomUUID());
    const receipt = await marker(target.draftId);
    await manager.streams.purge(stream, { seq: mailDraftDocumentLog.topic().cursorSequence(receipt.cursor) });
    // The stream already keeps every event; only the SQL checkpoint is missing.
    await sql`DELETE FROM mail.draft_document_log_policy`;
    expect((await manager.streams.info(stream)).config.discard).toBe(DiscardPolicy.New);
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await drainDraftDocumentPruning();
    expect(await sql`SELECT 1 FROM mail.drafts WHERE id=${target.draftId}::uuid AND NOT doc_history_complete`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM mail.draft_document_log_policy WHERE log_id=${mailDraftDocumentLog.id}`).toHaveLength(1);
    await retire(target);
  });

  test("recovery marking skips a draft row a writer holds and records no checkpoint until it marked it", async () => {
    const target = await draft();
    await sql`UPDATE mail.drafts SET doc_state='\\x00'::bytea, doc_seq=1 WHERE id=${target.draftId}::uuid`;
    await sql`DELETE FROM mail.draft_document_log_policy`;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // A writer that holds the row and would ask for shared coverage next.
    const writer = sql.begin(async (db) => {
      await db`SELECT 1 FROM mail.drafts WHERE id=${target.draftId}::uuid FOR UPDATE`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    try {
      const once = new AbortController();
      once.abort();
      // One attempt only: it must neither wait for the row nor record the checkpoint.
      expect(await migrateDraftDocumentLogPolicy(once.signal)).toBe(false);
      expect(await sql`SELECT 1 FROM mail.draft_document_log_policy`).toHaveLength(0);
      expect(await sharedDraftsSupported()).toBe(false);
    } finally {
      release.resolve();
      await writer;
    }
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await drainDraftDocumentPruning();
    expect(await sql`SELECT 1 FROM mail.drafts WHERE id=${target.draftId}::uuid AND NOT doc_history_complete`).toHaveLength(1);
    await retire(target);
  });

  test("watermark includes frozen/scheduled and null snapshots, while idle proofs keep SQL cursors unchanged", async () => {
    const release = await holdCoverage();
    const a = await draft();
    const idle = await draft();
    const zero = await draft();
    try {
      const base = await read(a);
      const idleBase = await read(idle);
      if (!idleBase.durable.cursor) throw new Error("Missing idle snapshot cursor");
      await marker(a.draftId);
      await sql`UPDATE mail.drafts SET state='scheduled' WHERE id=${a.draftId}::uuid`;
      await marker(zero.draftId);
      await release();
      expect(await pruneDraftDocumentLog()).toMatchObject({ through: 0, purged: 0 });
      await retire(zero);
      expect(await pruneDraftDocumentLog()).toMatchObject({ through: Number(base.docSeq ?? 0) });
      await retire(a);
      const pruned = await pruneDraftDocumentLog();
      if (!pruned) throw new Error("Pruning unexpectedly skipped");
      expect(pruned.through).toBeGreaterThan(Number(base.docSeq ?? 0));
      const [row] = await sql<{ doc_idle_through: string; doc_seq: string; doc_cursor: string; revision: string }[]>`
        SELECT doc_idle_through,doc_seq,doc_cursor,revision FROM mail.drafts WHERE id=${idle.draftId}::uuid`;
      expect(Number(row?.doc_idle_through)).toBe(pruned.through);
      expect(Number(row?.doc_seq)).toBe(Number(idleBase.docSeq));
      expect(row?.doc_cursor).toBe(idleBase.durable.cursor);
      expect(Number(row?.revision)).toBe(idleBase.revision);
    } finally {
      await release();
      await retire(a, idle, zero);
    }
  });

  test("coverage lock serializes seed/save against pruning without timing sleeps", async () => {
    const target = await draft();
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const locked = sql.begin(async (db) => {
      await db`SELECT pg_advisory_xact_lock(${DRAFT_DOCUMENT_COVERAGE_LOCK})`;
      held.resolve();
      await release.promise;
    });
    await held.promise;
    const original = getProcessSync().topic.bind(getProcessSync());
    const queried = spyOn(getProcessSync(), "topic").mockImplementation(original);
    const seeding = read(target);
    try {
      // A PostgreSQL backend waiting for the shared advisory lock is observable;
      // release only once the actual seed transaction has reached that boundary.
      for (const deadline = performance.now() + 5000; ; ) {
        if (performance.now() > deadline) throw new Error("Seed never reached the shared coverage lock");
        const waiting =
          await sql`SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=${DRAFT_DOCUMENT_COVERAGE_LOCK} AND NOT granted`;
        if (waiting.length) break;
        await Bun.sleep(0);
      }
      expect(queried).not.toHaveBeenCalled();
      expect(await pruneDraftDocumentLog()).toBeNull();
      release.resolve();
      await locked;
      const base = await seeding;
      expect(base.durable.content.body).toBe("Base");
      await withDraftDocumentCommit(async (db) => {
        const handle = value(await lockDraftDocumentInTransaction({ ...target, db }));
        const local = new Y.Doc();
        try {
          const current = value(await handle.read());
          Y.applyUpdate(local, current.durable.state);
          local.getText("codemirror").insert(0, "Racing ");
          const admitted = value(
            await handle.accept({
              generation: handle.generation,
              baseCursor: current.durable.cursor,
              update: Y.encodeStateAsUpdate(local),
            }),
          );
          expect(admitted.status).toBe("accepted");
          expect(await pruneDraftDocumentLog()).toBeNull();
          expect(value(await handle.read()).fresh.content.body).toBe("Racing Base");
        } finally {
          local.destroy();
        }
      });
      await drainDraftDocumentPruning();
      expect((await read(target)).durable.content.body).toBe("Racing Base");
    } finally {
      release.resolve();
      await locked;
      await seeding;
      queried.mockRestore();
      await retire(target);
    }
  });

  test("real full log rejects without loss, then a committed snapshot/prune lets the same bytes retry", async () => {
    await pruneDraftDocumentLog();
    const release = await holdCoverage();
    const target = await draft("");
    const local = new Y.Doc();
    local.clientID = 7001;
    const accepted: string[] = [];
    let base = await read(target);
    Y.applyUpdate(local, base.durable.state);
    await manager.streams.update(stream, { max_bytes: 32 * 1024 });
    try {
      let rejected: Uint8Array | undefined;
      for (let index = 0; index < 100; index++) {
        const vector = Y.encodeStateVector(local);
        local.getText("codemirror").insert(local.getText("codemirror").length, `${index}:` + "x".repeat(1024));
        const update = Y.encodeStateAsUpdate(local, vector);
        const result = await acceptDraftDocumentUpdate({ ...target, generation: base.generation, baseCursor: base.durable.cursor, update });
        if (!result.ok) {
          expect(result.error).toMatchObject({ code: "DRAFT_DOCUMENT_STREAM_FULL", status: 409 });
          rejected = update;
          break;
        }
        expect(result.data.status).toBe("accepted");
        accepted.push(local.getText("codemirror").toString());
        base = await read(target);
      }
      expect(rejected).toBeDefined();
      expect(accepted.length).toBeGreaterThan(0);
      expect(base.durable.content.body).toBe(accepted.at(-1)!);
      expect(local.getText("codemirror").toString()).not.toBe(base.durable.content.body);
      let replayed = 0;
      for await (const event of mailDraftDocumentLog.topic().replay({
        tenantId: target.draftId,
        after: mailDraftDocumentLog.topic().cursorAt(Number(base.docSeq) - accepted.length),
        until: base.durable.cursor!,
      }))
        if (event.data.kind === "sync") replayed++;
      expect(replayed).toBe(accepted.length);
      const revision = base.revision;
      value(await persistDraftDocument({ ...target, generation: base.generation }));
      await release();
      expect((await pruneDraftDocumentLog())?.purged).toBeGreaterThanOrEqual(0);
      const retry = value(
        await acceptDraftDocumentUpdate({ ...target, generation: base.generation, baseCursor: base.durable.cursor, update: rejected! }),
      );
      expect(retry.status).toBe("accepted");
      const final = await read(target);
      expect(final.durable.content.body).toBe(local.getText("codemirror").toString());
      expect(final.revision).toBeGreaterThan(revision);
    } finally {
      await release();
      local.destroy();
      await manager.streams.update(stream, { max_bytes: 1024 ** 3 });
      await retire(target);
    }
  }, 20_000);

  test("a full-error trigger runs after its transaction settles and frees already covered events", async () => {
    const target = await draft();
    let base = await read(target);
    await drainDraftDocumentPruning();
    const release = await holdCoverage();
    const local = new Y.Doc();
    try {
      for (let index = 0; index < 32; index++) await marker(target.draftId);
      // Simulate a process stopping after this SQL COMMIT, before it can prune.
      await sql.begin(async (db) => {
        const handle = value(await lockDraftDocumentInTransaction({ ...target, db }));
        value(await handle.project());
      });
      base = await read(target);
      const bytes = (await manager.streams.info(stream)).state.bytes;
      await manager.streams.update(stream, { max_bytes: bytes });
      await release();
      Y.applyUpdate(local, base.durable.state);
      const vector = Y.encodeStateVector(local);
      local.getText("codemirror").insert(0, "Retry ");
      const update = Y.encodeStateAsUpdate(local, vector);
      const request = { ...target, generation: base.generation, baseCursor: base.durable.cursor, update };
      expect(await acceptDraftDocumentUpdate(request)).toMatchObject({ ok: false, error: { code: "DRAFT_DOCUMENT_STREAM_FULL" } });
      await drainDraftDocumentPruning();
      expect((await manager.streams.info(stream)).state.bytes).toBe(0);
      expect(value(await acceptDraftDocumentUpdate(request)).status).toBe("accepted");
      expect((await read(target)).durable.content.body).toBe("Retry Base");
    } finally {
      local.destroy();
      await manager.streams.update(stream, { max_bytes: 1024 ** 3 });
      await release();
      await retire(target);
    }
  });

  test("a full log rejects send markers, table actions, revision saves and restores before changing the draft", async () => {
    await pruneDraftDocumentLog();
    const release = await holdCoverage();
    const target = await draft("| A | B |\n| --- | --- |\n| one | two |");
    const base = await read(target);
    const review = value(await reviewDraftComposeSafety({ ...target, expectedRevision: base.revision }));
    const content = { ...base.durable.content, senderIdentityId: senderId, body: "Restored" };
    const [copy] = await sql<{ id: string }[]>`INSERT INTO mail.draft_recovery_copies
      (draft_id,base_revision,content,content_hash,creator_kind,creator_id)
      VALUES (${target.draftId}::uuid,${base.revision},${content}::jsonb,${sha256Json(content)},'user',${userId}::uuid) RETURNING id`;
    const doc = new Y.Doc();
    try {
      const info = await manager.streams.info(stream);
      await manager.streams.update(stream, { max_bytes: Math.max(1, info.state.bytes) });
      const full = { ok: false, error: { code: "DRAFT_DOCUMENT_STREAM_FULL", status: 409 } };
      expect(
        await sql.begin(async (db) =>
          value(await lockDraftDocumentInTransaction({ ...target, db })).freeze({ generation: base.generation }),
        ),
      ).toMatchObject(full);
      expect(
        await createActorCommand({
          context,
          mailboxId,
          input: {
            kind: "send",
            draftId: target.draftId,
            senderIdentityId: senderId,
            expectedDraftRevision: review.revision,
            expectedContentHash: review.contentHash,
            undoSeconds: 60,
            idempotencyKey: crypto.randomUUID(),
            safetyApproval: {
              revision: review.revision,
              fingerprint: review.fingerprint,
              warningIds: review.warnings.map((warning) => warning.id),
            },
          },
        }),
      ).toMatchObject(full);
      expect(await sql`SELECT 1 FROM mail.outbox_submissions WHERE draft_id=${target.draftId}::uuid`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM mail.draft_document_freezes WHERE draft_id=${target.draftId}::uuid`).toHaveLength(0);
      Y.applyUpdate(doc, base.durable.state);
      const table = findTables(doc.getText("codemirror").toString())[0]!;
      const intent = captureTableAction(doc.getText("codemirror"), "colRight", {
        tableFrom: table.from,
        rowFrom: table.lines[0]!.from,
        columnFrom: table.lines[0]!.cells[0]!.from,
        row: 0,
        column: 0,
      });
      expect(await applyDraftTableAction({ ...target, generation: base.generation, actionId: crypto.randomUUID(), intent })).toMatchObject(
        full,
      );
      expect(await updateDraft({ ...target, expectedRevision: base.revision, input: content })).toMatchObject(full);
      expect(await restoreDraftRecoveryCopy({ ...target, expectedRevision: base.revision, recoveryCopyId: copy!.id })).toMatchObject(full);
      expect(await sql`SELECT 1 FROM mail.draft_recovery_copies WHERE id=${copy!.id}::uuid AND restored_at IS NULL`).toHaveLength(1);
      const after = await read(target);
      expect(after.revision).toBe(base.revision);
      expect(after.durable).toEqual(base.durable);
      expect(after.frozen).toBeNull();
    } finally {
      doc.destroy();
      await manager.streams.update(stream, { max_bytes: 1024 ** 3 });
      await release();
      await retire(target);
    }
  });

  test("restart prunes a snapshot committed without pruning, preserves idle replay and sends exact content", async () => {
    const release = await holdCoverage();
    const target = await draft("Exact after restart");
    const idle = await draft("Idle");
    const before = await read(target);
    const idleBefore = await read(idle);
    await withDraftDocumentCommit(async (db) => {
      const handle = value(await lockDraftDocumentInTransaction({ ...target, db }));
      await marker(target.draftId);
      value(await handle.project());
    });
    await release();
    const old = before.durable.cursor!;
    expect(await migrateDraftDocumentLogPolicy()).toBe(true);
    await drainDraftDocumentPruning();
    const current = await read(target);
    expect(current.durable.content.body).toBe("Exact after restart");
    const newer = await marker(idle.draftId);
    const cursors: string[] = [];
    await sql.begin(async (db) => {
      await lockDraftDocumentCoverage(db);
      for await (const event of replayDraftDocument({
        draftId: idle.draftId,
        after: idleBefore.durable.cursor,
        docSeq: idleBefore.docSeq,
        historyComplete: true,
        until: newer.cursor,
      }))
        cursors.push(event.cursor);
    });
    expect(cursors).toEqual([newer.cursor]);
    await expect(
      (async () => {
        for await (const _ of replayDraftDocument({
          draftId: target.draftId,
          after: old,
          docSeq: current.docSeq,
          historyComplete: true,
          until: newer.cursor,
        })) {
          /* strict stale base */
        }
      })(),
    ).rejects.toBeInstanceOf(RetentionGapError);
    expect(
      value(
        await loadSendContent({
          db: sql,
          mailboxId,
          draftId: target.draftId,
          expectedRevision: current.revision,
          actor: { kind: "user", userId },
        }),
      ).snapshot.body,
    ).toBe("Exact after restart");
    const review = value(await reviewDraftComposeSafety({ ...target, expectedRevision: current.revision }));
    const sent = value(
      await createActorCommand({
        context,
        mailboxId,
        input: {
          kind: "send",
          draftId: target.draftId,
          senderIdentityId: senderId,
          expectedDraftRevision: review.revision,
          expectedContentHash: review.contentHash,
          undoSeconds: 60,
          idempotencyKey: crypto.randomUUID(),
          safetyApproval: {
            revision: review.revision,
            fingerprint: review.fingerprint,
            warningIds: review.warnings.map((warning) => warning.id),
          },
        },
      }),
    );
    const [outbox] = await sql<
      { draft_snapshot: { body: string } }[]
    >`SELECT draft_snapshot FROM mail.outbox_submissions WHERE command_id=${sent.id}::uuid`;
    expect(outbox?.draft_snapshot.body).toBe("Exact after restart");
    await retire(target, idle);
  });
  test("a log the platform cannot prepare leaves shared drafts unsupported", async () => {
    await drainDraftDocumentPruning();
    const original = mailDraftDocumentLog.topic;
    // A fresh process sees drift the platform does not change (sync-budget tests cover the broker side).
    const drifted = spyOn(mailDraftDocumentLog, "topic").mockImplementation(() => ({
      ...original(),
      ready: () => Promise.reject(new ResourceDriftError(stream, [{ field: "max_msgs", declared: -1, actual: 2_000_000_000 }])),
    }));
    try {
      expect(await migrateDraftDocumentLogPolicy()).toBe(false);
      expect(await sharedDraftsSupported()).toBe(false);
    } finally {
      drifted.mockRestore();
      expect(await migrateDraftDocumentLogPolicy()).toBe(true);
      await drainDraftDocumentPruning();
      expect(await sharedDraftsSupported()).toBe(true);
    }
  });
});
