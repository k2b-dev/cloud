import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { toPgUuidArray } from "@k2b/cloud/services/postgres";
import type { WorkflowBoundPlan } from "@k2b/cloud/workflows";
import * as workflowStore from "@k2b/cloud/workflows/store";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import { type JmapAccountScan, type JmapSyncState, readJmapSyncState } from "./connectors/jmap-account-state";
import { fetchJmapSession, JMAP_CORE } from "./connectors/jmap-client";
import type { JmapEmailSnapshot } from "./connectors/jmap-email";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./connectors/jmap-fixture";
import { type JmapScanPage, readJmapAccountStart, readJmapScanPage } from "./connectors/jmap-scan";
import { waitForBlockedCommit } from "./jmap-lock-fixture";
import {
  commitJmapAccountBatch,
  JMAP_SCAN_RESTART_LIMIT,
  type JmapAccountScanResult,
  jmapVerifyPageQuery,
  startJmapAccountScan,
  syncJmapAccountDelta,
  syncJmapAccountScan,
} from "./jmap-sync-runtime";
import { mailLive } from "./live";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { claimFence } from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-20T00:00:00Z");
// Measured in the gate, BEGIN and COMMIT included, for the commit of one step (the reads before it
// are outside the window). The driver records them after the first gate; until then only the
// ratios are checked. Only a new membership costs per message: the shared ingestEnvelope.
const STATEMENT_BUDGET: Record<
  "start5" | "new1" | "new7" | "known7" | "flags7" | "restart" | "verify1" | "verify7" | "verifyNone" | "deltaRequired",
  number | null
> = {
  start5: null,
  new1: null,
  new7: null,
  known7: null,
  flags7: null,
  restart: null,
  verify1: null,
  verify7: null,
  verifyNone: null,
  // The whole scan call that yields to a pending delta: read, fence and removing its own run.
  deltaRequired: null,
};
let sequence = 0;
const uuid = () => `00000000-004c-4000-8000-${String(++sequence).padStart(12, "0")}`;
const shortId = () => `K${String(++sequence).padStart(5, "0")}`;
// Fictional seconds of one minute.
const second = (value: string) => `2026-11-19T10:00:${value}Z`;
const message = (
  id: string,
  received = "00",
  mailboxIds: Record<string, boolean> = { a: true },
  keywords: Record<string, boolean> = {},
): JmapEmailSnapshot => ({
  ...fixtureEmail(id),
  receivedAt: second(received),
  mailboxIds,
  keywords,
  subject: id,
  from: [{ name: null, email: `${id.toLowerCase()}@example.invalid` }],
});

