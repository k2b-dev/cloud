import { expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { sql } from "@k2b/cloud";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { sha256Json } from "./canonical";
import { executeMutationCommand } from "./command-runtime";
import { createActorCommand } from "./commands";
import { imapSmtpConnector } from "./connectors";
import {
  processExportSnapshot,
  processImportSnapshot,
  queueDraftProjectionInTransaction,
  recordDraftFolderSyncInTransaction,
} from "./draft-provider-projection";
import { storeReadableBlob } from "./message-blobs";
import { inspectMessage } from "./message-inspector";
import { useRemoteChangesFixture } from "./remote-changes-fixture";
import { canHydrateMessage, hydrateMessageBatch, submitDueHydrationWork } from "./sync-runtime";
import { createConversationTriageCommands } from "./triage";

const suite = suiteFor("database", "nats", "valkey");
const noHeartbeat = async () => {};

suite("protocol locator readers", () => {
  const fixture = useRemoteChangesFixture("protocol-locators");
  const seed = async (label: string) => {
    const mailbox = await fixture.connect(label, false);
    mailbox.remote.put("inbox", `<${label}@example.test>`);
    await mailbox.sync("inbox");
    const [row] = await sql<{ id: string; message_id: string; conversation_id: string }[]>`
      SELECT ref.id, ref.message_id, link.conversation_id
      FROM mail.remote_message_refs ref JOIN mail.message_contents content ON content.id = ref.message_id
      JOIN mail.conversation_messages link ON link.message_id = content.id
      WHERE content.mailbox_id = ${mailbox.mailboxId}::uuid
    `;
    if (!row) throw new Error(`${label}: seeded IMAP reference missing`);
    return { ...mailbox, refId: row.id, messageId: row.message_id, conversationId: row.conversation_id };
  };
  const jmapOnly = async (refId: string) => {
    await sql`UPDATE mail.remote_message_refs SET uid = NULL, uid_validity = NULL, remote_id = 'email_alpha' WHERE id = ${refId}::uuid`;
  };
  const addJmapCopy = async (source: Awaited<ReturnType<typeof seed>>, remoteId: string) => {
    const [ref] = await sql<
      { id: string }[]
    >`INSERT INTO mail.remote_message_refs (folder_id, message_id, remote_id, first_seen_at, last_seen_at)
      VALUES (${source.folderId("inbox")}::uuid, ${source.messageId}::uuid, ${remoteId}, '2026-11-19T12:00:00Z', '2026-11-19T12:00:00Z') RETURNING id`;
    if (!ref) throw new Error("JMAP fixture: copy missing");
    await sql`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      VALUES (${ref.id}::uuid, ${source.folderId("inbox")}::uuid, ${source.messageId}::uuid)`;
    return ref.id;
  };
  const draft = async (label: string, shortId: string) => {
    const mailbox = await fixture.connect(label, false);
    const [identity] = await sql<{ id: string }[]>`INSERT INTO mail.sender_identities
      (short_id, mailbox_id, label, from_address, status, drafts_folder_id)
      VALUES (${shortId}, ${mailbox.mailboxId}::uuid, 'Locator sender', 'sender@example.test', 'verified', ${mailbox.folderId("drafts")}::uuid) RETURNING id`;
    if (!identity) throw new Error(`${label}: sender fixture missing`);
    const [row] = await sql<{ id: string }[]>`INSERT INTO mail.drafts
      (short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind, revision, edit_mode)
      VALUES (${shortId}, ${mailbox.mailboxId}::uuid, ${identity.id}::uuid, 'system', 'system', 2, 'lock') RETURNING id`;
    if (!row) throw new Error(`${label}: draft fixture missing`);
    return { ...mailbox, draftId: row.id, identityId: identity.id };
  };

  test("C2: resetting an IMAP generation preserves the JMAP reference and placement", async () => {
    const source = await seed("reset");
    const [address] = await sql<
      { remote_resource_id: string; content_hash: string }[]
    >`SELECT folder.remote_resource_id, content.content_hash
      FROM mail.folders folder JOIN mail.message_contents content ON content.id = ${source.messageId}::uuid
      WHERE folder.id = ${source.folderId("inbox")}::uuid`;
    if (!address) throw new Error("C1: IMAP hash fixture missing");
    expect(address.content_hash, "C1: unchanged IMAP hash").toBe(
      sha256Json({ remoteResourceId: address.remote_resource_id, folderId: source.folderId("inbox"), uidValidity: "500", uid: "1" }),
    );
    const remote = await addJmapCopy(source, "email_alpha");
    source.remote.resetUidValidity("inbox");
    await source.sync("inbox");
    expect(
      await sql<{ stale: boolean }[]>`SELECT stale_at IS NOT NULL AS stale FROM mail.remote_message_refs WHERE id = ${source.refId}::uuid`,
      "C2: old IMAP stale",
    ).toEqual([{ stale: true }]);
    expect(
      await sql<
        { remote_id: string; stale_at: Date | null; deleted_at: Date | null }[]
      >`SELECT ref.remote_id, ref.stale_at, placement.deleted_at FROM mail.remote_message_refs ref
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id WHERE ref.id = ${remote}::uuid`,
      "C2: JMAP untouched",
    ).toEqual([{ remote_id: "email_alpha", stale_at: null, deleted_at: null }]);
  });

  test("C3: JMAP-only hydration stops visibly without downloads or resubmission; mixed content stays eligible", async () => {
    const source = await seed("hydrate");
    await jmapOnly(source.refId);
    const download = spyOn(imapSmtpConnector, "downloadSourceBatch").mockRejectedValue(new Error("C3: unexpected IMAP download"));
    try {
      expect(await canHydrateMessage(source.messageId), "C3: no IMAP target").toBeFalse();
      expect(
        await hydrateMessageBatch({
          input: { messageId: source.messageId },
          heartbeat: noHeartbeat,
          resubmit: () => {
            throw new Error("C3: unsupported hydration resubmitted");
          },
        }),
      ).toEqual({ hydrated: false });
      expect(
        await sql<
          { hydration_status: string; hydration_error_code: string | null }[]
        >`SELECT hydration_status, hydration_error_code FROM mail.message_contents WHERE id = ${source.messageId}::uuid`,
        "C3: visible failure",
      ).toEqual([{ hydration_status: "failed", hydration_error_code: "REMOTE_MESSAGE_PROTOCOL_UNSUPPORTED" }]);
      // All other fixture mailboxes have completed bodies, so the scheduler cannot queue them.
      await sql`UPDATE mail.message_contents SET hydration_status = 'complete'
        WHERE id <> ${source.messageId}::uuid AND mailbox_id = ANY(${toPgUuidArray(fixture.mailboxIds)}::uuid[])`;
      expect(await submitDueHydrationWork(), "C3: no unsupported mailbox retry").toBe(0);
      await sql`INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
        VALUES (${source.folderId("inbox")}::uuid, ${source.messageId}::uuid, 500, 2)`;
      expect(await canHydrateMessage(source.messageId), "C3: mixed message uses IMAP").toBeTrue();
      expect(download, "C3: provider untouched").not.toHaveBeenCalled();
    } finally {
      download.mockRestore();
    }
  });

  test("C4: current and stale JMAP commands finish with attention before any IMAP effect", async () => {
    for (const stale of [false, true]) {
      const source = await seed(stale ? "stale-command" : "current-command");
      await sql`UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read', 'delete_messages', 'move', 'insert']::text[]
        WHERE folder_id = ${source.folderId("inbox")}::uuid`;
      const created = await createActorCommand({
        context: fixture.ownerContext,
        mailboxId: source.mailboxId,
        enqueue: false,
        input: { kind: "delete", messageId: source.messageId, folderId: source.folderId("inbox"), idempotencyKey: `locator-${stale}` },
      });
      if (!created.ok) throw new Error(`C4: command creation: ${created.error.message}`);
      await jmapOnly(source.refId);
      if (stale) {
        await sql`UPDATE mail.remote_message_refs SET stale_at = '2026-11-19T12:00:00Z' WHERE id = ${source.refId}::uuid`;
        await sql`UPDATE mail.commands SET state = 'ambiguous', attempt = 1,
          provider_effect_started_at = '2026-11-19T12:00:00Z', provider_effect_attempt = 1 WHERE id = ${created.data.id}::uuid`;
      }
      const read = spyOn(imapSmtpConnector, "getMessageState").mockRejectedValue(new Error("C4: unexpected IMAP read"));
      const remove = spyOn(imapSmtpConnector, "delete").mockRejectedValue(new Error("C4: unexpected IMAP delete"));
      try {
        expect(await executeMutationCommand(created.data.id), `C4: stale=${stale}`).toBe("needs_attention");
        expect(
          await sql<{ last_error_code: string | null }[]>`SELECT last_error_code FROM mail.commands WHERE id = ${created.data.id}::uuid`,
          "C4: explicit protocol error",
        ).toEqual([{ last_error_code: "REMOTE_MESSAGE_PROTOCOL_UNSUPPORTED" }]);
        expect(read, "C4: zero reads").not.toHaveBeenCalled();
        expect(remove, "C4: zero deletes").not.toHaveBeenCalled();
      } finally {
        read.mockRestore();
        remove.mockRestore();
      }
    }
  });

  test("C5: superseded addressed snapshots survive cleanup; appending JMAP snapshots never reset", async () => {
    const source = await draft("snapshot-cleanup", "LocDR1");
    // This exercises snapshot cleanup only; it never opens a shared document or room.
    await sql`UPDATE mail.drafts SET edit_mode = 'shared' WHERE id = ${source.draftId}::uuid`;
    const [snapshot] = await sql<{ id: string }[]>`INSERT INTO mail.draft_provider_snapshots
      (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint, folder_id, remote_id)
      VALUES (${source.mailboxId}::uuid, ${source.draftId}::uuid, 1, 'export', 'needs_attention', '<cleanup@example.test>', ${"a".repeat(64)}, ${source.folderId("drafts")}::uuid, 'email_alpha') RETURNING id`;
    if (!snapshot) throw new Error("C5: snapshot fixture missing");
    const preparedId = await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId: source.draftId }));
    if (!preparedId) throw new Error("C5: prepared successor missing");
    expect(
      await sql<{ remote_id: string | null }[]>`SELECT remote_id FROM mail.draft_provider_snapshots WHERE id = ${snapshot.id}::uuid`,
      "C5: addressed history retained",
    ).toEqual([{ remote_id: "email_alpha" }]);
    await sql`UPDATE mail.draft_provider_snapshots SET state = 'appending', attempt = 1,
      provider_effect_started_at = '2026-11-19T12:00:00Z' WHERE id = ${snapshot.id}::uuid`;
    const append = spyOn(imapSmtpConnector, "appendSource").mockRejectedValue(
      Object.assign(new Error("C5: no append"), { effectPossible: false }),
    );
    try {
      await processExportSnapshot(snapshot.id, noHeartbeat);
      expect(
        await sql<
          { state: string; remote_id: string | null; started: boolean }[]
        >`SELECT state, remote_id, provider_effect_started_at IS NOT NULL AS started FROM mail.draft_provider_snapshots WHERE id = ${snapshot.id}::uuid`,
        "C5: never reset to unaddressed prepared",
      ).toEqual([{ state: "needs_attention", remote_id: "email_alpha", started: true }]);
      expect(append).not.toHaveBeenCalled();
    } finally {
      append.mockRestore();
    }
    await sql`UPDATE mail.drafts SET edit_mode = 'lock' WHERE id = ${source.draftId}::uuid`;
    await sql`UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read', 'insert', 'delete_messages']::text[]
      WHERE folder_id = ${source.folderId("drafts")}::uuid`;
    // Simulate a concurrently addressed snapshot just before a definitely failed APPEND returns.
    const rejectedAppend = spyOn(imapSmtpConnector, "appendSource").mockImplementation(async () => {
      await sql`UPDATE mail.draft_provider_snapshots SET remote_id = 'email_racing' WHERE id = ${preparedId}::uuid`;
      throw Object.assign(new Error("C5: append refused"), { effectPossible: false });
    });
    try {
      await expect(processExportSnapshot(preparedId, noHeartbeat), "C5: append failure").rejects.toThrow("C5: append refused");
      expect(
        await sql<{ state: string; remote_id: string; started: boolean }[]>`SELECT state, remote_id,
        provider_effect_started_at IS NOT NULL AS started FROM mail.draft_provider_snapshots WHERE id = ${preparedId}::uuid`,
        "C5: append failure preserves remote identity",
      ).toEqual([{ state: "appending", remote_id: "email_racing", started: true }]);
      expect(rejectedAppend, "C5: reached the guarded append failure").toHaveBeenCalledTimes(1);
    } finally {
      rejectedAppend.mockRestore();
    }
    await sql`DELETE FROM mail.draft_provider_snapshots WHERE mailbox_id = ${source.mailboxId}::uuid`;
    await sql`DELETE FROM mail.drafts WHERE id = ${source.draftId}::uuid`;
    await sql`DELETE FROM mail.sender_identities WHERE id = ${source.identityId}::uuid`;
  });

  test("C6: JMAP import and retirement stop visibly with zero provider calls", async () => {
    const source = await draft("snapshot-transport", "LocDR2");
    const download = spyOn(imapSmtpConnector, "downloadSourceBatch").mockRejectedValue(new Error("C6: no download"));
    const remove = spyOn(imapSmtpConnector, "delete").mockRejectedValue(new Error("C6: no delete"));
    const status = spyOn(imapSmtpConnector, "getFolderStatus");
    const beforeStatus = status.mock.calls.length;
    try {
      for (const direction of ["import", "export"]) {
        const [snapshot] = await sql<{ id: string }[]>`INSERT INTO mail.draft_provider_snapshots
          (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint, folder_id, remote_id)
          VALUES (${source.mailboxId}::uuid, ${source.draftId}::uuid, 1, ${direction}, ${direction === "import" ? "external" : "retiring"},
            '<transport@example.test>', ${"b".repeat(64)}, ${source.folderId("drafts")}::uuid, 'email_alpha') RETURNING id`;
        if (!snapshot) throw new Error(`C6: ${direction} fixture missing`);
        if (direction === "import") await processImportSnapshot(snapshot.id, noHeartbeat);
        else await processExportSnapshot(snapshot.id, noHeartbeat);
        expect(
          await sql<
            { state: string; last_error_code: string | null }[]
          >`SELECT state, last_error_code FROM mail.draft_provider_snapshots WHERE id = ${snapshot.id}::uuid`,
          `C6: ${direction} visible`,
        ).toEqual([{ state: "needs_attention", last_error_code: "REMOTE_MESSAGE_PROTOCOL_UNSUPPORTED" }]);
      }
      expect(download).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(status.mock.calls.length, "C6: no IMAP STATUS").toBe(beforeStatus);
    } finally {
      download.mockRestore();
      remove.mockRestore();
    }
  });

  test("C6: a JMAP Cloud copy is not treated as missing while importing an IMAP draft", async () => {
    const source = await draft("snapshot-copy", "LocDR3");
    const [copy] = await sql<{ id: string }[]>`INSERT INTO mail.draft_provider_snapshots
      (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint, folder_id, remote_id)
      VALUES (${source.mailboxId}::uuid, ${source.draftId}::uuid, 2, 'export', 'active', '<copy@example.test>', ${"c".repeat(64)},
        ${source.folderId("drafts")}::uuid, 'email_alpha') RETURNING id`;
    if (!copy) throw new Error("C6 copy: active fixture missing");
    const mime = Buffer.from(
      [
        "From: sender@example.test",
        "To: recipient@example.test",
        "Subject: external copy",
        "Message-ID: <external-copy@example.test>",
        "Date: Thu, 19 Nov 2026 12:00:00 +0000",
        "Content-Type: text/plain",
        "",
        "External body",
      ].join("\r\n"),
    );
    const blob = await storeReadableBlob(Readable.from([mime]), mime.length);
    const [observation] = await sql<{ id: string }[]>`INSERT INTO mail.draft_provider_snapshots
      (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, folder_id, uid_validity, uid, mime_blob_id)
      VALUES (${source.mailboxId}::uuid, ${source.draftId}::uuid, 2, 'import', 'external', '<external-copy@example.test>',
        ${source.folderId("drafts")}::uuid, 502, 77, ${blob.id}::uuid) RETURNING id`;
    if (!observation) throw new Error("C6 copy: IMAP observation missing");
    const state = spyOn(imapSmtpConnector, "getMessageState").mockRejectedValue(new Error("C6 copy: unexpected IMAP lookup"));
    const download = spyOn(imapSmtpConnector, "downloadSourceBatch").mockRejectedValue(new Error("C6 copy: source already stored"));
    try {
      await processImportSnapshot(observation.id, noHeartbeat);
      expect(
        await sql<{ state: string; last_error_code: string | null }[]>`SELECT state, last_error_code FROM mail.draft_provider_snapshots
        WHERE id = ${observation.id}::uuid`,
        "C6 copy: unsupported, not a lost copy",
      ).toEqual([{ state: "needs_attention", last_error_code: "REMOTE_MESSAGE_PROTOCOL_UNSUPPORTED" }]);
      expect(
        await sql<{ state: string; remote_id: string }[]>`SELECT state, remote_id FROM mail.draft_provider_snapshots
        WHERE id = ${copy.id}::uuid`,
        "C6 copy: Cloud copy retained",
      ).toEqual([{ state: "active", remote_id: "email_alpha" }]);
      expect(state).not.toHaveBeenCalled();
      expect(download).not.toHaveBeenCalled();
    } finally {
      state.mockRestore();
      download.mockRestore();
      await sql`DELETE FROM mail.draft_provider_snapshots WHERE id = ${observation.id}::uuid`;
      await sql`DELETE FROM mail.message_part_blobs WHERE id = ${blob.id}::uuid`;
    }
  });

  test("C8: IMAP Message-ID matching ignores JMAP observations on first and repeated sync", async () => {
    const source = await fixture.connect("draft-matching", false);
    const [binding] = await sql<{ binding_id: string; remote_resource_id: string }[]>`SELECT ref.binding_id, folder.remote_resource_id
      FROM mail.binding_folder_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE ref.folder_id = ${source.folderId("drafts")}::uuid`;
    if (!binding) throw new Error("C8: binding fixture missing");
    const rfcId = "<same-rfc@example.test>";
    const [observation] = await sql<
      { id: string }[]
    >`INSERT INTO mail.draft_provider_snapshots (mailbox_id, direction, state, stable_message_id, folder_id, remote_id)
      VALUES (${source.mailboxId}::uuid, 'import', 'external', ${rfcId}, ${source.folderId("drafts")}::uuid, 'email_alpha') RETURNING id`;
    if (!observation) throw new Error("C8: observation fixture missing");
    source.remote.put("drafts", rfcId, ["\\Draft"]);
    const batch = await source.remote.methods.fetchEnvelopeBatch({
      folderPath: "drafts",
      folderStableKey: "drafts:502",
      uidValidity: "502",
      highUid: 1,
      limit: 1,
    });
    const apply = () =>
      sql.begin((db) =>
        recordDraftFolderSyncInTransaction({
          db,
          mailboxId: source.mailboxId,
          remoteResourceId: binding.remote_resource_id,
          bindingId: binding.binding_id,
          folderId: source.folderId("drafts"),
          uidValidity: "502",
          uidValidityChanged: false,
          envelopes: batch.messages,
          reconcileWindow: null,
        }),
      );
    await apply();
    await apply();
    expect(
      await sql<
        { remote_id: string | null; uid: string | null; uid_validity: string | null }[]
      >`SELECT remote_id, uid::text, uid_validity::text FROM mail.draft_provider_snapshots WHERE mailbox_id = ${source.mailboxId}::uuid ORDER BY remote_id NULLS FIRST`,
      "C8: separate stable identities",
    ).toEqual([
      { remote_id: null, uid: "1", uid_validity: "502" },
      { remote_id: "email_alpha", uid: null, uid_validity: null },
    ]);
  });

  test("C8: a prepared IMAP export with no UID still links the observed draft", async () => {
    const source = await draft("prepared-match", "LocDR4");
    const rfcId = "<prepared-match@example.test>";
    await sql`INSERT INTO mail.draft_provider_snapshots
      (mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id, content_fingerprint)
      VALUES (${source.mailboxId}::uuid, ${source.draftId}::uuid, 2, 'export', 'prepared', ${rfcId}, ${"d".repeat(64)})`;
    await sql`INSERT INTO mail.draft_provider_snapshots (mailbox_id, direction, state, stable_message_id, folder_id, remote_id)
      VALUES (${source.mailboxId}::uuid, 'import', 'external', ${rfcId}, ${source.folderId("drafts")}::uuid, 'email_alpha')`;
    const [binding] = await sql<{ binding_id: string; remote_resource_id: string }[]>`SELECT ref.binding_id, folder.remote_resource_id
      FROM mail.binding_folder_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE ref.folder_id = ${source.folderId("drafts")}::uuid`;
    if (!binding) throw new Error("C8 prepared: binding missing");
    source.remote.put("drafts", rfcId, ["\\Draft"]);
    const batch = await source.remote.methods.fetchEnvelopeBatch({
      folderPath: "drafts",
      folderStableKey: "drafts:502",
      uidValidity: "502",
      highUid: 1,
      limit: 1,
    });
    const result = await sql.begin((db) =>
      recordDraftFolderSyncInTransaction({
        db,
        mailboxId: source.mailboxId,
        remoteResourceId: binding.remote_resource_id,
        bindingId: binding.binding_id,
        folderId: source.folderId("drafts"),
        uidValidity: "502",
        uidValidityChanged: false,
        envelopes: batch.messages,
        reconcileWindow: null,
      }),
    );
    expect(result.importSnapshotIds, "C8 prepared: one IMAP observation").toHaveLength(1);
    expect(
      await sql<{ draft_id: string; remote_id: string | null }[]>`SELECT draft_id, remote_id FROM mail.draft_provider_snapshots
      WHERE id = ${result.importSnapshotIds[0]}::uuid`,
      "C8 prepared: linked to unaddressed export",
    ).toEqual([{ draft_id: source.draftId, remote_id: null }]);
  });

  test("C9: inspector preserves IMAP and orders JMAP IDs; triage keeps every NULL-UID ref", async () => {
    const source = await seed("inspect");
    const original = await inspectMessage({ context: fixture.ownerContext, mailboxId: source.mailboxId, messageId: source.messageId });
    if (!original.ok) throw new Error(`C9: initial inspection: ${original.error.message}`);
    await addJmapCopy(source, "email_beta");
    await addJmapCopy(source, "email_alpha");
    const inspected = await inspectMessage({ context: fixture.ownerContext, mailboxId: source.mailboxId, messageId: source.messageId });
    if (!inspected.ok) throw new Error(`C9: mixed inspection: ${inspected.error.message}`);
    expect(inspected.data.placements[0], "C9: IMAP unchanged").toEqual(original.data.placements[0]);
    expect(
      inspected.data.placements.slice(1).map((p) => ("remoteId" in p ? p.remoteId : p.uid)),
      "C9: stable JMAP order",
    ).toEqual(["email_alpha", "email_beta"]);
    expect(
      inspected.data.placements.slice(1).every((p) => !("uid" in p) && !("uidValidity" in p)),
      "C9: no synthetic UIDs",
    ).toBeTrue();
    await sql`UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read', 'write_flags']::text[] WHERE folder_id = ${source.folderId("inbox")}::uuid`;
    const triage = await createConversationTriageCommands({
      context: fixture.ownerContext,
      mailboxId: source.mailboxId,
      conversationId: source.conversationId,
      input: {
        kind: "change_state",
        sourceFolderId: source.folderId("inbox"),
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
        idempotencyKey: "locator-triage",
      },
    });
    if (!triage.ok) throw new Error(`C9: triage: ${triage.error.message}`);
    expect(triage.data.commands, "C9: three copies retained").toHaveLength(3);
  });
});
