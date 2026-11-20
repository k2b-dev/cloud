import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import * as workflowStore from "@k2b/cloud/workflows/store";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import { projectJmapFolders } from "./bindings";
import { discoverJmapFolders } from "./connectors/jmap";
import { fetchJmapSession, JMAP_CORE } from "./connectors/jmap-client";
import { type JmapEmailDelta, readJmapEmailDelta, readJmapMailboxDelta } from "./connectors/jmap-delta";
import type { JmapEmailSnapshot } from "./connectors/jmap-email";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./connectors/jmap-fixture";
import { type JmapSyncState, readJmapSyncState } from "./connectors/jmap-sync-state";
import { commitJmapAccountBatch, syncJmapAccountDelta } from "./jmap-sync-runtime";
import { mailLive } from "./live";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { claimFence } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-20T00:00:00Z");
const initial: JmapSyncState = { version: 1, emailState: "Email:0", mailboxState: "Mailbox:0", scan: null };
// The driver pins measured values after the first gate; null intentionally checks ratios only.
const STATEMENT_BUDGET: Record<"unchanged" | "new1" | "new7" | "flags1" | "flags7" | "remove1" | "remove7" | "folders", number | null> = {
  unchanged: null,
  new1: null,
  new7: null,
  flags1: null,
  flags7: null,
  remove1: null,
  remove7: null,
  folders: null,
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
  let workflow: ReturnType<typeof spyOn<typeof workflowStore, "notifyWorkflowWorker">>;
  beforeAll(async () => {
    // The integration runner owns this file's disposable database.
    await migrate();
    await buildFolderIdentityIndexes();
  });
  beforeEach(async () => {
    setSystemTime(at);
    createAppEventTestHarness("mail", mailCapabilities);
    live = spyOn(mailLive, "wake").mockImplementation(() => {});
    workflow = spyOn(workflowStore, "notifyWorkflowWorker").mockImplementation(() => {});
    source = await setup();
  });
  afterEach(async () => {
    try {
      await source?.f.close();
    } finally {
      live?.mockRestore();
      workflow?.mockRestore();
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
  async function listen() {
    const definition = await workflowStore.createWorkflow({
      appId: "mail",
      scopeId: source.mailboxId,
      key: "jmap-arrival",
      name: "JMAP arrival fixture",
      author: { kind: "system" },
    });
    await sql<[]>`INSERT INTO mail.workflow_profile (id, mailbox_id, enabled)
      VALUES (${definition.id}::uuid, ${source.mailboxId}::uuid, true)`;
    const plan: WorkflowBoundPlan = {
      schemaVersion: 2,
      languageId: "mail",
      languageVersion: 1,
      sourceHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      catalogHash: "c".repeat(64),
      actionPolicies: {},
      inputs: [],
      triggers: [],
      steps: [],
      bindings: {},
    };
    await workflowStore.publishWorkflowVersion({
      workflowId: definition.id,
      source: "steps: []\n",
      plan,
      activations: [{ key: "received", eventType: "mail.messageReceived" }],
      activate: true,
      author: { kind: "system" },
    });
  }
  const workflowRows = async () => {
    const [row] = await sql<{ events: number; deliveries: number }[]>`SELECT
      (SELECT count(*)::int FROM workflows.event WHERE app_id = 'mail' AND scope_id = ${source.mailboxId}) AS events,
      (SELECT count(*)::int FROM workflows.event_delivery delivery JOIN workflows.event event ON event.id = delivery.event_id
        WHERE event.app_id = 'mail' AND event.scope_id = ${source.mailboxId}) AS deliveries`;
    if (!row) throw new Error("workflow: missing aggregate");
    return row;
  };
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
    if (beforeState.emailState === null) throw new Error("prepare: email state missing");
    const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "incremental");
    const delta = await readJmapEmailDelta(
      source.args.session,
      source.args.authorization,
      source.args.accountId,
      beforeState.emailState,
      source.args.signal,
      source.f.dependencies,
    );
    return { ...source.args, beforeState, fence, batch: { kind: "email" as const, delta } };
  };
  const placements = () => sql<
    { remote_id: string; flags: string[]; keywords: string[]; stale: boolean; deleted: boolean; message_id: string }[]
  >`
    SELECT ref.remote_id, p.flags, p.keywords, ref.stale_at IS NOT NULL AS stale, p.deleted_at IS NOT NULL AS deleted, ref.message_id
    FROM mail.remote_message_refs ref JOIN mail.message_placements p ON p.remote_message_ref_id = ref.id
    JOIN mail.folders f ON f.id = ref.folder_id WHERE f.remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY ref.remote_id, f.stable_key
  `;

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
    await listen();
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
    expect(await workflowRows(), "replay and moves: exactly one durable trigger").toEqual({ events: 1, deliveries: 1 });
  });
  for (const excluded of ["disabled", "updated", "trash", "junk", "outbound"] as const) {
    test(`receipt exclusion: ${excluded}`, async () => {
      await listen();
      const email = message("excluded", excluded === "trash" || excluded === "junk" ? { a: true, [excluded]: true } : { a: true });
      if (excluded === "outbound") email.from = [{ name: null, email: "own@example.invalid" }];
      change(email, excluded === "updated" ? "updated" : "created");
      await run(excluded !== "disabled");
      expect(await counts(), `${excluded}: stored without receipt`).toMatchObject({ contents: 1, receipts: 0 });
      if (excluded !== "outbound") expect(workflow, `${excluded}: no eligible ingest, no workflow wake`).not.toHaveBeenCalled();
      expect(await workflowRows(), `${excluded}: no durable trigger`).toEqual({ events: 0, deliveries: 0 });
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
  test("folders: rename, rights, creation precede email; destroyed folder retires memberships", async () => {
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
    expect(await counts(), "folders: deletion hides placement").toMatchObject({ contents: 1, active: 0 });
  });
  test("destroyed folder: membership retirement does not depend on a surviving binding-folder ref", async () => {
    change(message("oldbinding"));
    await run();
    await sql<[]>`DELETE FROM mail.binding_folder_refs WHERE binding_id = ${source.args.bindingId}::uuid AND remote_folder_id = 'a'`;
    source.f.journal.Mailbox.push({ id: "a", kind: "destroyed" });
    await run();
    expect(await counts(), "destroyed folder: resource-wide retirement").toMatchObject({ contents: 1, active: 0 });
    expect((await placements())[0], "destroyed folder: stale locator").toMatchObject({ stale: true, deleted: true });
  });
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
    await listen();
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
    const beforeRun = await runs(),
      beforeWorkflows = await workflowRows();
    await expect(commitJmapAccountBatch(batch), "rollback: identity error").rejects.toMatchObject({
      code: "JMAP_MESSAGE_IDENTITY_CONFLICT",
    });
    expect(await counts(), "rollback: content and outboxes").toEqual(before);
    expect(await state(), "rollback: checkpoint").toEqual(beforeState);
    expect(await runs(), "rollback: run").toEqual(beforeRun);
    expect(await workflowRows(), "rollback: durable workflow jobs").toEqual(beforeWorkflows);
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
          ? { kind: "email" as const, delta }
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
  test("counter-only folder progress preserves the email axis without a visible invalidation", async () => {
    source.f.controls.updatedProperties = ["totalEmails"];
    source.f.journal.Mailbox.push({ id: "a", kind: "updated" });
    change(message("aftercounters"));
    expect(await run(), "counters: one folder checkpoint").toMatchObject({
      status: "committed",
      hasMore: true,
      stats: { folders: 0, imported: 0 },
    });
    expect(await state(), "counters: email waits").toEqual({ ...initial, mailboxState: "Mailbox:1" });
    expect((await counts()).live, "counters: no visible changes").toBe(0);
    expect(await run(), "counters: next call reads email").toMatchObject({ status: "committed", hasMore: false, stats: { imported: 1 } });
  });
  test("durability: both wakes see committed rows; losing wakes leaves live and receipt outboxes intact", async () => {
    await listen();
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
    workflow.mockImplementation(observe);
    change(message("durable"));
    await run();
    await Promise.all(observations);
    expect(live, "wake: once").toHaveBeenCalledTimes(1);
    expect(workflow, "workflow wake: once").toHaveBeenCalledTimes(1);
    expect(await counts(), "lost wakes: rows persist without publishing").toMatchObject({ receipts: 1, live: 1, hydration: 0 });
    expect(await workflowRows(), "lost wake: durable workflow event and pinned delivery").toEqual({ events: 1, deliveries: 1 });
  });
  test("DATA-13: measured statement budgets are constant for keywords/removal and linear only for new memberships", async () => {
    const meter = await meterSql();
    const measured: Record<keyof typeof STATEMENT_BUDGET, number> = {
      unchanged: 0,
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
      measured.folders = (
        await meter.during(() => commitJmapAccountBatch({ ...source.args, fence, beforeState, batch: { kind: "mailbox", delta } }))
      ).length;
      console.info("JMAP_STATEMENTS", JSON.stringify(measured));
      expect(measured.new7, "budget: linear ingest upper bound").toBeLessThanOrEqual(
        measured.unchanged + 7 * (measured.new1 - measured.unchanged),
      );
      expect(measured.flags7, "budget: batch flags").toBe(measured.flags1);
      expect(measured.remove7, "budget: batch removal and keep").toBe(measured.remove1);
      for (const [key, actual] of Object.entries(measured)) {
        const expected = Object.entries(STATEMENT_BUDGET).find(([name]) => name === key)?.[1];
        if (typeof expected === "number") expect(actual, `budget: ${key}`).toBe(expected);
      }
    } finally {
      await meter.close();
    }
  });
});
