import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import { projectJmapFolders } from "./bindings";
import { discoverJmapFolders } from "./connectors/jmap";
import { type JmapSyncState, readJmapSyncState } from "./connectors/jmap-account-state";
import { fetchJmapSession, JMAP_CORE } from "./connectors/jmap-client";
import { type JmapEmailDelta, readJmapEmailDelta, readJmapMailboxDelta } from "./connectors/jmap-delta";
import type { JmapEmailSnapshot } from "./connectors/jmap-email";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./connectors/jmap-fixture";
import { waitForBlockedCommit } from "./jmap-lock-fixture";
import { commitJmapAccountBatch, syncJmapAccountDelta } from "./jmap-sync-runtime";
import { mailLive } from "./live";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { claimFence } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-20T00:00:00Z");
const initial: JmapSyncState = { version: 2, emailState: "Email:0", mailboxState: "Mailbox:0", scan: null };
// Measured in the gate, BEGIN and COMMIT included. A quiet commit is the transaction, four locks
// (resource, binding, connection, mailbox), the checkpoint and the run. A page with changes adds
// the refs, the folders, one batch statement for its kind, binding usage and the live invalidation.
// Only a new membership costs per message: the 18 statements of the shared ingestEnvelope.
const STATEMENT_BUDGET: Record<
  "unchanged" | "statesOnly" | "new1" | "new7" | "flags1" | "flags7" | "remove1" | "remove7" | "folders",
  number
> = {
  unchanged: 8,
  statesOnly: 8,
  new1: 31,
  new7: 139,
  flags1: 13,
  flags7: 13,
  remove1: 14,
  remove7: 14,
  folders: 18,
};
let sequence = 0;
const uuid = () => `00000000-003d-4000-8000-${String(++sequence).padStart(12, "0")}`;
const shortId = () => `J${String(++sequence).padStart(5, "0")}`;
const message = (
  id: string,
  mailboxIds: Record<string, boolean> = { a: true },
  keywords: Record<string, boolean> = {},
): JmapEmailSnapshot => ({
  ...fixtureEmail(id),
  mailboxIds,
  keywords,
  subject: id,
  from: [{ name: null, email: `${id}@example.invalid` }],
});