suite("JMAP account scan", () => {
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
  /** An uninitialized JMAP account: no checkpoint and no folders yet. */
  async function setup() {
    const f = createJmapFixture();
    try {
      f.session.capabilities[JMAP_CORE].maxObjectsInGet = 3;
      f.mailboxes.push(
        fixtureMailbox("trash", "Trash", null, "trash"),
        fixtureMailbox("junk", "Junk", null, "junk"),
        fixtureMailbox("drafts", "Drafts", null, "drafts"),
      );
      // Journal states the email and mailbox deltas accept after the start ("Email:1", "Mailbox:1").
      f.journal.Email.push({ id: "seed", kind: "destroyed" });
      f.journal.Mailbox.push({ id: "a", kind: "updated" });
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
      >`INSERT INTO mail.mailboxes (id, short_id, name, health) VALUES (${mailboxId}::uuid, ${shortId()}, 'JMAP scan fixture', 'active')`;
      await sql<
        []
      >`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active')`;
      await sql<[]>`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret)
        VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'own@example.invalid', 'reader', 'jmap',
          'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password', 'fictional-unused')`;
      await sql<
        []
      >`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator, verification_evidence, verified_scope_fingerprint)
        VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId: evidence.accountId }}::jsonb, ${evidence}::jsonb, ${fingerprint})`;
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
        // Scan and verify ignore this: they never receive.
        captureWorkflowTriggers: true,
      };
      return { f, args, mailboxId, connectionId };
    } catch (error) {
      await f.close();
      throw error;
    }
  }
  async function listen() {
    const definition = await workflowStore.createWorkflow({
      appId: "mail",
      scopeId: source.mailboxId,
      key: "jmap-scan-arrival",
      name: "JMAP scan arrival fixture",
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
  const storedState = async () => {
    const [row] = await sql<
      { sync_state: unknown }[]
    >`SELECT sync_state FROM mail.remote_resources WHERE id = ${source.args.remoteResourceId}::uuid`;
    if (!row) throw new Error("state: resource missing");
    return readJmapSyncState(row.sync_state);
  };
  const state = async () => {
    const value = await storedState();
    if (!value) throw new Error("state: checkpoint missing");
    return value;
  };
  const scanOf = async (): Promise<JmapAccountScan | null> => (await state()).scan;
  /** Replace the running scan's step outside a measured or raced window. */
  const setScan = async (change: Partial<JmapAccountScan>) => {
    const current = await state();
    if (!current.scan) throw new Error("setScan: no scan");
    const next: JmapSyncState = { ...current, scan: { ...current.scan, ...change } };
    await sql<[]>`UPDATE mail.remote_resources SET sync_state = ${next}::jsonb WHERE id = ${source.args.remoteResourceId}::uuid`;
  };
  const counts = async () => {
    const [row] = await sql<
      { contents: number; refs: number; active: number; receipts: number; live: number; folders: number; hydration: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM mail.message_contents WHERE mailbox_id = ${source.mailboxId}::uuid) AS contents,
        (SELECT count(*)::int FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id WHERE folder.remote_resource_id = ${source.args.remoteResourceId}::uuid) AS refs,
        (SELECT count(*)::int FROM mail.message_placements p JOIN mail.folders f ON f.id = p.folder_id WHERE f.remote_resource_id = ${source.args.remoteResourceId}::uuid AND p.deleted_at IS NULL) AS active,
        (SELECT count(*)::int FROM events.outbox e JOIN mail.message_contents c ON c.short_id = e.payload->'subject'->>'id'
          WHERE c.mailbox_id = ${source.mailboxId}::uuid AND e.app_id = 'mail' AND e.kind = 'event' AND e.payload->>'type' = 'mail.message.received') AS receipts,
        (SELECT count(*)::int FROM events.outbox WHERE app_id = 'mail' AND kind = 'live' AND ordering_key = ${source.mailboxId}) AS live,
        (SELECT count(*)::int FROM mail.folders WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid) AS folders,
        (SELECT count(*)::int FROM mail.hydration_work WHERE mailbox_id = ${source.mailboxId}::uuid) AS hydration
    `;
    if (!row) throw new Error("counts: aggregate missing");
    return row;
  };
  const placements = () => sql<
    {
      remote_id: string | null;
      mailbox: string | null;
      flags: string[];
      keywords: string[];
      stale: boolean;
      deleted: boolean;
      message_id: string;
    }[]
  >`
    SELECT ref.remote_id, folder_ref.remote_folder_id AS mailbox, p.flags, p.keywords, ref.stale_at IS NOT NULL AS stale,
      p.deleted_at IS NOT NULL AS deleted, ref.message_id
    FROM mail.remote_message_refs ref JOIN mail.message_placements p ON p.remote_message_ref_id = ref.id
    JOIN mail.folders f ON f.id = ref.folder_id
    LEFT JOIN mail.binding_folder_refs folder_ref ON folder_ref.folder_id = f.id AND folder_ref.binding_id = ${source.args.bindingId}::uuid
    WHERE f.remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY ref.remote_id, folder_ref.remote_folder_id
  `;
  /** Active JMAP memberships as `emailId:mailboxId`, to compare with the server's mailboxIds. */
  const projection = async () =>
    (await placements())
      .filter((row) => row.remote_id !== null && !row.stale && !row.deleted)
      .map((row) => `${row.remote_id}:${row.mailbox}`)
      .sort();
  const serverProjection = () =>
    source.f.emails.flatMap((email) => Object.keys(email.mailboxIds).map((mailbox) => `${email.id}:${mailbox}`)).sort();
  const runs = () =>
    sql<{ kind: string; state: string; error_code: string | null }[]>`SELECT kind, state, error_code FROM mail.sync_runs
      WHERE remote_resource_id = ${source.args.remoteResourceId}::uuid ORDER BY fence_token`;
  const fenceToken = async () => {
    const [row] = await sql<{ token: number }[]>`SELECT current_fence_token::int AS token FROM mail.remote_resources
      WHERE id = ${source.args.remoteResourceId}::uuid`;
    return row?.token;
  };
  /** Server-side change that the email delta also reports. */
  function change(email: JmapEmailSnapshot, kind: "created" | "updated" = "created") {
    put(email);
    source.f.journal.Email.push({ id: email.id, kind });
  }
  /** Server-side change the delta never reports: only a scan or its verify pass can see it. */
  function put(email: JmapEmailSnapshot) {
    const index = source.f.emails.findIndex((item) => item.id === email.id);
    if (index < 0) source.f.emails.push(email);
    else source.f.emails[index] = email;
  }
  function remove(id: string, journal = true) {
    const index = source.f.emails.findIndex((item) => item.id === id);
    if (index >= 0) source.f.emails.splice(index, 1);
    if (journal) source.f.journal.Email.push({ id, kind: "destroyed" });
  }
  const startScan = (reason: JmapAccountScan["reason"] = "initial") => startJmapAccountScan({ ...source.args, reason });
  const step = (signal = source.args.signal) => syncJmapAccountScan({ ...source.args, signal });
  /** Scan steps until the end; a step that yields to new mail runs the delta first, as the job will. */
  async function scanToEnd(between: Record<number, () => void> = {}) {
    const trace: Array<{ result: JmapAccountScanResult; scan: JmapAccountScan | null }> = [];
    for (let turn = 0; turn < 60; turn++) {
      const result = await step();
      trace.push({ result, scan: await scanOf() });
      if (result.status === "delta_required") await deltaToEnd();
      else if (result.status !== "committed") throw new Error(`scan: unexpected ${JSON.stringify(result)}`);
      between[turn]?.();
      if (result.status === "committed" && result.scanComplete) return trace;
    }
    throw new Error("scan: no end");
  }
  async function deltaToEnd() {
    for (let turn = 0; turn < 20; turn++) {
      const result = await syncJmapAccountDelta(source.args);
      if (result.status !== "committed") throw new Error(`delta: unexpected ${JSON.stringify(result)}`);
      if (!result.hasMore) return;
    }
    throw new Error("delta: no end");
  }
  /** A scan step read under its own fence, for commits a test holds or measures. */
  async function preparedScan() {
    const beforeState = await state();
    const scanStep = beforeState.scan?.step;
    if (!scanStep || scanStep.kind === "verify") throw new Error("prepared scan: no page step");
    const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "reconcile");
    const page = await readJmapScanPage(
      source.args.session,
      source.args.authorization,
      source.args.accountId,
      scanStep,
      source.args.signal,
      source.f.dependencies,
    );
    return { ...source.args, fence, beforeState, batch: { kind: "scan" as const, page } };
  }

  test("start: an empty checkpoint projects the folder snapshot and begins a scan at the newest mail", async () => {
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    expect(await startScan(), "start: committed").toMatchObject({ status: "committed", stats: { folders: 6, memberships: 0 } });
    const started = await state();
    expect(started, "start: checkpoint from the start reads").toEqual({
      version: 2,
      emailState: "Email:1",
      mailboxState: "Mailbox:1",
      scan: {
        reason: "initial",
        startedAt: expect.any(String),
        step: { kind: "query", before: null },
        pages: 0,
        restarts: 0,
        stalledAt: null,
      },
    });
    expect(Date.parse(started.scan?.startedAt ?? ""), "start: database time").toBeGreaterThanOrEqual(clock?.now.getTime() ?? Number.NaN);
    expect(await counts(), "start: folders and one live invalidation, no mail").toMatchObject({
      folders: 6,
      contents: 0,
      refs: 0,
      live: 1,
      hydration: 0,
    });
    expect(live, "start: one wake after the commit").toHaveBeenCalledTimes(1);
    expect(await runs(), "start: its run is kept").toEqual([{ kind: "reconcile", state: "completed", error_code: null }]);
    expect(await startScan(), "start: initial needs an uninitialized account").toEqual({
      status: "superseded",
      cause: "account_changed",
    });
    expect(await fenceToken(), "start: a refused initial claims no fence").toBe(1);
  });

  test("start: a moving state ends the run visibly and writes nothing", async () => {
    let gets = 0;
    source.f.controls.transform = ([name, args, id]) =>
      name === "Mailbox/get" && ++gets > 1 ? [name, { ...args, state: "moved" }, id] : [name, args, id];
    expect(await startScan(), "changed: retry").toEqual({ status: "retry" });
    expect(await storedState(), "changed: checkpoint stays NULL").toBeNull();
    expect(await counts(), "changed: no folder or invalidation").toMatchObject({ folders: 0, live: 0 });
    expect(await runs(), "changed: terminal run").toEqual([
      { kind: "reconcile", state: "stale_fence", error_code: "JMAP_SCAN_START_CHANGED" },
    ]);
    expect(live, "changed: no wake").not.toHaveBeenCalled();
  });

  test("start: reconciliation over a running scan begins again and leaves every mail ref visible", async () => {
    put(message("KEEP", "10"));
    await startScan();
    await scanToEnd();
    put(message("MID", "05"));
    await startScan("reconciliation");
    await step();
    expect((await scanOf())?.pages, "restart: one page").toBe(1);
    // The server lost KEEP; only the verify pass of a complete scan may remove it.
    remove("KEEP", false);
    const before = await placements();
    const liveBefore = (await counts()).live;
    expect(await startScan("reconciliation"), "restart: committed").toMatchObject({ status: "committed" });
    expect(await scanOf(), "restart: a new scan").toMatchObject({
      reason: "reconciliation",
      step: { kind: "query", before: null },
      pages: 0,
      restarts: 0,
    });
    expect(await placements(), "restart: no ref removed or marked stale").toEqual(before);
    expect((await counts()).live, "restart: unchanged folders do not invalidate").toBe(liveBefore);
  });

  for (const race of ["fence", "generation", "revision", "pause", "deleted"] as const) {
    test(`start: ${race} between the reads and the commit invalidates the start`, async () => {
      let raced = false;
      source.f.controls.handle = async (request) => {
        if (request.method !== "POST" || raced) return undefined;
        raced = true;
        if (race === "fence") await claimFence(source.args.remoteResourceId, source.args.bindingId, "reconcile");
        if (race === "generation")
          await sql<
            []
          >`UPDATE mail.remote_resources SET sync_generation = sync_generation + 1 WHERE id = ${source.args.remoteResourceId}::uuid`;
        if (race === "revision")
          await sql<[]>`UPDATE mail.provider_connections SET secret_revision = 2 WHERE id = ${source.connectionId}::uuid`;
        if (race === "pause") await sql<[]>`UPDATE mail.mailboxes SET sync_enabled = false WHERE id = ${source.mailboxId}::uuid`;
        if (race === "deleted") await sql<[]>`UPDATE mail.mailboxes SET deleted_at = ${at} WHERE id = ${source.mailboxId}::uuid`;
        return undefined;
      };
      expect(await startScan(), `${race}: superseded`).toEqual({ status: "superseded", cause: "account_changed" });
      expect(await storedState(), `${race}: checkpoint stays NULL`).toBeNull();
      expect(await counts(), `${race}: no folder projected`).toMatchObject({ folders: 0, live: 0 });
      expect(live, `${race}: no wake`).not.toHaveBeenCalled();
    });
  }

  test("scan: the plan race with N=3 ends with scan = null and the server's projection", async () => {
    await listen();
    for (const [id, at] of [
      ["A", "10"],
      ["B", "09"],
      ["C", "08"],
      ["D", "08"],
      ["E", "08"],
      ["F", "08"],
      ["G", "07"],
      ["H", "06"],
    ] as const)
      put(message(id, at));
    await startScan();
    // Each journaled change makes the next step yield to the delta, which then removes A and C and
    // receives X, Y and Z; the scan reads Y and Z later as known mail.
    const trace = await scanToEnd({
      0: () => {
        remove("A");
        change(message("X", "11"));
        change(message("Y", "05"));
      },
      3: () => {
        remove("C");
        change(message("Z", "08"));
      },
    });
    const bucket = (position: number) => ({
      kind: "bucket",
      second: second("08"),
      position,
      queryState: position ? expect.any(String) : null,
    });
    expect(
      trace.map(({ result, scan }): unknown[] => [
        result.status,
        result.status === "committed" ? result.stats.imported : null,
        scan?.step ?? null,
        scan?.restarts ?? null,
      ]),
      "race: every step and its counters",
    ).toEqual([
      ["committed", 2, { kind: "query", before: second("09") }, 0],
      ["delta_required", null, { kind: "query", before: second("09") }, 0],
      ["committed", 0, bucket(0), 0],
      ["committed", 3, bucket(3), 0],
      // A changed Email state comes first and counts no restart; the changed list then does.
      ["delta_required", null, bucket(3), 0],
      ["committed", 0, bucket(0), 1],
      ["committed", 1, bucket(3), 1],
      ["committed", 0, { kind: "query", before: second("08") }, 0],
      ["committed", 2, { kind: "verify", afterEmailId: null }, 0],
      // Active local IDs B, D..H, X, Y, Z in byte order, three per page.
      ["committed", 0, { kind: "verify", afterEmailId: "E" }, 0],
      ["committed", 0, { kind: "verify", afterEmailId: "H" }, 0],
      ["committed", 0, { kind: "verify", afterEmailId: "Z" }, 0],
      ["committed", 0, null, null],
    ]);
    expect(
      trace.every(({ result }) => result.status !== "committed" || result.stats.removed === 0),
      "race: the delta removed A and C before any scan commit could",
    ).toBeTrue();
    expect((await state()).emailState, "race: the delta caught up").toBe("Email:6");
    expect(await projection(), "race: projection equals the server").toEqual(serverProjection());
    expect(await scanOf(), "race: no scan left").toBeNull();
    expect(await counts(), "race: X, Y and Z each arrived once, through the delta").toMatchObject({ receipts: 3, hydration: 0 });
    expect(await workflowRows(), "race: one durable trigger each").toEqual({ events: 3, deliveries: 3 });
    expect(
      (await runs()).filter((run) => run.state !== "completed"),
      "race: yielding steps leave no failed run",
    ).toEqual([]);
  });

  test("scan: mail after the start, scan before the delta: the scan yields and the mail arrives exactly once", async () => {
    await listen();
    put(message("OLD", "10"));
    await startScan();
    await setScan({ restarts: 2 });
    change(message("NEWMAIL", "30"));
    const before = await state();
    expect(await step(), "yield: the delta comes first").toEqual({ status: "delta_required" });
    expect(await state(), "yield: scan step and restart count unchanged").toEqual(before);
    expect(await counts(), "yield: nothing imported").toMatchObject({ contents: 0, refs: 0, receipts: 0 });
    expect(await runs(), "yield: no run left behind").toEqual([{ kind: "reconcile", state: "completed", error_code: null }]);
    await deltaToEnd();
    expect(await counts(), "delta: one arrival").toMatchObject({ contents: 1, receipts: 1 });
    await scanToEnd();
    expect(await counts(), "scan: still one arrival").toMatchObject({ contents: 2, receipts: 1 });
    expect(await workflowRows(), "scan: one durable trigger").toEqual({ events: 1, deliveries: 1 });
    expect(await projection(), "scan: projection equals the server").toEqual(serverProjection());
  });

  test("start: repair keeps the Email state and takes the mailbox state from the snapshot", async () => {
    await listen();
    put(message("OLD", "10"));
    await startScan();
    await scanToEnd();
    // Mail the delta has not read yet, and a folder change, before the repair.
    change(message("M1", "20"));
    change(message("M2", "21"));
    source.f.journal.Mailbox.push({ id: "b", kind: "updated" });
    expect(await startScan("repair"), "repair: committed").toMatchObject({ status: "committed" });
    expect(await state(), "repair: stored Email state, snapshot mailbox state").toMatchObject({
      emailState: "Email:1",
      mailboxState: "Mailbox:2",
      scan: { reason: "repair", step: { kind: "query", before: null }, pages: 0 },
    });
    expect(await step(), "repair: the delta catches up first").toEqual({ status: "delta_required" });
    await deltaToEnd();
    expect(await counts(), "repair: M1 and M2 arrive once each").toMatchObject({ receipts: 2 });
    await scanToEnd();
    expect(await counts(), "repair: the scan adds no arrival").toMatchObject({ contents: 3, receipts: 2 });
    expect(await workflowRows(), "repair: two durable triggers").toEqual({ events: 2, deliveries: 2 });
    expect(await projection(), "repair: projection equals the server").toEqual(serverProjection());
  });

  test("start: repair needs a stored Email state; reconciliation replaces both states", async () => {
    expect(await startScan("repair"), "repair: refused").toEqual({ status: "superseded", cause: "account_changed" });
    expect(await storedState(), "repair: checkpoint stays NULL").toBeNull();
    expect(await fenceToken(), "repair: no fence").toBe(0);
    expect(await counts(), "repair: no folder").toMatchObject({ folders: 0, live: 0 });
    put(message("OLD", "10"));
    await startScan();
    await scanToEnd();
    change(message("LOST", "20"));
    source.f.journal.Mailbox.push({ id: "b", kind: "updated" });
    expect(await startScan("reconciliation"), "reconciliation: committed").toMatchObject({ status: "committed" });
    expect(await state(), "reconciliation: both states from the server").toMatchObject({
      emailState: "Email:2",
      mailboxState: "Mailbox:2",
      scan: { reason: "reconciliation" },
    });
    await scanToEnd();
    // The documented loss: mail since the rejected state is found by the scan, without an arrival.
    expect(await counts(), "reconciliation: LOST without an arrival").toMatchObject({ contents: 2, receipts: 0 });
  });

  test("scan: an abort at each boundary reads the same step again and ends with the same projection", async () => {
    for (const [id, at] of [
      ["A", "10"],
      ["B", "09"],
      ["C", "08"],
      ["D", "07"],
    ] as const)
      put(message(id, at));
    await startScan();
    for (let turn = 0; turn < 20; turn++) {
      const before = await state();
      const controller = new AbortController();
      let aborted = false;
      source.f.controls.handle = (request) => {
        if (request.method === "POST" && !aborted) {
          aborted = true;
          controller.abort();
        }
        return undefined;
      };
      await expect(step(controller.signal), `abort ${turn}: before the commit`).rejects.toMatchObject({ code: "JMAP_ABORTED" });
      expect(await state(), `abort ${turn}: checkpoint unchanged`).toEqual(before);
      source.f.controls.handle = undefined;
      const result = await step();
      if (result.status !== "committed") throw new Error(`abort ${turn}: ${JSON.stringify(result)}`);
      if (result.scanComplete) break;
    }
    expect(await scanOf(), "abort: scan complete").toBeNull();
    expect(await projection(), "abort: projection equals the server").toEqual(serverProjection());
    expect(
      (await runs()).filter((run) => run.state === "failed").every((run) => run.error_code === "JMAP_SYNC_FAILED"),
      "abort: each aborted run ended visibly",
    ).toBeTrue();

    // Inside the transaction: the commit waits for a held binding, the signal aborts, the commit rolls back.
    put(message("LATE", "20"));
    await startScan("reconciliation");
    const before = await state();
    const projected = await projection();
    const writer = await sql.reserve();
    const controller = new AbortController();
    let scanning: Promise<PromiseSettledResult<JmapAccountScanResult>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("abort: missing backend");
      await writer<{ id: string }[]>`SELECT id FROM mail.provider_bindings WHERE id = ${source.args.bindingId}::uuid FOR NO KEY UPDATE`;
      scanning = Promise.allSettled([step(controller.signal)]);
      await waitForBlockedCommit(backend.pid);
      controller.abort();
      await writer<[]>`COMMIT`.simple();
      expect(await scanning, "abort: in the transaction").toMatchObject([{ status: "rejected", reason: { code: "JMAP_ABORTED" } }]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (scanning) await scanning;
    }
    expect(await state(), "abort in transaction: checkpoint unchanged").toEqual(before);
    expect(await projection(), "abort in transaction: no partial projection").toEqual(projected);
    expect(await step(), "abort in transaction: the same page commits on retry").toMatchObject({
      status: "committed",
      stats: { imported: 1 },
    });
  }, 30_000);

  test("scan: a delta committed between a page's read and commit supersedes it, and the reverse", async () => {
    put(message("OLD", "10"));
    put(message("OLDER", "05"));
    await startScan();
    // Read at the stored Email state; a delta commits before the page does.
    const batch = await preparedScan();
    change(message("NEW", "30"));
    expect(await syncJmapAccountDelta(source.args), "scan race: delta commits first").toMatchObject({ status: "committed" });
    expect(await commitJmapAccountBatch(batch), "scan race: page superseded").toEqual({ status: "superseded", cause: "account_changed" });
    expect(await state(), "scan race: delta state kept, scan step unchanged").toMatchObject({
      emailState: "Email:2",
      scan: { step: { kind: "query", before: null }, pages: 0 },
    });
    // The delta's fence ended the scan's run before the scan could commit.
    expect((await runs()).at(-2), "scan race: the scan's run ended").toMatchObject({ kind: "reconcile", state: "stale_fence" });
    expect(await step(), "scan race: read again").toMatchObject({ status: "committed" });
    expect(await state(), "scan race: both axes advance").toMatchObject({ emailState: "Email:2", scan: { pages: 1 } });

    let raced = false;
    source.f.controls.handle = async (request) => {
      if (request.method !== "POST" || raced) return undefined;
      raced = true;
      expect(await step(), "delta race: scan commits first").toMatchObject({ status: "committed" });
      return undefined;
    };
    change(message("NEWER", "40"));
    expect(await syncJmapAccountDelta(source.args), "delta race: superseded").toEqual({ status: "superseded", cause: "account_changed" });
    expect(await state(), "delta race: email axis unchanged, scan advanced").toMatchObject({
      emailState: "Email:2",
      scan: { step: { kind: "verify", afterEmailId: "OLDER" } },
    });
  });

  test("scan: an unknown mailbox writes nothing, not even the step", async () => {
    put(message("KNOWN", "10"));
    put(message("UNKNOWN", "09", { absent: true }));
    await startScan();
    const before = await state(),
      projected = await counts();
    expect(await step(), "unknown mailbox: folders first").toEqual({ status: "superseded", cause: "folders_required" });
    expect(await state(), "unknown mailbox: step unchanged").toEqual(before);
    expect(await counts(), "unknown mailbox: no partial page").toEqual(projected);
  });

  test("scan: known mail is brought to the read state without an arrival", async () => {
    await listen();
    put(message("MOVED", "10"));
    put(message("SECOND", "09"));
    put(message("FLAGGED", "08"));
    await startScan();
    await scanToEnd();
    const identities = new Map((await placements()).map((row) => [row.remote_id, row.message_id]));
    put(message("MOVED", "10", { b: true, c: true }));
    put(message("SECOND", "09", { a: true, b: true }));
    put(message("FLAGGED", "08", { a: true }, { $seen: true, $flagged: true, Project: true }));
    await startScan("reconciliation");
    await scanToEnd();
    expect(await projection(), "known: memberships equal the server").toEqual(serverProjection());
    const rows = await placements();
    expect(
      rows.filter((row) => row.remote_id === "MOVED").map((row) => [row.mailbox, row.stale, row.deleted]),
      "known: move retires the old membership",
    ).toEqual([
      ["a", true, true],
      ["b", false, false],
      ["c", false, false],
    ]);
    const flagged = rows.find((row) => row.remote_id === "FLAGGED");
    expect([...(flagged?.flags ?? [])].sort(), "known: flags").toEqual(["\\Flagged", "\\Seen"]);
    expect(flagged?.keywords, "known: keywords").toEqual(["Project"]);
    expect(
      rows.every((row) => identities.get(row.remote_id) === row.message_id),
      "known: one content per Email ID",
    ).toBeTrue();
    expect(await counts(), "known: no arrival").toMatchObject({ contents: 3, receipts: 0 });
    expect(await workflowRows(), "known: no trigger").toEqual({ events: 0, deliveries: 0 });
  });

  test("scan: restarts count, the limit stalls without fence or network, and the scan resumes after the pause", async () => {
    put(message("NEWEST", "30"));
    for (let index = 0; index < 7; index++) put(message(`SAME${index}`, "20"));
    await startScan();
    // Every bucket query answers with a new queryState, so each read past position 0 restarts.
    let queries = 0;
    source.f.controls.transform = ([name, args, id]) =>
      name === "Email/query" ? [name, { ...args, queryState: `moving-${++queries}` }, id] : [name, args, id];
    const results: JmapAccountScanResult[] = [];
    while (results.at(-1)?.status !== "stalled" && results.length < 30) results.push(await step());
    // Three pages reach the bucket's second page; then restart and page alternate until the limit.
    expect(
      results.map((result): string => result.status),
      "stall: the limit-th restart stalls",
    ).toEqual([...Array.from({ length: 3 + 2 * (JMAP_SCAN_RESTART_LIMIT - 1) }, () => "committed"), "stalled"]);
    const stalled = await scanOf();
    expect(stalled, "stall: counters").toMatchObject({
      restarts: JMAP_SCAN_RESTART_LIMIT,
      stalledAt: expect.any(String),
      step: { kind: "bucket", position: 0, queryState: null },
    });
    const [clock] = await sql<{ now: Date }[]>`SELECT now() AS now`;
    expect(Date.parse(stalled?.stalledAt ?? ""), "stall: database time").toBeLessThanOrEqual(clock?.now.getTime() ?? Number.NaN);
    source.f.controls.transform = undefined;
    const token = await fenceToken(),
      requests = source.f.requests.length;
    const stallAgo = (minutes: number) => sql<[]>`UPDATE mail.remote_resources SET sync_state = jsonb_set(sync_state, '{scan,stalledAt}',
        to_jsonb(to_char((now() - make_interval(mins => ${minutes}::int)) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
      WHERE id = ${source.args.remoteResourceId}::uuid`;
    expect(await step(), "stall: still waiting").toEqual({ status: "stalled" });
    await stallAgo(14);
    expect(await step(), "stall: 14 minutes later still waiting").toEqual({ status: "stalled" });
    expect(await fenceToken(), "stall: no fence").toBe(token);
    expect(source.f.requests.length, "stall: no network").toBe(requests);
    await stallAgo(16);
    expect(await step(), "stall: resumes after the pause").toMatchObject({ status: "committed" });
    expect(await scanOf(), "stall: fresh budget").toMatchObject({ restarts: 0, stalledAt: null });
    await scanToEnd();
    expect(await projection(), "stall: complete projection").toEqual(serverProjection());
  });

  test("scan: idle without a scan, and neither scan nor verify pass ever receives", async () => {
    await listen();
    const token = await fenceToken();
    expect(await step(), "idle: uninitialized").toEqual({ status: "idle" });
    expect(await fenceToken(), "idle: no fence").toBe(token);
    for (const [id, at] of [
      ["ONE", "10"],
      ["TWO", "09"],
      ["THREE", "08"],
      ["FOUR", "07"],
    ] as const)
      put(message(id, at));
    await startScan();
    // A new mail during the scan arrives once through the delta; the scan page that reads it later is silent.
    change(message("DURING", "50"));
    await deltaToEnd();
    expect(await counts(), "delta during scan: one arrival").toMatchObject({ receipts: 1 });
    await scanToEnd();
    expect(await scanOf(), "no arrival: scan complete").toBeNull();
    expect(await counts(), "no arrival: five mails, still one receipt").toMatchObject({ contents: 5, receipts: 1 });
    expect(await workflowRows(), "no arrival: one durable trigger").toEqual({ events: 1, deliveries: 1 });
    expect(workflow, "no arrival: the delta's wake only").toHaveBeenCalledTimes(1);
    expect(await step(), "idle: after the verify pass").toEqual({ status: "idle" });
  });

  test("verify: a scanned mail that the server deleted without a delta entry is removed, keeping the last placement", async () => {
    put(message("STAYS", "10"));
    put(message("GHOST", "20"));
    await startScan();
    expect(await step(), "ghost: the only page imports both").toMatchObject({ status: "committed", stats: { imported: 2 } });
    // Deleted without a delta entry, as when a server's journal coalesces a create and a delete.
    remove("GHOST", false);
    await deltaToEnd();
    expect(await projection(), "ghost: the delta never names it").toContain("GHOST:a");
    await sql<[]>`INSERT INTO mail.conversation_keeps (conversation_id, mailbox_id, kept_by_kind)
      SELECT cm.conversation_id, c.mailbox_id, 'system' FROM mail.conversation_messages cm
      JOIN mail.message_contents c ON c.id = cm.message_id
      JOIN mail.remote_message_refs ref ON ref.message_id = c.id
      WHERE c.mailbox_id = ${source.mailboxId}::uuid AND ref.remote_id = 'GHOST'`;
    const staying = (await placements()).filter((row) => row.remote_id === "STAYS");
    await scanToEnd();
    expect(
      (await placements()).find((row) => row.remote_id === "GHOST"),
      "ghost: stale but kept visible",
    ).toMatchObject({ stale: true, deleted: false });
    expect(
      (await placements()).filter((row) => row.remote_id === "STAYS"),
      "ghost: found IDs unchanged",
    ).toEqual(staying);
  });

  test("verify: pages through local IDs, never removes from a scan page and never touches IMAP refs", async () => {
    for (const [id, at] of [
      ["V1", "15"],
      ["V2", "14"],
      ["V3", "13"],
      ["V4", "12"],
      ["V5", "11"],
      ["V6", "10"],
      ["V7", "09"],
    ] as const)
      put(message(id, at));
    await startScan();
    await scanToEnd();
    const [first] = await placements();
    if (!first) throw new Error("imap: missing content");
    const [folder] = await sql<{ id: string }[]>`SELECT folder_id AS id FROM mail.binding_folder_refs
      WHERE binding_id = ${source.args.bindingId}::uuid AND remote_folder_id = 'a'`;
    if (!folder) throw new Error("imap: missing folder");
    const imapId = uuid();
    await sql<[]>`INSERT INTO mail.remote_message_refs (id, folder_id, message_id, uid_validity, uid)
      VALUES (${imapId}::uuid, ${folder.id}::uuid, ${first.message_id}::uuid, 42, 501)`;
    await sql<[]>`INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${imapId}::uuid, ${folder.id}::uuid, ${first.message_id}::uuid, ARRAY[]::text[], ARRAY['imap-label']::text[])`;
    const imap = () => sql<{ ref: unknown; placement: unknown }[]>`SELECT to_jsonb(ref) AS ref, to_jsonb(p) AS placement
      FROM mail.remote_message_refs ref JOIN mail.message_placements p ON p.remote_message_ref_id = ref.id WHERE ref.id = ${imapId}::uuid`;
    const imapBefore = await imap();

    await startScan("reconciliation");
    // V2 vanishes between the first page's query and get: the page reports it, and removes nothing.
    source.f.controls.afterEmailQuery = () => {
      remove("V2", false);
      remove("V6", false);
      source.f.controls.afterEmailQuery = undefined;
    };
    const verified: Array<string | null> = [];
    let complete = false;
    for (let turn = 0; turn < 30 && !complete; turn++) {
      const before = (await scanOf())?.step;
      const result = await step();
      if (result.status !== "committed") throw new Error(`verify: ${JSON.stringify(result)}`);
      complete = result.scanComplete;
      const scan = await scanOf();
      if (before?.kind === "verify") verified.push(scan?.step.kind === "verify" ? scan.step.afterEmailId : null);
      if (turn === 0) {
        expect(result.stats.removed, "scan page: no removal from notFound").toBe(0);
        expect(await projection(), "scan page: V2 still active").toContain("V2:a");
      }
    }
    expect(verified, "verify: the cursor advances three IDs at a time, then the scan ends").toEqual(["V3", "V6", null]);
    expect(await projection(), "verify: V2 and V6 removed").toEqual(serverProjection());
    expect(await imap(), "verify: IMAP ref and placement untouched").toEqual(imapBefore);
  });

  test("lock order: a role writer holding a folder and a start snapshot both finish", async () => {
    await startScan();
    const [folder] = await sql<{ id: string }[]>`SELECT folder_id AS id FROM mail.binding_folder_refs
      WHERE binding_id = ${source.args.bindingId}::uuid AND remote_folder_id = 'b'`;
    if (!folder) throw new Error("start lock: missing folder");
    const beforeState = await state();
    const fence = await claimFence(source.args.remoteResourceId, source.args.bindingId, "reconcile");
    const start = await readJmapAccountStart(
      source.args.session,
      source.args.authorization,
      source.args.accountId,
      source.args.signal,
      source.f.dependencies,
    );
    if (start.kind !== "ready") throw new Error("start lock: not ready");
    const batch = { ...source.args, fence, beforeState, batch: { kind: "start" as const, reason: "repair" as const, start } };
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      await writer<[]>`SET LOCAL lock_timeout = '10s'`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("start lock: missing backend");
      await writer<{ id: string }[]>`SELECT id FROM mail.folders WHERE id = ${folder.id}::uuid FOR UPDATE`;
      // The snapshot locks every folder of the account, this one included.
      committing = Promise.allSettled([commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid);
      await writer<[]>`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${source.mailboxId}::uuid, 'archive', ${folder.id}::uuid)`;
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "start lock: no deadlock or lock timeout").toMatchObject([
        { status: "fulfilled", value: { status: "committed", stats: { folders: 6 } } },
      ]);
      expect(
        await sql<{ role: string }[]>`SELECT role FROM mail.folder_role_overrides WHERE mailbox_id = ${source.mailboxId}::uuid`,
        "start lock: role writer also committed",
      ).toEqual([{ role: "archive" }]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("lock order: a role writer holding a folder and a scan page both finish", async () => {
    put(message("ROLELOCK", "10"));
    await startScan();
    const batch = await preparedScan();
    const [folder] = await sql<{ id: string }[]>`SELECT folder_id AS id FROM mail.binding_folder_refs
      WHERE binding_id = ${source.args.bindingId}::uuid AND remote_folder_id = 'a'`;
    if (!folder) throw new Error("role lock: missing folder");
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      await writer<[]>`SET LOCAL lock_timeout = '10s'`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("role lock: missing backend");
      await writer<{ id: string }[]>`SELECT id FROM mail.folders WHERE id = ${folder.id}::uuid FOR UPDATE`;
      committing = Promise.allSettled([commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid);
      // setFolderRole's write order: folder UPDATE lock, then override insert with mailbox KEY SHARE.
      await writer<[]>`INSERT INTO mail.folder_role_overrides (mailbox_id, role, folder_id)
        VALUES (${source.mailboxId}::uuid, 'archive', ${folder.id}::uuid)`;
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "role lock: no deadlock or lock timeout").toMatchObject([
        { status: "fulfilled", value: { status: "committed", stats: { imported: 1 } } },
      ]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("lock order: a command writer holding the mailbox and a scan page both finish", async () => {
    put(message("CMDLOCK", "10"));
    await startScan();
    const batch = await preparedScan();
    const writer = await sql.reserve();
    let committing: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commitJmapAccountBatch>>>[]> | undefined;
    try {
      await writer<[]>`BEGIN`.simple();
      await writer<[]>`SET LOCAL lock_timeout = '10s'`.simple();
      const [backend] = await writer<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      if (!backend) throw new Error("command lock: missing backend");
      // Command creation's order: the mailbox first, then the key-share check of commands.selected_binding_id.
      await writer<{ id: string }[]>`SELECT id FROM mail.mailboxes WHERE id = ${source.mailboxId}::uuid FOR UPDATE`;
      committing = Promise.allSettled([commitJmapAccountBatch(batch)]);
      await waitForBlockedCommit(backend.pid);
      await writer<{ id: string }[]>`SELECT id FROM mail.provider_bindings WHERE id = ${source.args.bindingId}::uuid FOR KEY SHARE`;
      await writer<[]>`COMMIT`.simple();
      expect(await committing, "command lock: no deadlock or lock timeout").toMatchObject([
        { status: "fulfilled", value: { status: "committed", stats: { imported: 1 } } },
      ]);
    } finally {
      await writer<[]>`ROLLBACK`.simple();
      writer.release();
      if (committing) await committing;
    }
  }, 30_000);

  test("DATA-13: scan and verify commits cost fixed statements; only new memberships grow per mail", async () => {
    source.args.session.core.maxObjectsInGet = 7;
    source.f.mailboxes.splice(
      source.f.mailboxes.findIndex((mailbox) => mailbox.id === "drafts"),
      1,
    );
    const meter = await meterSql();
    const measured: Record<keyof typeof STATEMENT_BUDGET, number> = {
      start5: 0,
      new1: 0,
      new7: 0,
      known7: 0,
      flags7: 0,
      restart: 0,
      verify1: 0,
      verify7: 0,
      verifyNone: 0,
      deltaRequired: 0,
    };
    const texts: Partial<Record<keyof typeof STATEMENT_BUDGET, string[]>> = {};
    const fence = () => claimFence(source.args.remoteResourceId, source.args.bindingId, "reconcile");
    async function measure(key: keyof typeof measured, batch: Parameters<typeof commitJmapAccountBatch>[0]["batch"]) {
      const params = { ...source.args, fence: await fence(), beforeState: await state(), batch };
      const statements = await meter.during(async () => {
        const result = await commitJmapAccountBatch(params);
        if (result.status !== "committed") throw new Error(`${key}: ${JSON.stringify(result)}`);
      });
      measured[key] = statements.length;
      texts[key] = statements;
    }
    const page = (objects: JmapEmailSnapshot[]): JmapScanPage => ({
      kind: "page",
      objects,
      notFoundIds: [],
      next: { kind: "query", before: second("30") },
      // The fixture's journal does not move in this test: pages are read at the stored state.
      emailState: "Email:1",
    });
    const batch7 = (keywords: Record<string, boolean> = {}) =>
      Array.from({ length: 7 }, (_, index) => message(`BATCH${index}`, "20", { a: true }, keywords));
    try {
      const start = await readJmapAccountStart(
        source.args.session,
        source.args.authorization,
        source.args.accountId,
        source.args.signal,
        source.f.dependencies,
      );
      if (start.kind !== "ready") throw new Error("start: not ready");
      expect(start.folders.length, "start: five folders").toBe(5);
      const startParams = {
        ...source.args,
        fence: await fence(),
        beforeState: null,
        batch: { kind: "start" as const, reason: "initial" as const, start },
      };
      measured.start5 = (await meter.during(() => commitJmapAccountBatch(startParams))).length;
      await measure("new1", { kind: "scan", page: page([message("SINGLE", "25")]) });
      await measure("new7", { kind: "scan", page: page(batch7()) });
      await measure("known7", { kind: "scan", page: page(batch7()) });
      await measure("flags7", { kind: "scan", page: page(batch7({ $seen: true })) });
      await measure("restart", {
        kind: "scan",
        page: { kind: "restart", next: { kind: "bucket", second: second("20"), position: 0, queryState: null }, emailState: "Email:1" },
      });
      const ids = batch7().map((email) => email.id);
      await setScan({ step: { kind: "verify", afterEmailId: null } });
      await measure("verifyNone", { kind: "verify", checkedIds: ids, notFoundIds: [] });
      await setScan({ step: { kind: "verify", afterEmailId: null } });
      await measure("verify1", { kind: "verify", checkedIds: ["SINGLE"], notFoundIds: ["SINGLE"] });
      expect(await scanOf(), "verify1: a short page ends the scan").toBeNull();
      await sql<[]>`UPDATE mail.remote_resources SET sync_state = ${{
        ...(await state()),
        scan: {
          reason: "initial",
          startedAt: at.toISOString(),
          step: { kind: "verify", afterEmailId: null },
          pages: 0,
          restarts: 0,
          stalledAt: null,
        },
      }}::jsonb WHERE id = ${source.args.remoteResourceId}::uuid`;
      await measure("verify7", { kind: "verify", checkedIds: ids, notFoundIds: ids });
      await setScan({ step: { kind: "query", before: null } });
      source.f.journal.Email.push({ id: "elsewhere", kind: "created" });
      const yielded = await meter.during(async () => {
        const result = await step();
        if (result.status !== "delta_required") throw new Error(`deltaRequired: ${JSON.stringify(result)}`);
      });
      measured.deltaRequired = yielded.length;
      texts.deltaRequired = yielded;
      // The line names the measured values for the budget.
      console.info("JMAP_SCAN_STATEMENTS", JSON.stringify(measured));
      for (const [key, budget] of Object.entries(STATEMENT_BUDGET))
        if (budget !== null) expect(measured[key as keyof typeof measured], `budget: ${key}`).toBe(budget);
      expect(measured.new7 - measured.new1, "budget: only the shared ingest grows with new messages").toBe(
        6 * (measured.new1 - measured.flags7),
      );
      expect(measured.known7, "budget: a page of known, unchanged mail writes less than a changed one").toBeLessThan(measured.flags7);
      expect(measured.verify7, "budget: removal is one batch for any count").toBe(measured.verify1);
      expect(measured.verifyNone, "budget: a verify page without absences removes nothing").toBeLessThan(measured.verify1);
      expect(
        texts.deltaRequired?.some((text) => text.startsWith("UPDATE mail.remote_resources SET sync_state")),
        "deltaRequired: no checkpoint write",
      ).toBeFalse();
      for (const key of ["restart", "verifyNone"] as const)
        expect(
          texts[key]?.some(
            (text) =>
              text.startsWith("WITH stale AS") || text.startsWith("WITH incoming AS") || text.startsWith("UPDATE mail.provider_bindings"),
          ),
          `${key}: no removal, flags or binding usage`,
        ).toBeFalse();
      expect(
        texts.known7?.some((text) => text.startsWith("UPDATE mail.provider_bindings")),
        "known7: quiet",
      ).toBeFalse();
    } finally {
      await meter.close();
    }
  });

  test("verify plan: one page of 80,000 active JMAP refs in 20 folders", async () => {
    const folderIds = Array.from({ length: 20 }, () => uuid());
    await sql<[]>`INSERT INTO mail.folders (id, short_id, remote_resource_id, stable_key, name)
      SELECT folder.id, 'P' || lpad(folder.ordinal::text, 5, '0'), ${source.args.remoteResourceId}::uuid,
        'verify-plan-' || folder.ordinal, 'Verify plan ' || folder.ordinal
      FROM unnest(${toPgUuidArray(folderIds)}::uuid[]) WITH ORDINALITY AS folder(id, ordinal)`;
    const contentId = uuid();
    await sql<[]>`INSERT INTO mail.message_contents (id, short_id, mailbox_id, subject, internal_date, content_hash)
      VALUES (${contentId}::uuid, ${shortId()}, ${source.mailboxId}::uuid, 'Verify plan', ${at}, ${"d".repeat(64)})`;
    // 76,000 Email IDs; the first 4,000 also have a second membership in the last folder.
    await sql<[]>`INSERT INTO mail.remote_message_refs (folder_id, message_id, remote_id)
      SELECT (${toPgUuidArray(folderIds)}::uuid[])[item / 4000 + 1], ${contentId}::uuid, 'E' || lpad((item % 76000)::text, 6, '0')
      FROM generate_series(0, 79999) AS item`;
    await sql`ANALYZE mail.folders`;
    await sql`ANALYZE mail.remote_message_refs`;
    const params = { remoteResourceId: source.args.remoteResourceId, afterEmailId: "E038000", limit: 500 };
    const rows = await jmapVerifyPageQuery(sql, params);
    const ids = rows.map((row) => row.email_id);
    expect(ids.length, "plan: at most one page").toBeLessThanOrEqual(params.limit);
    expect(ids, "plan: strictly after the cursor in byte order").toEqual(
      [...new Set(ids)].filter((id) => id > params.afterEmailId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    expect(ids[0], "plan: the next ID").toBe("E038001");
    type Plan = {
      "Node Type": string;
      "Actual Rows"?: number;
      "Actual Loops"?: number;
      "Rows Removed by Filter"?: number;
      "Relation Name"?: string;
      "Index Name"?: string;
      Plans?: Plan[];
    };
    const nodes = (plan: Plan): Plan[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const [explained] = await sql<{ "QUERY PLAN": [{ Plan: Plan; "Execution Time": number }] }[]>`
      EXPLAIN (ANALYZE, FORMAT JSON) ${jmapVerifyPageQuery(sql, params)}`;
    const plan = explained?.["QUERY PLAN"][0];
    if (!plan) throw new Error("plan: missing");
    const all = nodes(plan.Plan);
    const scans = all.filter((node) => node["Relation Name"]);
    // One line for the driver's index decision; no expectation on time.
    console.info(
      "JMAP_VERIFY_PLAN",
      JSON.stringify({
        nodes: all.map((node) => node["Node Type"] + (node["Index Name"] ? `(${node["Index Name"]})` : "")),
        rowsRead: scans.reduce(
          (sum, node) => sum + ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0)) * (node["Actual Loops"] ?? 1),
          0,
        ),
        refsIndexes: all
          .filter((node) => node["Index Name"]?.startsWith("remote_message_refs"))
          .map((node) => `${node["Node Type"]}(${node["Index Name"]})`),
        rows: plan.Plan["Actual Rows"],
        executionMs: plan["Execution Time"],
      }),
    );
  }, 60_000);
});
