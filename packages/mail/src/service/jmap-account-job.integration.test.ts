import { afterEach, beforeAll, beforeEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { redis, sql } from "@k2b/cloud";
import { createAppEventTestHarness } from "@k2b/cloud/events/testing";
import { encryptSecret } from "@k2b/cloud/services";
import { meterSql } from "../../../../scripts/fixtures/sql-meter";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { mailCapabilities } from "../capabilities";
import { newShortId } from "../lib/short-id";
import { buildFolderIdentityIndexes, migrate } from "../migrate";
import { type JmapSyncState, readJmapSyncState } from "./connectors/jmap-account-state";
import { JMAP_CORE, type JmapInvocation } from "./connectors/jmap-client";
import type { JmapEmailSnapshot } from "./connectors/jmap-email";
import { createJmapFixture, fixtureEmail, fixtureMailbox } from "./connectors/jmap-fixture";
import type { JmapTransportDependencies } from "./connectors/jmap-transport";
import * as accountAccess from "./jmap-account-access";
import { JMAP_RATE_LIMIT_MAX_MS, jmapCooldownMs } from "./jmap-account-failure";
import { jmapAccountRuntime, runJmapAccountJob } from "./jmap-account-job";
import { mailLive } from "./live";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import * as providerLeases from "./provider-operation-lock";
import {
  acquireProviderLease,
  mailProviderOperationMutex,
  onParkedProviderWaiterWake,
  providerBreakerOpenForMs,
  releaseProviderLease,
  resetProviderBreaker,
  wakeParkedProviderWaiter,
  withMailboxProviderOperationBarrier,
} from "./provider-operation-lock";
import * as pacer from "./provider-pacer";
import * as syncRuntime from "./sync-runtime";
import {
  type JmapAccountJobInput,
  jmapAccountJob,
  jmapAccountWaiter,
  startHydrationRuntime,
  stopHydrationRuntime,
  submitJmapAccountJob,
} from "./sync-runtime";

const suite = suiteFor("database", "nats", "valkey");
const at = new Date("2026-11-21T09:00:00Z");
const password = "fixture-only-password";
// Statements of whole job turns, BEGIN and COMMIT included. `null` until the first gate measured
// them (the JMAP_JOB_STATEMENTS line). Expected: a quiet turn reads the checkpoint (1), loads the
// account (2) and confirms (1); a turn with one new message adds the fence and the account commit;
// a turn that finds the lease held sends nothing (its own test holds it to 0).
const JOB_STATEMENT_BUDGET: Record<"quiet" | "newMail" | "busy", number | null> = { quiet: null, newMail: null, busy: null };
const noHeartbeat = async (): Promise<void> => undefined;
const codeOf = (error: unknown): unknown => (error instanceof Error ? Reflect.get(error, "code") : undefined);
// Fictional seconds of one minute.
const second = (value: string) => `2026-11-19T10:00:${value}Z`;
const message = (id: string, received = "00", mailboxIds: Record<string, boolean> = { a: true }): JmapEmailSnapshot => ({
  ...fixtureEmail(id),
  receivedAt: second(received),
  mailboxIds,
  subject: id,
  from: [{ name: null, email: `${id.toLowerCase()}@example.invalid` }],
});
const rfc822 = (id: string) =>
  Buffer.from(
    [
      "From: Sender <sender@example.invalid>",
      "To: Reader <reader@example.invalid>",
      "Date: Sat, 21 Nov 2026 08:00:00 +0000",
      `Message-ID: <${id}@example.invalid>`,
      "Subject: Account job fixture",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Fictional text.",
      "",
    ].join("\r\n"),
  );

type Turn = { result: Awaited<ReturnType<typeof runJmapAccountJob>>; next: JmapAccountJobInput | null; delayMs: number | null };

suite("JMAP account job", () => {
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
      source?.f.close();
    } finally {
      live?.mockRestore();
      setSystemTime();
    }
  });

  /**
   * An uninitialized JMAP account the loader can run: an approved origin, encrypted credentials and
   * an active binding. Random IDs: the lease line, pacer and cooldown live in Valkey.
   */
  async function setup(options: { syncState?: JmapSyncState } = {}) {
    const f = createJmapFixture();
    f.session.capabilities[JMAP_CORE].maxObjectsInGet = 3;
    f.mailboxes.push(fixtureMailbox("trash", "Trash", null, "trash"), fixtureMailbox("drafts", "Drafts", null, "drafts"));
    // Journal states the deltas accept after the start ("Email:1", "Mailbox:1").
    f.journal.Email.push({ id: "seed", kind: "destroyed" });
    f.journal.Mailbox.push({ id: "a", kind: "updated" });
    const mailboxId = crypto.randomUUID(),
      remoteResourceId = crypto.randomUUID(),
      connectionId = crypto.randomUUID(),
      bindingId = crypto.randomUUID();
    const evidence: JmapScopeEvidence = { version: 1, kind: "jmap", origin: f.origin, accountId: "d333333" };
    const fingerprint = jmapScopeFingerprint(evidence);
    await sql<
      []
    >`INSERT INTO mail.mailboxes (id, short_id, name, health) VALUES (${mailboxId}::uuid, ${newShortId()}, 'JMAP job fixture', 'active')`;
    await sql<
      []
    >`INSERT INTO mail.remote_resources (id, mailbox_id, connector_kind, remote_locator, server_identity, scope_fingerprint, status, sync_state)
      VALUES (${remoteResourceId}::uuid, ${mailboxId}::uuid, 'jmap', '{}'::jsonb, '{}'::jsonb, ${fingerprint}, 'active', ${options.syncState ?? null}::jsonb)`;
    await sql<[]>`INSERT INTO mail.provider_connections (id, owner_mailbox_id, name, email, username, connector_kind,
        imap_host, imap_port, imap_tls_mode, smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret, jmap_origin)
      VALUES (${connectionId}::uuid, ${mailboxId}::uuid, 'Fixture', 'own@example.invalid', 'reader', 'jmap',
        'mail.example.invalid', 993, 'implicit', 'mail.example.invalid', 465, 'implicit', 'password',
        ${await encryptSecret({ kind: "password", password })}, ${f.origin})`;
    await sql<
      []
    >`INSERT INTO mail.provider_bindings (id, remote_resource_id, connection_id, state, remote_locator, verification_evidence, verified_scope_fingerprint)
      VALUES (${bindingId}::uuid, ${remoteResourceId}::uuid, ${connectionId}::uuid, 'active', ${{ accountId: evidence.accountId }}::jsonb,
        ${evidence}::jsonb, ${fingerprint})`;
    await sql<[]>`INSERT INTO mail.sender_identities (id, short_id, mailbox_id, label, from_address, status)
      VALUES (${crypto.randomUUID()}::uuid, ${newShortId()}, ${mailboxId}::uuid, 'Fixture sender', 'own@example.invalid', 'verified')`;
    return { f, mailboxId, remoteResourceId, connectionId, bindingId };
  }

  /** One job turn the way the worker runs it, with the fixture's transport. */
  const turn = async (
    phase: JmapAccountJobInput["phase"],
    options: { signal?: AbortSignal; awaited?: boolean; transport?: JmapTransportDependencies } = {},
  ): Promise<Turn> => {
    const resubmitted: { next: JmapAccountJobInput | null; delayMs: number | null } = { next: null, delayMs: null };
    const input = { remoteResourceId: source.remoteResourceId, phase };
    const result = await runJmapAccountJob(
      {
        input,
        heartbeat: noHeartbeat,
        signal: options.signal ?? new AbortController().signal,
        resubmit: (resubmit) => {
          resubmitted.next = resubmit?.input ?? input;
          resubmitted.delayMs = resubmit?.delayMs ?? 0;
        },
      },
      { transport: options.transport ?? source.f.dependencies, awaited: options.awaited },
    );
    return { result, ...resubmitted };
  };
  const label = (value: Turn["result"]): string =>
    value.kind === "deferred"
      ? `deferred:${value.code}`
      : value.kind === "ended"
        ? `ended:${value.reason}`
        : `${value.kind}:${value.result.status}`;
  /** Runs continuations without delay until the job ends or waits; `before` stages server changes. */
  const drive = async (phase: JmapAccountJobInput["phase"], before: Record<number, () => void> = {}) => {
    const trace: string[] = [];
    let current = phase;
    for (let index = 0; index < 40; index++) {
      before[index]?.();
      const value = await turn(current);
      trace.push(label(value.result));
      if (!value.next || value.delayMs !== 0) return { trace, last: value };
      current = value.next.phase;
    }
    throw new Error(`drive: no end after ${trace.join(", ")}`);
  };
  const initialize = async () => {
    const { last } = await drive("scan");
    expect(last.next, "initialize: the job ends").toBeNull();
    expect((await state())?.scan, "initialize: no scan left").toBeNull();
  };
  const state = async () => {
    const [row] = await sql<
      { sync_state: unknown }[]
    >`SELECT sync_state FROM mail.remote_resources WHERE id = ${source.remoteResourceId}::uuid`;
    return readJmapSyncState(row?.sync_state ?? null);
  };
  const fenceToken = async () =>
    (
      await sql<
        { token: number }[]
      >`SELECT current_fence_token::int AS token FROM mail.remote_resources WHERE id = ${source.remoteResourceId}::uuid`
    )[0]?.token;
  const runs = () =>
    sql<{ kind: string; state: string; error_code: string | null }[]>`SELECT kind, state, error_code FROM mail.sync_runs
      WHERE remote_resource_id = ${source.remoteResourceId}::uuid ORDER BY fence_token`;
  const counts = async () => {
    const [row] = await sql<{ contents: number; refs: number; receipts: number }[]>`
      SELECT
        (SELECT count(*)::int FROM mail.message_contents WHERE mailbox_id = ${source.mailboxId}::uuid) AS contents,
        (SELECT count(*)::int FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id
          WHERE folder.remote_resource_id = ${source.remoteResourceId}::uuid AND ref.stale_at IS NULL) AS refs,
        (SELECT count(*)::int FROM events.outbox e JOIN mail.message_contents c ON c.short_id = e.payload->'subject'->>'id'
          WHERE c.mailbox_id = ${source.mailboxId}::uuid AND e.app_id = 'mail' AND e.kind = 'event' AND e.payload->>'type' = 'mail.message.received') AS receipts
    `;
    if (!row) throw new Error("counts: aggregate missing");
    return row;
  };
  const health = async () => {
    const [row] = await sql<
      { mailbox: string; resource: string; binding: string; connection: string; binding_error: string | null }[]
    >`SELECT mailbox.health AS mailbox, resource.status AS resource, binding.state AS binding, connection.status AS connection,
        binding.last_error_code AS binding_error
      FROM mail.remote_resources resource JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
      JOIN mail.provider_bindings binding ON binding.remote_resource_id = resource.id
      JOIN mail.provider_connections connection ON connection.id = binding.connection_id
      WHERE resource.id = ${source.remoteResourceId}::uuid`;
    return row;
  };
  const settled = { mailbox: "active", resource: "active", binding: "active", connection: "active", binding_error: null };
  const breakerRemembered = async () =>
    Number(await redis.send("EXISTS", [`mail:provider-lease-line:{${source.remoteResourceId}}:breaker`])) === 1;
  const leaseFree = async () => {
    const lock = await mailProviderOperationMutex().acquire({ resource: source.remoteResourceId, ttlMs: 5_000 });
    if (lock) await mailProviderOperationMutex().release(lock);
    return lock !== null;
  };
  function change(email: JmapEmailSnapshot, kind: "created" | "updated" = "created") {
    put(email);
    source.f.journal.Email.push({ id: email.id, kind });
  }
  function put(email: JmapEmailSnapshot) {
    const index = source.f.emails.findIndex((item) => item.id === email.id);
    if (index < 0) source.f.emails.push(email);
    else source.f.emails[index] = email;
  }
  /** A new message arrives through a delta turn; returns its content ID. */
  const arrive = async (id: string) => {
    source.f.blobs.set(`blob-${id}`, [rfc822(id)]);
    change({ ...message(id, "30"), size: rfc822(id).byteLength });
    expect((await turn("delta")).result, `${id}: arrives`).toMatchObject({
      kind: "delta",
      result: { status: "committed", stats: { imported: 1 } },
    });
    const [row] = await sql<{ message_id: string }[]>`SELECT ref.message_id FROM mail.remote_message_refs ref
      JOIN mail.folders folder ON folder.id = ref.folder_id
      WHERE folder.remote_resource_id = ${source.remoteResourceId}::uuid AND ref.remote_id = ${id} LIMIT 1`;
    if (!row) throw new Error(`arrive: ${id} missing`);
    return row.message_id;
  };
  const hydrate = (messageId: string) =>
    syncRuntime
      .hydrateMessageBatch(
        { input: { messageId }, heartbeat: noHeartbeat, resubmit: () => undefined },
        { jmapTransport: source.f.dependencies },
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
  /** Captures parked account waiters a release wakes, instead of queueing their job. */
  const captureWakes = () => {
    const woken: Array<{ waiter: string; left: string }> = [];
    const replaced = onParkedProviderWaiterWake(async (waiter, left) => {
      woken.push({ waiter, left });
    });
    return { woken, restore: () => onParkedProviderWaiterWake(replaced) };
  };

  // First in the file: the hydration runtime it starts finds no other account's work yet.
  test("drain: submissions of one account join one turn; stopping waits for it, frees the lease and queues nothing after", async () => {
    source.f.close();
    source = await setup({ syncState: { version: 2, emailState: "Email:1", mailboxState: "Mailbox:1", scan: null } });
    const gate = Promise.withResolvers<void>();
    let entered = 0;
    const loader = spyOn(accountAccess, "loadJmapAccountAccess").mockImplementation(async (params) => {
      if (params.remoteResourceId !== source.remoteResourceId) return { status: "unavailable", reason: "paused" };
      entered++;
      await gate.promise;
      return { status: "unavailable", reason: "paused" };
    });
    await startHydrationRuntime();
    const input = { remoteResourceId: source.remoteResourceId, phase: "delta" as const };
    try {
      await jmapAccountRuntime.start();
      for (let index = 0; index < 3; index++) expect(await submitJmapAccountJob(input), `submit ${index}`).toBeTrue();
      const deadline = performance.now() + 30_000;
      while (entered === 0) {
        if (performance.now() > deadline) throw new Error("drain: the turn never started");
        await Bun.sleep(25);
      }
      expect(
        (await jmapAccountJob().submit({ coalesce: true, key: `account:${source.remoteResourceId}`, input })).duplicate,
        "coalesced: the running job holds the key",
      ).toBeTrue();
      expect(await leaseFree(), "running: the turn holds the provider lease").toBeFalse();
      const stopping = jmapAccountRuntime.stop();
      // Stopping takes no new turn and leaves the running one alone: it still hangs in its pass
      // and holds the lease until it ends.
      expect(entered, "stopping: the turn is still in its pass").toBe(1);
      expect(await leaseFree(), "stopping: the running turn still holds the lease").toBeFalse();
      gate.resolve();
      await stopping;
      expect(entered, "one turn for every submission").toBe(1);
      expect(await leaseFree(), "drained: the lease is free").toBeTrue();
    } finally {
      gate.resolve();
      await jmapAccountRuntime.stop();
      await stopHydrationRuntime();
      loader.mockRestore();
    }
    expect(await submitJmapAccountJob(input), "stopped: nothing is queued").toBeFalse();
  }, 60_000);

  test("flow: an empty account starts a scan, scans to the end, then runs a delta; one pass per turn", async () => {
    put(message("OLD", "10"));
    put(message("OLDER", "05"));
    const wrong = await turn("delta");
    expect(wrong, "wrong phase: no network, asks again as background work").toMatchObject({
      result: { kind: "deferred", code: "JMAP_PHASE" },
      next: { phase: "scan" },
      delayMs: 0,
    });
    expect(source.f.requests, "wrong phase: no request").toHaveLength(0);
    const { trace, last } = await drive("scan");
    expect(trace[0], "start first").toBe("start:committed");
    expect(trace.at(-1), "a delta after the scan").toBe("delta:committed");
    expect(
      trace.slice(1, -1).every((step) => step === "scan:committed"),
      `scan steps: ${trace.join(", ")}`,
    ).toBeTrue();
    expect(last.next, "nothing left: no continuation").toBeNull();
    expect((await state())?.scan, "scan done").toBeNull();
    // One fence per pass that wrote: the start and each scan step; the quiet delta takes none.
    expect(await fenceToken(), "one pass per turn").toBe(trace.length - 1);
    expect(await counts(), "scan imports without arrivals").toEqual({ contents: 2, refs: 2, receipts: 0 });
  }, 60_000);

  test("order: a message arriving during the scan goes through one delta first, then the scan goes on; one receipt", async () => {
    put(message("OLD", "10"));
    put(message("OLDER", "05"));
    expect((await turn("scan")).result, "start").toMatchObject({ kind: "start", result: { status: "committed" } });
    change(message("NEW", "40"));
    const yielded = await turn("scan");
    expect(yielded, "scan yields without a failure or wait").toMatchObject({
      result: { kind: "scan", result: { status: "delta_required" } },
      next: { phase: "delta" },
      delayMs: 0,
    });
    const delta = await turn("delta");
    expect(delta, "the delta brings the new message, then the scan goes on").toMatchObject({
      result: { kind: "delta", result: { status: "committed", stats: { imported: 1 } } },
      next: { phase: "scan" },
      delayMs: 0,
    });
    const { last } = await drive("scan");
    expect(last.next, "done").toBeNull();
    expect(await counts(), "three messages, one arrival").toEqual({ contents: 3, refs: 3, receipts: 1 });
  }, 60_000);

  test("axes: a rejected Email state starts a reconciliation, a rejected mailbox state a repair that keeps the Email state", async () => {
    await initialize();
    source.f.methodErrors.set("Email/changes", "invalidArguments");
    expect((await turn("delta")).result, "email axis").toMatchObject({
      kind: "start",
      reason: "reconciliation",
      result: { status: "committed" },
    });
    source.f.methodErrors.clear();
    expect((await state())?.scan?.reason, "reconciliation running").toBe("reconciliation");
    await drive("scan");
    const emailState = (await state())?.emailState;
    source.f.methodErrors.set("Mailbox/changes", "invalidArguments");
    expect((await turn("delta")).result, "mailbox axis").toMatchObject({
      kind: "start",
      reason: "repair",
      result: { status: "committed" },
    });
    source.f.methodErrors.clear();
    expect(await state(), "repair keeps the Email state").toMatchObject({ emailState, scan: { reason: "repair" } });
  }, 60_000);

  test("folders: a repeated folders_required with an empty folder delta starts a repair instead of repeating", async () => {
    await initialize();
    const emailState = (await state())?.emailState;
    change(message("ELSEWHERE", "20", { hidden: true }));
    expect(await turn("delta"), "first report: the next turn is a delta").toMatchObject({
      result: { kind: "delta", result: { status: "superseded", cause: "folders_required" } },
      next: { phase: "delta" },
      delayMs: 0,
    });
    // The repair's snapshot sees the mailbox state move: nothing was repaired yet.
    let moves = 0;
    source.f.controls.transform = ([name, args, id]) =>
      name === "Mailbox/get" && Array.isArray(args.list) && args.list.length === 0
        ? [name, { ...args, state: `moved-${++moves}` }, id]
        : [name, args, id];
    expect(await turn("delta"), "repeated: a repair, which must retry").toMatchObject({
      result: { kind: "start", reason: "repair", result: { status: "retry" } },
      next: { phase: "scan" },
      delayMs: 5_000,
    });
    expect((await turn("scan")).result, "no scan yet: the delta goes first").toMatchObject({ kind: "deferred", code: "JMAP_PHASE" });
    source.f.controls.transform = undefined;
    expect(await turn("delta"), "the next report tries the repair again instead of failing").toMatchObject({
      result: { kind: "start", reason: "repair", result: { status: "committed" } },
      next: { phase: "scan" },
    });
    expect(await state(), "repair: Email state kept").toMatchObject({ emailState, scan: { reason: "repair" } });
    // The message stays in a mailbox the server never shows: the scan yields to the delta, and a
    // report after the repair fails the turn visibly instead of repairing again.
    expect((await turn("scan")).result, "after the repair: the delta first").toMatchObject({
      kind: "scan",
      result: { status: "delta_required" },
    });
    const failure = await turn("delta").then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "a report after the committed repair: the attempt fails").toBe("JMAP_FOLDERS_UNRESOLVED");
    expect((await health())?.mailbox, "after the committed repair: visible").toBe("degraded");
  }, 60_000);

  /** Starts a repair on an initialized account, so a scan runs. */
  const runningScan = async () => {
    await initialize();
    source.f.methodErrors.set("Mailbox/changes", "invalidArguments");
    expect((await turn("delta")).result, "repair started").toMatchObject({
      kind: "start",
      reason: "repair",
      result: { status: "committed" },
    });
    source.f.methodErrors.clear();
  };
  /** One scan turn that yields to the delta, then the delta turn after it. */
  const yieldRound = async (label: string) => {
    expect(await turn("scan"), `${label}: the scan yields`).toMatchObject({
      result: { kind: "scan", result: { status: "delta_required" } },
      next: { phase: "delta" },
      delayMs: 0,
    });
    expect(await turn("delta"), `${label}: the delta, then the scan again`).toMatchObject({
      result: { kind: "delta", result: { status: "committed" } },
      next: { phase: "scan" },
    });
  };

  test("state mismatch: a scan that keeps yielding to a delta that moves nothing fails visibly; moving the Email state resets", async () => {
    await runningScan();
    // A server whose Email/get state never equals its Email/changes state.
    source.f.controls.getState = "drifted";
    await yieldRound("first");
    await yieldRound("second");
    // New mail moves the Email state on: the count starts again.
    change(message("FRESH", "45"));
    await yieldRound("new mail");
    // The new-mail round counted once before its delta reset the count: four more rounds pass, the
    // fifth yield in a row fails.
    for (const round of ["after reset 1", "after reset 2", "after reset 3", "after reset 4"]) await yieldRound(round);
    const failure = await turn("scan").then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "at the restart limit: the attempt fails").toBe("JMAP_SCAN_STATE_MISMATCH");
    expect((await health())?.mailbox, "visible").toBe("degraded");
  }, 60_000);

  test("start retry: waits along the backoff, fails visibly after the last attempt; a committed start resets", async () => {
    // Every snapshot sees the mailbox state move between its first and last read.
    let moves = 0;
    const moving = ([name, args, id]: JmapInvocation): JmapInvocation =>
      name === "Mailbox/get" && Array.isArray(args.list) && args.list.length === 0
        ? [name, { ...args, state: `moved-${++moves}` }, id]
        : [name, args, id];
    source.f.controls.transform = moving;
    const delays: Array<number | null> = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const retried = await turn("scan");
      expect(retried.result, `retry ${attempt + 1}`).toMatchObject({ kind: "start", reason: "initial", result: { status: "retry" } });
      delays.push(retried.delayMs);
    }
    expect(delays, "backoff").toEqual([5_000, 10_000, 20_000, 40_000, 40_000]);
    const failure = await turn("scan").then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "after the last attempt").toBe("JMAP_SCAN_START_UNSTABLE");
    source.f.controls.transform = undefined;
    expect((await turn("scan")).result, "a start that commits").toMatchObject({ kind: "start", result: { status: "committed" } });
    // The next start that retries waits the first delay again.
    source.f.methodErrors.set("Mailbox/changes", "invalidArguments");
    source.f.controls.transform = moving;
    expect(await turn("delta"), "reset: the first delay again").toMatchObject({
      result: { kind: "start", reason: "repair", result: { status: "retry" } },
      delayMs: 5_000,
    });
  }, 60_000);

  test("quiet: no fence, no run, sync time at most once a minute; a waiting command takes the fenced commit", async () => {
    await initialize();
    const token = await fenceToken();
    const before = await runs();
    await sql<[]>`UPDATE mail.remote_resources SET last_sync_at = now() WHERE id = ${source.remoteResourceId}::uuid`;
    const syncTime = async () =>
      (await sql<{ at: Date }[]>`SELECT last_sync_at AS at FROM mail.remote_resources WHERE id = ${source.remoteResourceId}::uuid`)[0]?.at;
    const recent = await syncTime();
    const quiet = await turn("delta");
    expect(quiet, "quiet: committed, nothing left").toMatchObject({
      result: { kind: "delta", result: { status: "committed", hasMore: false } },
      next: null,
    });
    expect(await fenceToken(), "quiet: no fence").toBe(token);
    expect(await runs(), "quiet: no run").toEqual(before);
    expect(await syncTime(), "quiet: sync time kept within the minute").toEqual(recent);
    await sql<[]>`UPDATE mail.remote_resources SET last_sync_at = now() - interval '2 minutes' WHERE id = ${source.remoteResourceId}::uuid`;
    const stale = await syncTime();
    await turn("delta");
    expect(await syncTime(), "quiet: a due sync time moves on").not.toEqual(stale);
    expect(await fenceToken(), "quiet again: no fence").toBe(token);
    await turn("delta", { awaited: true });
    expect(await fenceToken(), "awaited: the fenced commit").toBe((token ?? 0) + 1);
    expect(await runs(), "awaited: an empty run leaves no trace").toEqual(before);
  }, 60_000);

  test("probe: a quiet turn asks for no Email; a turn with new mail asks for it in exactly one request", async () => {
    await initialize();
    const getRequests = () => source.f.requests.filter((request) => request.calls?.some(([name]) => name === "Email/get")).length;
    const quietBefore = getRequests();
    expect((await turn("delta")).result, "quiet").toMatchObject({ kind: "delta", result: { status: "committed", stats: { imported: 0 } } });
    expect(getRequests() - quietBefore, "quiet: no Email/get").toBe(0);
    change(message("ONCE", "30"));
    const newBefore = getRequests();
    expect((await turn("delta")).result, "new mail").toMatchObject({
      kind: "delta",
      result: { status: "committed", stats: { imported: 1 } },
    });
    expect(getRequests() - newBefore, "new mail: Email/get once, after the fence").toBe(1);
  }, 30_000);

  test("DATA-13: statements of a quiet turn, a turn with one new message and a busy turn", async () => {
    await initialize();
    const measured: Record<keyof typeof JOB_STATEMENT_BUDGET, number> = { quiet: 0, newMail: 0, busy: 0 };
    const meter = await meterSql();
    try {
      measured.quiet = (await meter.during(() => turn("delta"))).length;
      change(message("SINGLE", "30"));
      measured.newMail = (await meter.during(() => turn("delta"))).length;
      const holder = await acquireProviderLease({
        resource: source.remoteResourceId,
        waiter: "commands:holder",
        priority: "command",
        ttlMs: 30_000,
      });
      if (!holder.lock) throw new Error("budget: holder lease missing");
      const wakes = captureWakes();
      try {
        measured.busy = (await meter.during(() => turn("delta"))).length;
      } finally {
        await releaseProviderLease(holder.lock);
        wakes.restore();
      }
    } finally {
      await meter.close();
    }
    // The line names the measured values for the budget.
    console.info("JMAP_JOB_STATEMENTS", JSON.stringify(measured));
    for (const key of Object.keys(JOB_STATEMENT_BUDGET) as Array<keyof typeof JOB_STATEMENT_BUDGET>) {
      const budget = JOB_STATEMENT_BUDGET[key];
      if (budget !== null) expect(measured[key], `budget: ${key}`).toBe(budget);
    }
  }, 60_000);

  test("busy: a held lease costs no SQL and no request; the turn parks, a release wakes it, a lost wake comes again", async () => {
    await initialize();
    const requests = source.f.requests.length;
    const holder = await acquireProviderLease({
      resource: source.remoteResourceId,
      waiter: "commands:holder",
      priority: "command",
      ttlMs: 30_000,
    });
    if (!holder.lock) throw new Error("busy: holder lease missing");
    const wakes = captureWakes();
    const meter = await meterSql();
    try {
      let parked: Turn | null = null;
      const statements = await meter.during(async () => {
        parked = await turn("delta");
      });
      expect(statements, "busy: no SQL").toEqual([]);
      expect(parked, "busy: parked, no continuation").toMatchObject({ result: { kind: "deferred", code: "SYNC_BUSY" }, next: null });
      expect(source.f.requests, "busy: no request").toHaveLength(requests);
      await releaseProviderLease(holder.lock);
      const waiter = jmapAccountWaiter(source.remoteResourceId);
      expect(wakes.woken, "release: wakes the parked turn with its input").toEqual([
        { waiter, left: JSON.stringify({ remoteResourceId: source.remoteResourceId, phase: "delta" }) },
      ]);
      // The waker dropped that wake; the scheduler's next wake of the line brings it again.
      await wakeParkedProviderWaiter(source.remoteResourceId);
      expect(
        wakes.woken.map((wake) => wake.waiter),
        "lost wake: woken again",
      ).toEqual([waiter, waiter]);
    } finally {
      await meter.close();
      wakes.restore();
    }
    expect((await turn("delta")).result, "woken: the turn runs").toMatchObject({ kind: "delta", result: { status: "committed" } });
  }, 60_000);

  test("coalescing: two deliveries of one account at once run one turn; the other waits for the lease", async () => {
    await initialize();
    let gate = Promise.withResolvers<void>();
    let sessions = 0;
    source.f.controls.handle = async (request) => {
      if (request.method !== "GET") return undefined;
      sessions++;
      await gate.promise;
      return undefined;
    };
    const wakes = captureWakes();
    try {
      const first = turn("delta");
      const deadline = performance.now() + 10_000;
      while (sessions === 0) {
        if (performance.now() > deadline) throw new Error("coalescing: first turn missing");
        await Bun.sleep(10);
      }
      expect((await turn("delta")).result, "second: busy").toMatchObject({ kind: "deferred", code: "SYNC_BUSY" });
      gate.resolve();
      expect((await first).result, "first: runs").toMatchObject({ kind: "delta", result: { status: "committed" } });
      expect(sessions, "one Session request").toBe(1);
    } finally {
      gate.resolve();
      gate = Promise.withResolvers<void>();
      wakes.restore();
    }
  }, 60_000);

  test("one lease for both protocols: an administrative barrier and a turn exclude each other; a command goes between scan turns", async () => {
    put(message("OLD", "10"));
    put(message("OLDER", "05"));
    const wakes = captureWakes();
    try {
      // The barrier holds the mailbox: a turn parks without SQL or network.
      const held = Promise.withResolvers<void>();
      const inside = Promise.withResolvers<void>();
      const barrier = withMailboxProviderOperationBarrier(source.mailboxId, [source.remoteResourceId], async () => {
        inside.resolve();
        await held.promise;
      });
      await inside.promise;
      expect((await turn("scan")).result, "barrier: the turn waits").toMatchObject({ kind: "deferred", code: "SYNC_BUSY" });
      expect(source.f.requests, "barrier: no request").toHaveLength(0);
      held.resolve();
      expect(await barrier, "barrier: completed").toMatchObject({ acquired: true });

      // A turn holds the same lease the barrier takes.
      const gate = Promise.withResolvers<void>();
      let waiting = false;
      source.f.controls.handle = async (request) => {
        if (request.method !== "GET" || waiting) return undefined;
        waiting = true;
        await gate.promise;
        return undefined;
      };
      const running = turn("scan");
      const deadline = performance.now() + 10_000;
      while (!waiting) {
        if (performance.now() > deadline) throw new Error("lease: turn missing");
        await Bun.sleep(10);
      }
      expect(await leaseFree(), "turn: holds the barrier's lease").toBeFalse();
      gate.resolve();
      expect((await running).result, "turn: start committed").toMatchObject({ kind: "start", result: { status: "committed" } });
      source.f.controls.handle = undefined;

      // Between two scan turns a command takes its turn first, then the scan goes on.
      const scanStep = await turn("scan");
      expect(scanStep, "scan: continues as background work").toMatchObject({ next: { phase: "scan" }, delayMs: 0 });
      const command = await acquireProviderLease({
        resource: source.remoteResourceId,
        waiter: "commands:fair",
        priority: "command",
        ttlMs: 30_000,
      });
      expect(command.lock, "fairness: the command goes first").not.toBeNull();
      expect((await turn("scan")).result, "fairness: the scan waits for it").toMatchObject({ kind: "deferred", code: "SYNC_BUSY" });
      if (command.lock) await releaseProviderLease(command.lock);
      expect(wakes.woken.at(-1)?.waiter, "fairness: the release wakes the scan").toBe(jmapAccountWaiter(source.remoteResourceId));
      expect((await turn("scan")).result, "fairness: the scan goes on").toMatchObject({ kind: "scan" });
    } finally {
      wakes.restore();
    }
  }, 60_000);

  test("wrong phase: a scan turn without a running scan lets go without network and asks for a delta", async () => {
    await initialize();
    const requests = source.f.requests.length;
    expect(await turn("scan"), "scan without scan").toMatchObject({
      result: { kind: "deferred", code: "JMAP_PHASE" },
      next: { phase: "delta" },
      delayMs: 0,
    });
    expect(source.f.requests, "no request").toHaveLength(requests);
  }, 30_000);

  // A date names a whole second; whether `setSystemTime` freezes the clock or lets it run, the wait
  // is the time from the job's own reading of the clock to that second, so it lies between the
  // time left when the turn has ended and that plus the turn's own duration.
  for (const [name, plan] of [
    ["seconds", () => ({ header: "30", range: () => [30_000, 30_000] as const })],
    [
      "date",
      () => {
        const target = Math.ceil(Date.now() / 1_000) * 1_000 + 120_000;
        return { header: new Date(target).toUTCString(), range: () => [target - Date.now(), target - Date.now() + 10_000] as const };
      },
    ],
    ["above the cap", () => ({ header: "86400", range: () => [JMAP_RATE_LIMIT_MAX_MS, JMAP_RATE_LIMIT_MAX_MS] as const })],
  ] as const) {
    test(`429 (${name}): the full wait up to its cap, a shared cooldown, no failure`, async () => {
      await initialize();
      const id = await arrive("BODY");
      const { header, range } = plan();
      source.f.controls.handle = (request) =>
        request.method === "POST" ? new Response("", { status: 429, headers: { "retry-after": header } }) : undefined;
      const limited = await turn("delta");
      expect(limited, "rate limited: waits, no failure").toMatchObject({
        result: { kind: "deferred", code: "MAIL_RATE_LIMITED" },
        next: { phase: "delta" },
      });
      const [lowest, highest] = range();
      const waited = limited.delayMs ?? 0;
      expect(waited >= lowest && waited <= highest, `rate limited: ${waited} ms within ${lowest}..${highest}`).toBeTrue();
      expect(limited.result.kind === "deferred" && limited.result.retryAfterMs, "the wait the turn reports").toBe(waited);
      const expected = waited;
      expect(await jmapCooldownMs(source.remoteResourceId), "cooldown set").toBeGreaterThan(expected - 5_000);
      expect(await health(), "no auth or health failure").toEqual(settled);
      expect(await providerBreakerOpenForMs(source.remoteResourceId), "no breaker").toBe(0);
      source.f.controls.handle = undefined;
      const requests = source.f.requests.length;
      const held = await turn("delta");
      expect(held.result, "cooldown: a second turn waits").toMatchObject({ kind: "deferred", code: "MAIL_RATE_LIMITED" });
      expect(held.delayMs ?? 0, "cooldown: the rest of the wait").toBeGreaterThan(0);
      // The hydration batch waits before it asks for the lease or loads the account.
      const leases = spyOn(providerLeases, "acquireProviderLease");
      const loads = spyOn(accountAccess, "loadJmapAccountAccess");
      try {
        const failure = await hydrate(id);
        expect(codeOf(failure), "cooldown: hydration waits too").toBe("MAIL_RATE_LIMITED");
        expect(
          leases.mock.calls.filter(([params]) => params.resource === source.remoteResourceId),
          "cooldown: no lease asked",
        ).toEqual([]);
        expect(loads, "cooldown: no account loaded").not.toHaveBeenCalled();
      } finally {
        leases.mockRestore();
        loads.mockRestore();
      }
      expect(source.f.requests, "cooldown: no request").toHaveLength(requests);
    }, 60_000);
  }

  test("401: a refused login records the login health once and does not retry", async () => {
    await initialize();
    source.f.controls.status = 401;
    expect(await turn("delta"), "401: ends").toMatchObject({ result: { kind: "ended", reason: "auth_required" }, next: null });
    expect(await health(), "401: login required").toEqual({
      mailbox: "auth_required",
      resource: "connection_required",
      binding: "degraded",
      connection: "degraded",
      binding_error: "JMAP_AUTHENTICATION_FAILED",
    });
    source.f.controls.status = null;
    expect((await turn("delta")).result, "after 401: not runnable until verified again").toMatchObject({
      kind: "ended",
      reason: "binding_inactive",
    });
  }, 30_000);

  test("403: a refused account degrades the binding, not the credentials", async () => {
    await initialize();
    source.f.controls.apiStatus = 403;
    expect(await turn("delta"), "403: ends").toMatchObject({ result: { kind: "ended", reason: "access_denied" }, next: null });
    expect(await health(), "403: access denied").toEqual({
      mailbox: "connection_required",
      resource: "connection_required",
      binding: "degraded",
      connection: "active",
      binding_error: "JMAP_ACCESS_DENIED",
    });
  }, 30_000);

  test("hydration: a 401 records the same login health; a missing source queues the account delta", async () => {
    await initialize();
    const gone = await arrive("GONE");
    // hydrateMessageBatch calls submitJmapAccountJob inside sync-runtime. A probe in Bun 1.4.4
    // showed that spyOn on the module namespace also replaces such calls within the same module
    // (outer() called the mocked inner()); a red here first means that this no longer holds.
    const queued = spyOn(syncRuntime, "submitJmapAccountJob").mockImplementation(async () => true);
    try {
      source.f.emails.splice(
        source.f.emails.findIndex((email) => email.id === "GONE"),
        1,
      );
      expect(await hydrate(gone), "missing: the batch ends without a failure").toBeNull();
      expect(queued.mock.calls, "missing: the account delta is queued").toEqual([
        [{ remoteResourceId: source.remoteResourceId, phase: "delta" }],
      ]);
    } finally {
      queued.mockRestore();
    }
    const refused = await arrive("REFUSED");
    source.f.controls.apiStatus = 401;
    const failure = await hydrate(refused);
    expect([codeOf(failure), failure instanceof Error && Reflect.get(failure, "status")], "401: the batch ends").toEqual([
      "JMAP_HTTP",
      401,
    ]);
    expect(await health(), "401: login required, as from the account job").toMatchObject({
      mailbox: "auth_required",
      binding: "degraded",
      connection: "degraded",
    });
  }, 60_000);

  test("hydration: its own 429 sets the account's cooldown", async () => {
    await initialize();
    const id = await arrive("THROTTLED");
    source.f.controls.apiStatus = 429;
    expect(codeOf(await hydrate(id)), "hydration: rate limited").toBe("MAIL_RATE_LIMITED");
    expect(await jmapCooldownMs(source.remoteResourceId), "cooldown from the fixture's Retry-After").toBeGreaterThan(25_000);
    source.f.controls.apiStatus = null;
    const requests = source.f.requests.length;
    expect((await turn("delta")).result, "account job waits").toMatchObject({ kind: "deferred", code: "MAIL_RATE_LIMITED" });
    expect(source.f.requests, "no request").toHaveLength(requests);
  }, 60_000);

  test("timeout: opens the breaker, also after a Session that answered; only a completed turn closes it", async () => {
    await initialize();
    const resolve = source.f.dependencies.resolveEndpoint;
    if (!resolve) throw new Error("timeout: fixture resolver missing");
    /** Requests after the first `answered` ones time out before they connect. */
    const timingOut = (answered: number): JmapTransportDependencies => {
      let calls = 0;
      return {
        ...source.f.dependencies,
        resolveEndpoint: async (endpoint, timeoutMs, signal) => {
          if (++calls > answered) throw Object.assign(new Error("fixture DNS timeout"), { code: "ETIMEDOUT" });
          return resolve(endpoint, timeoutMs, signal);
        },
      };
    };
    const sessionTimeout = await turn("delta", { transport: timingOut(0) }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(sessionTimeout), "Session timeout: fails the attempt").toBe("JMAP_TIMEOUT");
    expect(await providerBreakerOpenForMs(source.remoteResourceId), "breaker open").toBeGreaterThan(0);
    expect((await health())?.mailbox, "visible").toBe("degraded");
    expect((await turn("delta")).result, "open breaker: no turn").toMatchObject({ kind: "deferred", code: "PROVIDER_UNREACHABLE" });
    await resetProviderBreaker(source.remoteResourceId);
    const apiTimeout = await turn("delta", { transport: timingOut(1) }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(apiTimeout), "API timeout after a Session that answered").toBe("JMAP_TIMEOUT");
    expect(await providerBreakerOpenForMs(source.remoteResourceId), "the Session alone closes nothing").toBeGreaterThan(0);
    await resetProviderBreaker(source.remoteResourceId);
    expect((await turn("delta")).result, "probe: a completed turn").toMatchObject({ kind: "delta", result: { status: "committed" } });
    expect(await breakerRemembered(), "closed and forgotten").toBeFalse();
    expect(await health(), "health recovered").toEqual(settled);
  }, 60_000);

  test("abort: no penalty, no success, nothing written, the lease free", async () => {
    await initialize();
    const token = await fenceToken();
    const before = await runs();
    const controller = new AbortController();
    source.f.controls.handle = (request) => {
      if (request.method === "POST") controller.abort();
      return undefined;
    };
    const failure = await turn("delta", { signal: controller.signal }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "abort: the delivery retries").toBe("JMAP_ABORTED");
    expect(await health(), "abort: health untouched").toEqual(settled);
    expect(await providerBreakerOpenForMs(source.remoteResourceId), "abort: no breaker").toBe(0);
    expect(await fenceToken(), "abort: no fence").toBe(token);
    expect(await runs(), "abort: no run").toEqual(before);
    expect(await leaseFree(), "abort: lease free").toBeTrue();
  }, 30_000);

  test("session changed: loaded once more and read again; a second change fails the attempt", async () => {
    await initialize();
    const sessionRequests = () => source.f.requests.filter((request) => request.method === "GET").length;
    let moved = false;
    source.f.controls.handle = (request) => {
      if (request.method === "POST" && !moved) {
        moved = true;
        source.f.session.state = "session-state-2";
      }
      return undefined;
    };
    const before = sessionRequests();
    expect((await turn("delta")).result, "once: read again").toMatchObject({ kind: "delta", result: { status: "committed" } });
    expect(sessionRequests() - before, "once: the Session loaded twice").toBe(2);
    let generation = 2;
    source.f.controls.handle = (request) => {
      if (request.method === "POST") source.f.session.state = `session-state-${++generation}`;
      return undefined;
    };
    const failure = await turn("delta").then(
      () => null,
      (error: unknown) => error,
    );
    expect(codeOf(failure), "twice: retried through the job").toBe("JMAP_SESSION_CHANGED");
    expect((await health())?.mailbox, "twice: visible").toBe("degraded");
  }, 60_000);

  test("invalid and unavailable answers fail visibly and keep the checkpoint; a not runnable account ends quietly", async () => {
    await initialize();
    const checkpoint = await state();
    for (const methodError of ["forbidden", "serverUnavailable"]) {
      source.f.methodErrors.set("Email/changes", methodError);
      const failure = await turn("delta").then(
        () => null,
        (error: unknown) => error,
      );
      expect(codeOf(failure), `${methodError}: the attempt fails`).toBe("JMAP_METHOD");
      expect(await state(), `${methodError}: checkpoint unchanged`).toEqual(checkpoint);
      expect((await runs()).at(-1), `${methodError}: failed run`).toMatchObject({ state: "failed" });
      expect((await health())?.mailbox, `${methodError}: degraded`).toBe("degraded");
      expect(await providerBreakerOpenForMs(source.remoteResourceId), `${methodError}: no breaker`).toBe(0);
    }
    source.f.methodErrors.clear();
    await sql<[]>`UPDATE mail.remote_resources SET status = 'paused' WHERE id = ${source.remoteResourceId}::uuid`;
    const requests = source.f.requests.length;
    expect(await turn("delta"), "paused: ends without retry").toMatchObject({ result: { kind: "ended", reason: "paused" }, next: null });
    expect(source.f.requests, "paused: no request").toHaveLength(requests);
  }, 60_000);

  test("crash: a turn that dies after its commit or in its read goes on from the stored step, nothing twice", async () => {
    for (let index = 0; index < 5; index++) put(message(`M${index}`, `1${index}`));
    expect((await turn("scan")).result, "start").toMatchObject({ kind: "start" });
    // The process dies after the first page's commit, before the continuation is acknowledged:
    // the delivery comes again with its old input.
    expect((await turn("scan")).result, "first page").toMatchObject({ kind: "scan", result: { status: "committed" } });
    const controller = new AbortController();
    source.f.controls.handle = (request) => {
      if (request.method === "POST") controller.abort();
      return undefined;
    };
    expect(codeOf(await turn("scan", { signal: controller.signal }).catch((error: unknown) => error)), "dies in its read").toBe(
      "JMAP_ABORTED",
    );
    source.f.controls.handle = undefined;
    const { last } = await drive("scan");
    expect(last.next, "done").toBeNull();
    expect(await counts(), "each message once").toEqual({ contents: 5, refs: 5, receipts: 0 });
  }, 60_000);

  test("pacer: one slot per HTTP request, without SQL", async () => {
    await initialize();
    const meter = await meterSql();
    const before = (await meter.during(() => turn("delta"))).length;
    const slots = spyOn(pacer, "waitForMailProviderSlot");
    const requests = source.f.requests.length;
    try {
      const statements = await meter.during(() => turn("delta"));
      expect(slots.mock.calls.length, "one slot per request").toBe(source.f.requests.length - requests);
      expect(slots.mock.calls.length, "the Session and one probe request").toBe(2);
      expect(statements.length, "a quiet turn costs the same with counted slots: they use Valkey only").toBe(before);
    } finally {
      await meter.close();
      slots.mockRestore();
    }
  }, 30_000);
});