suite("JMAP account commit", () => {
  let source: Awaited<ReturnType<typeof setup>>;
  let live: ReturnType<typeof spyOn<typeof mailLive, "wake">>;
  beforeAll(async () => {
    // The integration runner owns this file's disposable database.
    await migrate();
    await buildFolderIdentityIndexes();
  });
  beforeEach(async () => {
    setSystemTime(at);
    createAppEventTestHarness("mail", mailCapabilities);
    live = spyOn(mailLive, "wake").mockImplementation(() => {});
    source = await setup();
  });
  afterEach(async () => {
    try {
      await source?.f.close();
    } finally {
      live?.mockRestore();
      setSystemTime();
    }
  });
  async function setup() {
    const f = createJmapFixture();
    try {
      f.session.capabilities[JMAP_CORE].maxObjectsInGet = 200;
      f.mailboxes.push(
        fixtureMailbox("trash", "Trash", null, "trash"),
        fixtureMailbox("junk", "Junk", null, "junk"),
        fixtureMailbox("drafts", "Drafts", null, "drafts"),
      );
      const signal = new AbortController().signal;
      const authorization = "Basic fictional-unused";
      const session = await fetchJmapSession({ origin: f.origin, signal, authorization }, f.dependencies);
      const mailboxId = uuid(),
        remoteResourceId = uuid(),
        connectionId = uuid(),
        bindingId = uuid();
      const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: f.origin, accountId: "d333333" };
      const fingerprint = jmapScopeFingerprint(evidence);
      await sql<
        []
      >`INSERT INTO mail.mailboxes (id, short_id, name, health) VALUES (${mailboxId}::uuid, ${shortId()}, 'JMAP fixture', 'active')`;
      await sql<
        []
      >`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status, sync_state)
        VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active', ${initial}::jsonb)`;
      await sql<[]>`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
        VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'own@example.invalid', 'reader', 'jmap',
          'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password', 'fictional-unused')`;
      await sql<
        []
      >`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator, verification_evidence, verified_scope_fingerprint)
        VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId: evidence.accountId }}::jsonb, ${evidence}::jsonb, ${fingerprint})`;
      const folders = await discoverJmapFolders({ origin: f.origin, signal, authorization }, f.dependencies);
      const folderIds = await sql.begin((tx) =>
        projectJmapFolders(tx, {
          remoteResourceId,
          bindingId,
          discoveryGeneration: 1,
          evidence,
          folders,
          inventory: { kind: "snapshot" },
        }),
      );
      await sql<[]>`INSERT INTO mail.sender_identities (id, short_id, mailbox_id, label, from_address, status)
        VALUES (${uuid()}::uuid, ${shortId()}, ${mailboxId}::uuid, 'Fixture sender', 'own@example.invalid', 'verified')`;
      const args = {
        remoteResourceId,
        bindingId,
        secretRevision: 1,
        session,
        accountId: evidence.accountId,
        signal,
        authorization,
        transport: f.dependencies,
        captureWorkflowTriggers: true,
      };
      return { f, args, mailboxId, connectionId, folderIds };
    } catch (error) {
      await f.close();
      throw error;
    }
  }
  const state = async () => {
    const [row] = await sql<
      { sync_state: unknown }[]
    >`SELECT sync_state FROM mail.remote_resources WHERE id = ${source.args.remoteResourceId}::uuid`;
    if (!row) throw new Error("state: resource missing");
    const value = readJmapSyncState(row.sync_state);
    if (!value) throw new Error("state: checkpoint missing");
    return value;
  };
  const counts = async () => {
    const [row] = await sql<
      { contents: number; refs: number; active: number; conversations: number; receipts: number; live: number; hydration: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM mail.message_contents WHERE mailbox_id = ${source.mailboxId}::uuid) AS contents,
        (SELECT count(*)::int FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE folder.remote_resource_id = ${source.args.remoteResourceId}::uuid) AS refs,
        (SELECT count(*)::int FROM mail.message_placements p JOIN mail.folders f ON f.id = p.folder_id WHERE f.remote_resource_id = ${source.args.remoteResourceId}::uuid AND p.deleted_at IS NULL) AS active,
        (SELECT count(*)::int FROM mail.conversation_messages cm JOIN mail.message_contents c ON c.id = cm.message_id WHERE c.mailbox_id = ${source.mailboxId}::uuid) AS conversations,
        (SELECT count(*)::int FROM events.outbox e JOIN mail.message_contents c ON c.short_id = e.payload->'subject'->>'id'
          WHERE c.mailbox_id = ${source.mailboxId}::uuid AND e.app_id = 'mail' AND e.kind = 'event' AND e.payload->>'type' = 'mail.message.received') AS receipts,
        (SELECT count(*)::int FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${source.mailboxId}) AS live,
        (SELECT count(*)::int FROM mail.hydration_work WHERE mailbox_id = ${source.mailboxId}::uuid) AS hydration
    `;
    if (!row) throw new Error("counts: aggregate missing");
    return row;
  };
  function change(email: JmapEmailSnapshot, kind: "created" | "updated" = "created") {
    const index = source.f.emails.findIndex((item) => item.id === email.id);
    if (index < 0) source.f.emails.push(email);
    else source.f.emails[index] = email;
    source.f.journal.Email.push({ id: email.id, kind });
  }
  const run = (captureWorkflowTriggers = true) => syncJmapAccountDelta({ ...source.args, captureWorkflowTriggers });
  const prepared = async () => {
    const beforeState = await state();
    if (beforeState.emailState === null || beforeState.mailboxState === null) throw new Error("prepare: email state missing");
    const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
    const delta = await readJmapEmailDelta(
      source.args.session,
      source.args.authorization,
      source.args.accountId,
      beforeState.emailState,
      source.args.signal,
      source.f.dependencies,
    );
    return {
      ...source.args,
      beforeState,
      fence,
      batch: { kind: "email" as const, delta, mailboxState: { oldState: beforeState.mailboxState, newState: beforeState.mailboxState } },
    };
  };
  const placements = () => sql<
    { remote_id: string | null; flags: string[]; keywords: string[]; stale: boolean; deleted: boolean; message_id: string }[]
  >`
    SELECT ref.remote_id, p.flags, p.keywords, ref.stale_at IS NOT NULL AS stale, p.deleted_at IS NOT NULL AS deleted, ref.message_id
    FROM mail.remote_message_refs ref JOIN mail.message_placements p ON p.remote_message_ref_id = ref.id
    JOIN mail.folders f ON f.id = ref.folder_id WHERE f.remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY ref.remote_id, f.stable_key
  `;

  test("bounded folder locks: a flag update leaves 300 unrelated and missing folders unlocked", async () => {
    change(message("boundedlocks"));
    await run();
    const unrelated = Array.from({ length: 300 }, (_, index) => ({
      id: uuid(),
      short_id: shortId(),
      key: `unrelated-${index}`,
      missing: index % 3 === 0,
    }));
    await sql<[]>`INSERT INTO mail.folders (id, short_id, remote_resource_id, stable_key, name, discovery_state)
      SELECT item.id, item.short_id, ${source.args.remoteResourceId}::uuid, item.key, item.key,
        CASE WHEN item.missing THEN 'missing' ELSE 'active' END
      FROM jsonb_to_recordset(${unrelated}::jsonb) AS item(id uuid, short_id text, key text, missing boolean)`;
    await sql<[]>`INSERT INTO mail.binding_folder_refs (binding_id, folder_id, remote_folder_id, remote_path, missing_since)
      SELECT ${source.args.bindingId}::uuid, item.id, item.key, item.key, CASE WHEN item.missing THEN ${at}::timestamptz ELSE NULL END
      FROM jsonb_to_recordset(${unrelated}::jsonb) AS item(id uuid, key text, missing boolean)`;
    change(message("boundedlocks", { a: true }, { $seen: true }), "updated");
    const batch = await prepared();
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("locks: missing backend");
      // Stop the account commit after it has locked its folders, before it releases any lock.
      await writer<{ id: string }[]>`SELECT id FROM mail.provider_bindings WHERE id = ${source.args.bindingId}::uuid FOR NO KEY UPDATE`;
      committing = Promise.allSettled([commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid);
      const unlocked = await writer<{ id: string }[]>`SELECT id FROM mail.folders
        WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY id FOR UPDATE SKIP LOCKED`;
      expect(unlocked.length, "locks: exactly the one affected folder is held").toBe(300 + source.folderIds.size - 1);
      expect(
        unlocked.some((row) => row.id === source.folderIds.get("a")),
        "locks: affected folder held",
      ).toBeFalse();
      expect(
        unrelated.every((folder) => unlocked.some((row) => row.id === folder.id)),
        "locks: all unrelated rows, including missing ones, available",
      ).toBeTrue();
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "locks: account commit succeeds").toMatchObject([
        { status: "fulfilled", value: { status: "committed", stats: { flagsUpdated: 1 } } },
      ]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("lock order: a role writer holding the folder and the account commit both finish", async () => {
    change(message("rolelock"));
    const batch = await prepared();
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      await writer<[]>`SET LOCAL lock_timeout = '10s'`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("role lock: missing backend");
      await writer<{ id: string }[]>`SELECT id FROM mail.folders WHERE id = ${source.folderIds.get("a")}::uuid FOR UPDATE`;
      committing = Promise.allSettled([commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid);
      // setFolderRole's write order: folder UPDATE lock, then override insert with mailbox KEY SHARE.
      await writer<[]>`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${source.mailboxId}::uuid, 'archive', ${source.folderIds.get("a")}::uuid)`;
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "role lock: no deadlock or lock timeout").toMatchObject([
        { status: "fulfilled", value: { status: "committed" } },
      ]);
      expect(
        await sql<{ role: string }[]>`SELECT role FROM mail.folder_role_overrides WHERE mailbox_id = ${source.mailboxId}::uuid`,
        "role lock: role writer also committed",
      ).toEqual([{ role: "archive" }]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("lock order: a command writer holding the mailbox and a folder batch both finish", async () => {
    source.f.mailboxes.push(fixtureMailbox("cmdlock", "Command lock"));
    source.f.journal.Mailbox.push({ id: "cmdlock", kind: "created" });
    const beforeState = await state();
    const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
    const delta = await readJmapMailboxDelta(
      source.args.session,
      source.args.authorization,
      source.args.accountId,
      "Mailbox:0",
      source.args.signal,
      source.f.dependencies,
    );
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      await writer<[]>`SET LOCAL lock_timeout = '10s'`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("command lock: missing backend");
      // Command creation's order: the mailbox first, then the key-share check of commands.selected_binding_id.
      await writer<{ id: string }[]>`SELECT id FROM mail.mailboxes WHERE id = ${source.mailboxId}::uuid FOR UPDATE`;
      committing = Promise.allSettled([commitJmapAccountBatch({ ...source.args, fence, beforeState, batch: { kind: "mailbox", delta } })]);
      await waitForBlockedCommit(backend.pid);
      await writer<{ id: string }[]>`SELECT id FROM mail.provider_bindings WHERE id = ${source.args.bindingId}::uuid FOR KEY SHARE`;
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "command lock: no deadlock or lock timeout").toMatchObject([
        { status: "fulfilled", value: { status: "committed", stats: { folders: 1 } } },
      ]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("flow: one content, locator, placement, conversation, receipt and checkpoint; quiet retry has no visible writes", async () => {
    change(message("arrival"));
    expect(await run(), "flow: committed").toMatchObject({ status: "committed", hasMore: false, stats: { imported: 1 } });
    expect(await counts(), "flow: durable projection without hydration").toEqual({
      contents: 1,
      refs: 1,
      active: 1,
      conversations: 1,
      receipts: 1,
      live: 1,
      hydration: 0,
    });
    expect(await state(), "flow: email axis only").toEqual({ ...initial, emailState: "Email:1" });
    const before = await placements();
    const countBefore = await counts();
    expect(await run(), "quiet: committed").toMatchObject({ status: "committed", stats: { memberships: 0, flagsUpdated: 0 } });
    expect(await placements(), "quiet: same rows").toEqual(before);
    expect(await counts(), "quiet: no visible work").toEqual(countBefore);
    expect(
      await sql<{ state: string }[]>`SELECT state FROM mail.sync_runs WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid`,
      "quiet: empty run removed",
    ).toEqual([{ state: "completed" }]);
  });
  test("idempotency: even an empty batch with an unchanged checkpoint cannot commit twice", async () => {
    const batch = await prepared();
    expect(await commitJmapAccountBatch(batch), "empty replay: first commit").toMatchObject({ status: "committed" });
    expect(await state(), "empty replay: checkpoint did not advance").toEqual(initial);
    const before = await counts();
    expect(await commitJmapAccountBatch(batch), "empty replay: run already finished").toMatchObject({ status: "superseded" });
    expect(await counts(), "empty replay: no writes").toEqual(before);
  });
  test("idempotency: concurrent empty replay cannot reuse a completed run when sync time is throttled", async () => {
    await sql<
      []
    >`UPDATE mail.remote_resources SET last_sync_at = now() + interval '1 minute' WHERE id = ${source.args.remoteResourceId}::uuid`;
    const batch = await prepared();
    const writer = await sql.reserve();
    let committing: Promise<Awaited<ReturnType<typeof commitJmapAccountBatch>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("concurrent replay: missing backend");
      // Both commits start their first statement while the run is still running: the second one
      // then proceeds on that view after the first has finished the run.
      await writer<{ id: string }[]>`SELECT id FROM mail.remote_resources WHERE id = ${source.args.remoteResourceId}::uuid FOR UPDATE`;
      committing = Promise.all([commitJmapAccountBatch(batch), commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid, 2);
      await writer<[]>`COMMIT`.simple();
      const results = await committing;
      expect(results.map((result) => result.status).sort(), "concurrent replay: exactly one commit").toEqual(["committed", "superseded"]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing.catch(() => undefined);
    }
    expect(await counts(), "concurrent replay: no visible work").toMatchObject({ contents: 0, live: 0, receipts: 0 });
  });
  test("primary: a new email with two memberships receives exactly once through Inbox", async () => {
    change(message("primary", { b: true, a: true }));
    await run();
    expect(await counts(), "primary: one content and receipt").toMatchObject({ contents: 1, refs: 2, active: 2, receipts: 1 });
    const received = await sql<{ role: string }[]>`SELECT folder.role FROM events.outbox event
      JOIN mail.remote_message_refs ref ON ref.id::text = event.payload->'data'->>'receiptId'
      JOIN mail.folders folder ON folder.id = ref.folder_id
      WHERE folder.remote_resource_id = ${source.args.remoteResourceId}::uuid AND event.app_id = 'mail' AND event.kind = 'event'
        AND event.payload->>'type' = 'mail.message.received'`;
    expect(received, "primary: Inbox receipt").toEqual([{ role: "inbox" }]);
  });
  test("idempotency: same batch is superseded; new created/updated replays and moves never receive twice", async () => {
    change(message("repeat"));
    const batch = await prepared();
    await commitJmapAccountBatch(batch);
    const before = await counts();
    expect(await commitJmapAccountBatch(batch), "replay: old checkpoint").toMatchObject({ status: "superseded" });
    expect(await counts(), "replay: nothing written").toEqual(before);
    for (const kind of ["created", "updated"] as const) {
      change(message("repeat"), kind);
      await run();
      expect(await counts(), `replay ${kind}: same projection`).toEqual(before);
    }
    change(message("repeat", { a: true, b: true }), "updated");
    await run();
    expect(await counts(), "membership: shared content").toMatchObject({ contents: 1, refs: 2, active: 2, receipts: 1 });
    change(message("repeat", { b: true, c: true }), "updated");
    await run();
    expect(await counts(), "move: content retained").toMatchObject({ contents: 1, refs: 3, active: 2, receipts: 1 });
    change(message("repeat", { b: true, c: true }, { $seen: true }), "updated");
    await run();
    expect((await counts()).receipts, "flags: no receipt").toBe(1);
    expect(new Set((await placements()).map((row) => row.message_id)).size, "move: original identity").toBe(1);
  });
  for (const excluded of ["disabled", "updated", "trash", "junk", "outbound"] as const) {
    test(`receipt exclusion: ${excluded}`, async () => {
      const email = message("excluded", excluded === "trash" || excluded === "junk" ? { a: true, [excluded]: true } : { a: true });
      if (excluded === "outbound") email.from = [{ name: null, email: "own@example.invalid" }];
      change(email, excluded === "updated" ? "updated" : "created");
      await run(excluded !== "disabled");
      expect(await counts(), `${excluded}: stored without receipt`).toMatchObject({ contents: 1, receipts: 0 });
    });
  }
  test("flags: all active memberships update once; an identical flag page does not write placements", async () => {
    change(message("flags", { a: true, b: true }));
    await run();
    change(message("flags", { a: true, b: true }, { $seen: true, Important: true }), "updated");
    expect(await run(), "flags: both memberships").toMatchObject({ stats: { flagsUpdated: 2, memberships: 0 } });
    expect(
      (await placements()).map((row) => [row.flags, row.keywords]),
      "flags: equal across folders",
    ).toEqual([
      [["\\Seen"], ["Important"]],
      [["\\Seen"], ["Important"]],
    ]);
    const timestamps = () =>
      sql<
        { updated_at: Date }[]
      >`SELECT p.updated_at FROM mail.message_placements p JOIN mail.message_contents c ON c.id = p.message_id WHERE c.mailbox_id = ${source.mailboxId}::uuid ORDER BY p.remote_message_ref_id`;
    const before = await timestamps();
    change(message("flags", { a: true, b: true }, { $seen: true, Important: true }), "updated");
    expect(await run(), "flags: unchanged").toMatchObject({ stats: { flagsUpdated: 0 } });
    expect(await timestamps(), "flags: no tuple update").toEqual(before);
  });
  test("outbox evidence: the sent copy reuses local content without an arrival", async () => {
    const stableId = "<sent-evidence@example.invalid>";
    const [identity] = await sql<{ id: string }[]>`SELECT id FROM mail.sender_identities WHERE mailbox_id = ${source.mailboxId}::uuid`;
    if (!identity) throw new Error("outbox: missing sender identity");
    const draftId = uuid(),
      commandId = uuid(),
      contentId = uuid();
    await sql<[]>`INSERT INTO mail.drafts (id, short_id, mailbox_id, sender_identity_id, author_kind, last_editor_kind, edit_mode)
      VALUES (${draftId}::uuid, ${shortId()}, ${source.mailboxId}::uuid, ${identity.id}::uuid, 'system', 'system', 'lock')`;
    await sql<
      []
    >`INSERT INTO mail.commands (id, mailbox_id, kind, state, actor_kind, access_subject_kind, idempotency_key, request_hash, target, payload)
      VALUES (${commandId}::uuid, ${source.mailboxId}::uuid, 'send', 'confirmed', 'system', 'system', ${draftId}, ${"a".repeat(64)}, '{}'::jsonb, '{}'::jsonb)`;
    await sql<[]>`INSERT INTO mail.message_contents (id, short_id, mailbox_id, message_id, subject, internal_date, content_hash)
      VALUES (${contentId}::uuid, ${shortId()}, ${source.mailboxId}::uuid, ${stableId}, 'Local send', ${at}, ${"b".repeat(64)})`;
    await sql<[]>`INSERT INTO mail.outbox_submissions (id, short_id, mailbox_id, draft_id, command_id, sender_identity_id,
      selected_binding_id, stable_message_id, state, requested_at, mime_date, message_id)
      VALUES (${uuid()}::uuid, ${shortId()}, ${source.mailboxId}::uuid, ${draftId}::uuid, ${commandId}::uuid, ${identity.id}::uuid,
        ${source.args.bindingId}::uuid, ${stableId}, 'sent', ${at}, ${at}, ${contentId}::uuid)`;
    change({
      ...message("sentcopy", { a: true, b: true }),
      messageId: ["sent-evidence@example.invalid"],
      from: [{ name: null, email: "own@example.invalid" }],
    });
    await run();
    expect(await counts(), "outbox: one local content, two memberships, no receipt").toMatchObject({
      contents: 1,
      refs: 2,
      active: 2,
      receipts: 0,
    });
    expect(
      (await placements()).map((row) => row.message_id),
      "outbox: exact local identity reused",
    ).toEqual([contentId, contentId]);
  });
  for (const configured of ["archive", "junk"] as const) {
    test(`roles: configured ${configured} wins over the provider role`, async () => {
      const mailboxId = configured === "archive" ? "junk" : "b";
      await sql<[]>`INSERT INTO mail.folder_role_overrides (mailbox_id, folder_id, role)
        VALUES (${source.mailboxId}::uuid, ${source.folderIds.get(mailboxId)}::uuid, ${configured})`;
      change(message("rolearrival", { a: true, [mailboxId]: true }));
      await run();
      const arrivals = configured === "archive" ? 1 : 0;
      expect(await counts(), `${configured}: effective role controls receipt`).toMatchObject({ contents: 1, refs: 2, receipts: arrivals });
    });
  }
  test("roles: configured Drafts replaces the provider Drafts folder as in IMAP", async () => {
    await sql<[]>`INSERT INTO mail.folder_role_overrides (mailbox_id, folder_id, role)
      VALUES (${source.mailboxId}::uuid, ${source.folderIds.get("b")}::uuid, 'drafts')`;
    change(message("providerdrafts", { drafts: true }));
    change(message("configureddrafts", { b: true }));
    await run();
    expect(await counts(), "draft role: only provider folder is now ordinary").toMatchObject({ contents: 1, refs: 1, active: 1 });
    expect(
      (await placements()).map((row) => row.remote_id),
      "draft role: configured destination skipped",
    ).toEqual(["providerdrafts"]);
  });
  for (const removal of ["last", "destroyed", "notFound", "draft"] as const) {
    test(`removal: ${removal} retains content and conversation`, async () => {
      change(message("remove"));
      await run();
      if (removal === "destroyed" || removal === "notFound") {
        if (removal === "destroyed") source.f.emails.length = 0;
        else
          source.f.controls.afterChanges = (type) => {
            if (type === "Email") source.f.emails.length = 0;
          };
        source.f.journal.Email.push({ id: "remove", kind: removal === "destroyed" ? "destroyed" : "updated" });
      } else change(message("remove", removal === "last" ? {} : { a: true }, removal === "draft" ? { $draft: true } : {}), "updated");
      await run();
      expect(await counts(), `${removal}: local content retained`).toMatchObject({
        contents: 1,
        refs: 1,
        active: 0,
        conversations: 1,
        receipts: 1,
      });
      expect((await placements())[0], `${removal}: stale ref and deleted placement`).toMatchObject({ stale: true, deleted: true });
    });
  }
  test("drafts: flagged mail and Drafts membership skipped; other membership still projects", async () => {
    change(message("flagged", { a: true }, { $draft: true }));
    change(message("folder", { drafts: true }));
    change(message("mixed", { a: true, drafts: true }));
    await run();
    expect(await counts(), "drafts: only ordinary membership").toMatchObject({ contents: 1, refs: 1, active: 1 });
    expect((await placements())[0]?.remote_id, "drafts: mixed ordinary projection").toBe("mixed");
  });
  test("keep: last removal restores a kept copy; reappearance retires it", async () => {
    change(message("kept"));
    await run();
    await sql<[]>`INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind)
      SELECT cm.conversation_id, c.mailbox_id, 'system' FROM mail.conversation_messages cm JOIN mail.message_contents c ON c.id = cm.message_id
      WHERE c.mailbox_id = ${source.mailboxId}::uuid`;
    change(message("kept", {}), "updated");
    await run();
    expect((await placements())[0], "keep: stale but visible").toMatchObject({ stale: true, deleted: false });
    change(message("kept", { b: true }), "updated");
    await run();
    expect((await counts()).active, "keep: only new active copy").toBe(1);
    expect(
      (await placements()).filter((row) => row.stale).every((row) => row.deleted),
      "keep: stale copy retired",
    ).toBeTrue();
  });
  test("folders: rename, rights, creation precede email; deletion waits for the email delta", async () => {
    const inbox = source.f.mailboxes.find((folder) => folder.id === "a");
    if (!inbox) throw new Error("folders: missing inbox");
    inbox.name = "Renamed";
    inbox.myRights.maySetSeen = false;
    source.f.mailboxes.push(fixtureMailbox("new", "New"));
    source.f.journal.Mailbox.push({ id: "a", kind: "updated" }, { id: "new", kind: "created" });
    change(message("newfolder", { new: true }));
    expect(await run(), "folders: separate bounded commit").toMatchObject({
      status: "committed",
      hasMore: true,
      stats: { folders: 2, imported: 0 },
    });
    expect((await state()).emailState, "folders: email waits").toBe("Email:0");
    expect(
      source.f.requests.flatMap((request) => request.calls ?? []).some(([method]) => method === "Email/changes"),
      "folders: no email request",
    ).toBeFalse();
    const [renamed] = await sql<{ name: string; effective_rights: string[] }[]>`SELECT f.name, r.effective_rights FROM mail.folders f
      JOIN mail.binding_folder_refs r ON r.folder_id = f.id WHERE r.binding_id = ${source.args.bindingId}::uuid AND r.remote_folder_id = 'a'`;
    expect(renamed?.name, "folders: renamed").toBe("Renamed");
    expect(renamed?.effective_rights, "folders: changed rights").not.toContain("write_flags");
    await run();
    expect((await counts()).active, "folders: new membership imported").toBe(1);
    source.f.journal.Mailbox.push({ id: "new", kind: "destroyed" });
    await run();
    expect(await counts(), "folders: deletion retains memberships until email delta").toMatchObject({ contents: 1, active: 1 });
    expect(
      await sql<{ discovery_state: string }[]>`SELECT f.discovery_state FROM mail.folders f
      JOIN mail.binding_folder_refs ref ON ref.folder_id = f.id
      WHERE ref.binding_id = ${source.args.bindingId}::uuid AND ref.remote_folder_id = 'new'`,
      "folders: marked missing",
    ).toEqual([{ discovery_state: "missing" }]);
    change(message("newfolder", {}), "updated");
    await run();
    expect(await counts(), "email delta: removes the deleted folder membership").toMatchObject({ contents: 1, active: 0 });
  });
  test("destroyed folder: membership retirement does not depend on a surviving binding-folder ref", async () => {
    change(message("oldbinding"));
    await run();
    await sql<[]>`DELETE FROM mail.binding_folder_refs WHERE binding_id = ${source.args.bindingId}::uuid AND remote_folder_id = 'a'`;
    source.f.journal.Mailbox.push({ id: "a", kind: "destroyed" });
    await run();
    expect(await counts(), "destroyed folder: no unbounded retirement").toMatchObject({ contents: 1, active: 1 });
    source.f.journal.Email.push({ id: "oldbinding", kind: "destroyed" });
    await run();
    expect(await counts(), "email delta: retirement without binding-folder ref").toMatchObject({ contents: 1, active: 0 });
    expect((await placements())[0], "destroyed folder: stale locator").toMatchObject({ stale: true, deleted: true });
  });
  for (const removal of ["updated", "destroyed"] as const) {
    test(`mixed locators: folder deletion then ${removal} leaves the IMAP ref and placement untouched`, async () => {
      change(message("mixedlocators"));
      await run();
      const first = (await placements())[0];
      if (!first) throw new Error("mixed locators: missing content");
      const imapId = uuid();
      await sql<[]>`INSERT INTO mail.remote_message_refs (id, folder_id, message_id, uid_validity, uid)
        VALUES (${imapId}::uuid, ${source.folderIds.get("a")}::uuid, ${first.message_id}::uuid, 42, 501)`;
      await sql<[]>`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
        VALUES (${imapId}::uuid, ${source.folderIds.get("a")}::uuid, ${first.message_id}::uuid, ARRAY[]::text[], ARRAY['imap-label']::text[])`;
      const imap = () => sql<{ ref: unknown; placement: unknown }[]>`SELECT to_jsonb(ref) AS ref, to_jsonb(p) AS placement
        FROM mail.remote_message_refs ref JOIN mail.message_placements p ON p.remote_message_ref_id = ref.id WHERE ref.id = ${imapId}::uuid`;
      const before = await imap();
      change(message("mixedlocators", { a: true }, { $seen: true }), "updated");
      await run();
      expect(await imap(), "mixed locators: JMAP flags leave IMAP unchanged").toEqual(before);
      source.f.journal.Mailbox.push({ id: "a", kind: "destroyed" });
      await run();
      expect(await counts(), "mixed locators: folder commit retains both memberships").toMatchObject({ active: 2 });
      expect(await imap(), "mixed locators: folder deletion leaves IMAP unchanged").toEqual(before);
      if (removal === "updated") change(message("mixedlocators", {}), "updated");
      else source.f.journal.Email.push({ id: "mixedlocators", kind: "destroyed" });
      await run();
      expect(await counts(), "mixed locators: only IMAP remains visible").toMatchObject({ active: 1 });
      expect(await imap(), "mixed locators: email removal leaves IMAP unchanged").toEqual(before);
      expect(
        (await placements()).find((row) => row.remote_id === "mixedlocators"),
        "mixed locators: JMAP retired",
      ).toMatchObject({ stale: true, deleted: true });
    });
  }
  test("unknown folder: entire batch and checkpoint remain unchanged", async () => {
    change(message("known"));
    change(message("unknown", { absent: true }));
    const batch = await prepared(),
      before = await counts();
    expect(await commitJmapAccountBatch(batch), "unknown folder: retry decision").toEqual({
      status: "superseded",
      cause: "folders_required",
    });
    expect(await state(), "unknown folder: checkpoint unchanged").toEqual(initial);
    expect(await counts(), "unknown folder: no partial content or event").toEqual(before);
  });
  for (const race of [
    "state",
    "generation",
    "fence",
    "binding",
    "revision",
    "bindingRevision",
    "pause",
    "resourcePause",
    "fingerprint",
    "resourceFingerprint",
    "deleted",
    "kind",
  ] as const) {
    test(`fence: ${race} invalidates the entire commit`, async () => {
      change(message("race"));
      const batch = await prepared();
      if (race === "state")
        await sql<
          []
        >`UPDATE mail.remote_resources SET sync_state = ${{ ...initial, mailboxState: "elsewhere" }}::jsonb WHERE id = ${source.args.remoteResourceId}::uuid`;
      if (race === "generation")
        await sql<
          []
        >`UPDATE mail.remote_resources SET sync_generation = sync_generation + 1 WHERE id = ${source.args.remoteResourceId}::uuid`;
      if (race === "fence") await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
      if (race === "binding") await sql<[]>`UPDATE mail.provider_bindings SET state = 'revoked' WHERE id = ${source.args.bindingId}::uuid`;
      if (race === "revision")
        await sql<[]>`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${source.connectionId}::uuid`;
      if (race === "bindingRevision")
        await sql<[]>`UPDATE mail.provider_bindings SET verified_secret_revision = 2 WHERE id = ${source.args.bindingId}::uuid`;
      if (race === "resourcePause")
        await sql<[]>`UPDATE mail.remote_resources SET status = 'paused' WHERE id = ${source.args.remoteResourceId}::uuid`;
      if (race === "resourceFingerprint")
        await sql<
          []
        >`UPDATE mail.remote_resources SET scope_fingerprint = ${"f".repeat(64)} WHERE id = ${source.args.remoteResourceId}::uuid`;
      if (race === "pause") await sql<[]>`UPDATE mail.mailboxes SET sync_enabled = false WHERE id = ${source.mailboxId}::uuid`;
      if (race === "fingerprint")
        await sql<
          []
        >`UPDATE mail.provider_bindings SET verified_scope_fingerprint = ${"f".repeat(64)} WHERE id = ${source.args.bindingId}::uuid`;
      if (race === "deleted") await sql<[]>`UPDATE mail.mailboxes SET deleted_at = ${at} WHERE id = ${source.mailboxId}::uuid`;
      if (race === "kind")
        await sql<[]>`UPDATE mail.remote_resources SET connector_kind = 'imap_smtp' WHERE id = ${source.args.remoteResourceId}::uuid`;
      const beforeState = await state(),
        before = await counts();
      expect(await commitJmapAccountBatch(batch), `${race}: superseded`).toMatchObject({ status: "superseded" });
      expect(await counts(), `${race}: no projection writes`).toEqual(before);
      expect(await state(), `${race}: concurrent state preserved`).toEqual(beforeState);
      expect(live, `${race}: no wake`).not.toHaveBeenCalled();
    });
  }
  test("rollback after ingest: conflict rolls back content, run, checkpoint and events; retry matches clean projection", async () => {
    change(message("conflict", { a: true }));
    change(message("other", { b: true }));
    await run();
    await sql<[]>`UPDATE mail.remote_message_refs ref SET remote_id = 'conflict' FROM mail.folders f
      WHERE ref.folder_id = f.id AND f.remote_resource_id = ${source.args.remoteResourceId}::uuid AND ref.remote_id = 'other'`;
    change(message("first"));
    change(message("conflict", { c: true }), "updated");
    const batch = await prepared(),
      before = await counts(),
      beforeState = await state();
    const runs = () =>
      sql<{ state: string; cursor_after: unknown }[]>`SELECT state, cursor_after FROM mail.sync_runs WHERE id = ${batch.fence.runId}::uuid`;
    const beforeRun = await runs();
    await expect(commitJmapAccountBatch(batch), "rollback: identity error").rejects.toMatchObject({
      code: "JMAP_MESSAGE_IDENTITY_CONFLICT",
    });
    expect(await counts(), "rollback: content and outboxes").toEqual(before);
    expect(await state(), "rollback: checkpoint").toEqual(beforeState);
    expect(await runs(), "rollback: run").toEqual(beforeRun);
    await sql<[]>`UPDATE mail.remote_message_refs SET remote_id = 'other' WHERE folder_id = ${source.folderIds.get("b")}::uuid`;
    await commitJmapAccountBatch(batch);
    expect(await counts(), "retry: one new receipt and preserved contents").toMatchObject({ contents: 3, active: 3, receipts: 3 });
    expect(await state(), "retry: checkpoint committed").toEqual({ ...initial, emailState: "Email:4" });
  });
  test("bounded continuation: each call commits at most one email or folder page", async () => {
    source.args.session.core.maxObjectsInGet = 1;
    change(message("one"));
    change(message("two"));
    expect(await run(), "page 1").toMatchObject({ hasMore: true, stats: { imported: 1 } });
    expect((await state()).emailState, "page 1: exact cursor").toBe("Email:1");
    expect(await run(), "page 2").toMatchObject({ hasMore: false, stats: { imported: 1 } });
    source.f.journal.Mailbox.push({ id: "a", kind: "updated" }, { id: "b", kind: "updated" });
    expect(await run(), "folder page 1").toMatchObject({ hasMore: true, stats: { folders: 1 } });
    expect((await state()).mailboxState, "folder page 1: exact cursor").toBe("Mailbox:1");
    expect(await run(), "folder page 2: email continuation remains").toMatchObject({ hasMore: true, stats: { folders: 1 } });
  });
  for (const axis of ["email", "mailbox"] as const) {
    test(`batch bound: direct oversized ${axis} input rejected without SQL writes`, async () => {
      const batch = await prepared();
      source.args.session.core.maxObjectsInGet = 1;
      const delta: JmapEmailDelta = {
        oldState: "Email:0",
        newState: "Email:2",
        hasMoreChanges: false,
        createdIds: ["one", "two"],
        updatedIds: [],
        destroyedIds: [],
        notFoundIds: [],
        objects: [message("one"), message("two")],
      };
      const before = await counts();
      const input =
        axis === "email"
          ? { kind: "email" as const, delta, mailboxState: batch.batch.mailboxState }
          : {
              kind: "mailbox" as const,
              delta: {
                oldState: "Mailbox:0",
                newState: "Mailbox:2",
                hasMoreChanges: false,
                created: [],
                updated: [],
                destroyedIds: ["a", "b"],
                notFoundIds: [],
              },
            };
      await expect(commitJmapAccountBatch({ ...batch, batch: input }), `${axis}: bound`).rejects.toMatchObject({
        code: "JMAP_INVALID_RESPONSE",
      });
      expect(await counts(), `${axis}: no writes`).toEqual(before);
    });
  }
  for (const reason of ["cannotCalculateChanges", "invalidArguments"] as const) {
    test(`reconciliation: ${reason} keeps checkpoint and ends the owned run`, async () => {
      source.f.methodErrors.set("Mailbox/changes", reason);
      expect(await run(), "reconciliation: typed result").toEqual({
        status: "reconciliation_required",
        cause: reason === "invalidArguments" ? "state_rejected" : "cannot_calculate",
        axis: "mailbox",
      });
      expect(await state(), "reconciliation: unchanged checkpoint").toEqual(initial);
      expect(
        await sql<
          { state: string; error_code: string }[]
        >`SELECT state, error_code FROM mail.sync_runs WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid`,
        "reconciliation: visible terminal run",
      ).toEqual([{ state: "failed", error_code: "JMAP_RECONCILIATION_REQUIRED" }]);
    });
  }
  test("reconciliation: a rejected Email state names the email axis and keeps the checkpoint", async () => {
    source.f.methodErrors.set("Email/changes", "invalidArguments");
    expect(await run(), "email axis: typed result").toEqual({ status: "reconciliation_required", cause: "state_rejected", axis: "email" });
    expect(await state(), "email axis: unchanged checkpoint").toEqual(initial);
  });
  test("initial and unknown states are never overwritten and never claim a fence", async () => {
    for (const value of [null, { version: 99 }]) {
      await sql<[]>`UPDATE mail.remote_resources SET sync_state = ${value}::jsonb WHERE id = ${source.args.remoteResourceId}::uuid`;
      await expect(run(), "state: typed refusal").rejects.toMatchObject({
        code: value === null ? "JMAP_INITIAL_SYNC_REQUIRED" : "JMAP_SYNC_STATE_UNSUPPORTED",
      });
      expect(
        await sql<
          { sync_state: unknown; current_fence_token: string }[]
        >`SELECT sync_state, current_fence_token::text FROM mail.remote_resources WHERE id = ${source.args.remoteResourceId}::uuid`,
        "state: untouched",
      ).toEqual([{ sync_state: value, current_fence_token: "0" }]);
    }
  });
  test("post-fence network failure finishes only the owned run", async () => {
    source.f.methodErrors.set("Email/changes", "forbidden");
    await expect(run(), "failure: propagated").rejects.toMatchObject({ code: "JMAP_METHOD" });
    expect(
      await sql<{ state: string }[]>`SELECT state FROM mail.sync_runs WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid`,
      "failure: terminal",
    ).toEqual([{ state: "failed" }]);
    expect(await state(), "failure: no checkpoint").toEqual(initial);
  });
  test("empty recovery: keep one successful run after a failure, then discard quiet runs", async () => {
    source.f.methodErrors.set("Email/changes", "forbidden");
    await expect(run(), "recovery: failed reader").rejects.toMatchObject({ code: "JMAP_METHOD" });
    source.f.methodErrors.clear();
    expect(await run(), "recovery: empty success").toMatchObject({ status: "committed" });
    expect(await run(), "recovery: subsequent quiet success").toMatchObject({ status: "committed" });
    expect(
      await sql<
        { state: string }[]
      >`SELECT state FROM mail.sync_runs WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY fence_token`,
      "recovery: failure and successful resolution retained",
    ).toEqual([{ state: "failed" }, { state: "completed" }]);
  });
  test("abort after fence: no state or projection survives, owned run ends visibly", async () => {
    const controller = new AbortController();
    source.f.controls.handle = (request) => {
      if (request.method === "POST") controller.abort();
      return undefined;
    };
    await expect(syncJmapAccountDelta({ ...source.args, signal: controller.signal }), "abort: typed transport error").rejects.toMatchObject(
      { code: "JMAP_ABORTED" },
    );
    expect(await state(), "abort: checkpoint unchanged").toEqual(initial);
    expect(await counts(), "abort: no partial projection").toMatchObject({ contents: 0, live: 0, receipts: 0 });
    expect(
      await sql<{ state: string }[]>`SELECT state FROM mail.sync_runs WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid`,
      "abort: terminal run",
    ).toEqual([{ state: "failed" }]);
  });
  test("failure after a replacement claim never finishes the replacement run", async () => {
    source.f.methodErrors.set("Email/changes", "forbidden");
    let claimed = false;
    source.f.controls.handle = async (request) => {
      if (request.method === "POST" && !claimed) {
        claimed = true;
        await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
      }
      return undefined;
    };
    await expect(run(), "replacement: reader error propagated").rejects.toMatchObject({ code: "JMAP_METHOD" });
    expect(
      await sql<{ state: string }[]>`SELECT state FROM mail.sync_runs
      WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY fence_token`,
      "replacement: old stale, successor still owns work",
    ).toEqual([{ state: "stale_fence" }, { state: "running" }]);
    expect(await state(), "replacement: unchanged checkpoint").toEqual(initial);
  });
  for (const newMail of [true, false]) {
    test(`counter-only mailbox progress commits both axes with one fence; new mail: ${newMail}`, async () => {
      source.f.controls.updatedProperties = ["totalEmails"];
      source.f.journal.Mailbox.push({ id: "a", kind: "updated" });
      if (newMail) change(message("aftercounters"));
      expect(await run(), "counters: one account commit").toMatchObject({
        status: "committed",
        hasMore: false,
        stats: { folders: 0, imported: newMail ? 1 : 0 },
      });
      expect(await state(), "counters: both axes caught up").toEqual({
        ...initial,
        mailboxState: "Mailbox:1",
        emailState: newMail ? "Email:1" : "Email:0",
      });
      expect(
        await sql<{ fence: number }[]>`SELECT current_fence_token::int AS fence FROM mail.remote_resources
        WHERE id = ${source.args.remoteResourceId}::uuid`,
        "counters: exactly one fence",
      ).toEqual([{ fence: 1 }]);
      expect((await counts()).live, "counters: invalidate only visible mail").toBe(newMail ? 1 : 0);
    });
  }
  test("email batch rejects a mailbox checkpoint from a different starting state", async () => {
    const batch = await prepared();
    await expect(
      commitJmapAccountBatch({
        ...batch,
        batch: { ...batch.batch, mailboxState: { oldState: "Mailbox:elsewhere", newState: "Mailbox:next" } },
      }),
      "mailbox checkpoint: reject mismatch",
    ).rejects.toMatchObject({ code: "JMAP_INVALID_RESPONSE" });
    expect(await state(), "mailbox checkpoint: unchanged").toEqual(initial);
    expect(await counts(), "mailbox checkpoint: no projection").toMatchObject({ contents: 0, live: 0 });
  });
  test("quiet commits skip empty work, preserve binding usage and throttle resource sync time", async () => {
    // Use the database clock for its own throttle; the test's mail fixtures retain their fixed clock.
    await sql<
      []
    >`UPDATE mail.remote_resources SET last_sync_at = now() + interval '1 minute' WHERE id = ${source.args.remoteResourceId}::uuid`;
    await sql<[]>`UPDATE mail.provider_bindings SET last_used_at = ${at} WHERE id = ${source.args.bindingId}::uuid`;
    const usage = () => sql<{ last_sync_at: Date; last_used_at: Date }[]>`SELECT r.last_sync_at, b.last_used_at
      FROM mail.remote_resources r JOIN mail.provider_bindings b ON b.remote_resource_id = r.id WHERE b.id = ${source.args.bindingId}::uuid`;
    const before = await usage();
    const meter = await meterSql();
    try {
      for (const advance of [false, true]) {
        const batch = await prepared();
        const statements = await meter.during(() =>
          commitJmapAccountBatch({
            ...batch,
            batch: {
              ...batch.batch,
              mailboxState: {
                oldState: batch.batch.mailboxState.oldState,
                newState: advance ? "Mailbox:counters" : batch.batch.mailboxState.newState,
              },
            },
          }),
        );
        expect(
          statements.some(
            (text) =>
              text.startsWith("SELECT ref.id") ||
              text.startsWith("SELECT folder.id") ||
              text.startsWith("WITH stale AS") ||
              text.startsWith("WITH incoming AS") ||
              text.startsWith("UPDATE mail.provider_bindings"),
          ),
          `quiet ${advance}: no refs, folders, removal, flags or binding usage work`,
        ).toBeFalse();
        expect(await usage(), `quiet ${advance}: timestamps untouched`).toEqual(before);
        expect((await counts()).live, `quiet ${advance}: nothing visible`).toBe(0);
      }
      await sql<
        []
      >`UPDATE mail.remote_resources SET last_sync_at = now() - interval '2 minutes' WHERE id = ${source.args.remoteResourceId}::uuid`;
      const stale = await usage();
      await commitJmapAccountBatch(await prepared());
      const refreshed = await usage();
      expect(refreshed[0]?.last_sync_at, "quiet: due sync time refreshed").not.toEqual(stale[0]?.last_sync_at);
      expect(refreshed[0]?.last_used_at, "quiet: binding never touched").toEqual(before[0]?.last_used_at);
    } finally {
      await meter.close();
    }
  });
  test("durability: the live wake sees committed rows; losing it leaves live and receipt outboxes intact", async () => {
    const observations: Promise<void>[] = [];
    const observe = () => {
      observations.push(
        (async () => {
          expect(await state(), "wake: checkpoint already visible on another connection").toEqual({ ...initial, emailState: "Email:1" });
          expect(await counts(), "wake: durable receipt/live before delivery").toMatchObject({ receipts: 1, live: 1, hydration: 0 });
        })(),
      );
    };
    live.mockImplementation(observe);
    change(message("durable"));
    await run();
    await Promise.all(observations);
    expect(live, "wake: once").toHaveBeenCalledTimes(1);
    expect(await counts(), "lost wakes: rows persist without publishing").toMatchObject({ receipts: 1, live: 1, hydration: 0 });
  });
  test("DATA-13: measured statement budgets are constant for keywords/removal and linear only for new memberships", async () => {
    const meter = await meterSql();
    const measured: Record<keyof typeof STATEMENT_BUDGET, number> = {
      unchanged: 0,
      statesOnly: 0,
      new1: 0,
      new7: 0,
      flags1: 0,
      flags7: 0,
      remove1: 0,
      remove7: 0,
      folders: 0,
    };
    async function measure(key: keyof typeof measured) {
      const batch = await prepared();
      measured[key] = (await meter.during(() => commitJmapAccountBatch({ ...batch, captureWorkflowTriggers: false }))).length;
    }
    try {
      await measure("unchanged");
      const stateBatch = await prepared();
      measured.statesOnly = (
        await meter.during(() =>
          commitJmapAccountBatch({
            ...stateBatch,
            batch: { ...stateBatch.batch, mailboxState: { oldState: "Mailbox:0", newState: "Mailbox:counters" } },
          }),
        )
      ).length;
      // Return the fixture to its original mailbox checkpoint outside the measured window.
      await sql<[]>`UPDATE mail.remote_resources SET sync_state = ${initial}::jsonb WHERE id = ${source.args.remoteResourceId}::uuid`;
      change(message("single"));
      await measure("new1");
      for (let index = 0; index < 7; index++) change(message(`batch${index}`));
      await measure("new7");
      change(message("single", { a: true }, { $seen: true }), "updated");
      await measure("flags1");
      for (let index = 0; index < 7; index++) change(message(`batch${index}`, { a: true }, { $seen: true }), "updated");
      await measure("flags7");
      source.f.journal.Email.push({ id: "single", kind: "destroyed" });
      await measure("remove1");
      for (let index = 0; index < 7; index++) source.f.journal.Email.push({ id: `batch${index}`, kind: "destroyed" });
      await measure("remove7");
      source.f.journal.Mailbox.push({ id: "a", kind: "updated" });
      const beforeState = await state();
      const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
      const delta = await readJmapMailboxDelta(
        source.args.session,
        source.args.authorization,
        source.args.accountId,
        "Mailbox:0",
        source.args.signal,
        source.f.dependencies,
      );
      const folderStatements = await meter.during(() =>
        commitJmapAccountBatch({ ...source.args, fence, beforeState, batch: { kind: "mailbox", delta } }),
      );
      measured.folders = folderStatements.length;
      expect(
        folderStatements.some(
          (text) =>
            text.startsWith("SELECT folder.id, folder.stable_key, ref.remote_folder_id") ||
            text.startsWith("SELECT ref.id") ||
            text.startsWith("WITH stale AS") ||
            text.startsWith("WITH incoming AS"),
        ),
        "folder batch: no second folder load and no email work",
      ).toBeFalse();
      // The line names the measured values when a budget fails.
      console.info("JMAP_STATEMENTS", JSON.stringify(measured));
      expect(measured, "budget: exact statement counts").toEqual(STATEMENT_BUDGET);
      expect(measured.new7 - measured.new1, "budget: only the shared ingest grows with new messages").toBe(
        6 * (measured.new1 - measured.flags1),
      );
    } finally {
      await meter.close();
    }
  });
});
