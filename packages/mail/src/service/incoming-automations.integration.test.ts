import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { Readable } from "node:stream";
import { getProcessSync } from "@k2b/cloud";
import { encryptSecret, mandates, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { parsePgJsonRecord } from "@k2b/cloud/services/postgres";
import {
  createWorkflowRun,
  deleteWorkflowScope,
  dispatchPendingWorkflowEvents,
  wakeExpiredWorkflowRuns,
  wakeWorkflowRunsWaitingOn,
} from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import incomingAutomationRoutes from "../api/incoming-automations";
import type { MailApiContext } from "../api/public-resource-boundary";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { snapshotMailWorkflowCatalog } from "../workflows/catalog";
import { grantMailboxAccess, listMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { executeMutationCommand } from "./command-runtime";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors/imap-smtp";
import { updateConversationCollaboration } from "./conversation-assignments";
import { resolveIncomingAutomationPlacementTurn } from "./incoming-automation-order";
import { resolveIncomingAutomationMandateCaller } from "./incoming-automation-workload";
import {
  cancelIncomingAutomationBackfill,
  createIncomingAutomation,
  deleteIncomingAutomation,
  getIncomingAutomationBackfill,
  listIncomingAutomationActivityMetadata,
  listIncomingAutomations,
  normalizeMailAutomationConditions,
  previewIncomingAutomationMatches,
  setIncomingAutomationEnabled,
  startIncomingAutomationBackfill,
  startIncomingAutomationBackfillRuntime,
  stopIncomingAutomationBackfillRuntime,
  updateIncomingAutomation,
  validateDestructiveIncomingAutomationsForMailbox,
} from "./incoming-automations";
import { createMailbox } from "./mailboxes";
import { hydrateMessageFromSource } from "./message-hydration";
import { ingestEnvelope } from "./sync-runtime";
import { loadMailWorkflowCatalog } from "./workflow-catalog-service";
import { workflowSnapshotQuery } from "./workflow-data";
import { runMailWorkflow } from "./workflow-runtime";

const suite = suiteFor("database", "nats");
type TestUser = { id: string; uid: string; displayName: string };

const contextFor = (user: TestUser): MailRequestContext => ({
  actor: {
    kind: "user",
    user: {
      id: user.id,
      uid: user.uid,
      provider: "local",
      profile: "user",
      displayName: user.displayName,
      givenName: user.displayName,
      sn: "Test",
      mail: `${user.uid}@example.test`,
      roles: ["user"],
      memberofGroupIds: [],
      memberofGroups: [],
    } as never,
  },
  accessSubject: { type: "user", userId: user.id },
  requestId: `incoming-automations-${user.uid}`,
});

suite("incoming automations", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const userIds: string[] = [];
  let mailboxId = "";
  let remoteResourceId = "";
  let inboxFolderId = "";
  let archiveFolderId = "";
  let ownerContext: MailRequestContext;
  let writerContext: MailRequestContext;
  let sharedAdminContext: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    const createUser = async (role: string): Promise<TestUser> => {
      const uid = `incoming-automation-${role}-${suffix}`;
      const displayName = `${role} incoming automation test`;
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO auth.users (uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${displayName}, false)
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create ${role} user`);
      userIds.push(row.id);
      return { id: row.id, uid, displayName };
    };
    const owner = await createUser("owner");
    const writer = await createUser("writer");
    const sharedAdmin = await createUser("shared-admin");
    ownerContext = contextFor(owner);
    writerContext = contextFor(writer);
    sharedAdminContext = contextFor(sharedAdmin);
    const mailbox = await createMailbox(ownerContext, { name: `Incoming automations ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const access = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: writer.id },
      permission: "write",
    });
    if (!access.ok) throw new Error(access.error.message);
    const sharedAccess = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: sharedAdmin.id },
      permission: "admin",
    });
    if (!sharedAccess.ok) throw new Error(sharedAccess.error.message);
    const scopeFingerprint = `${"e".repeat(56)}${suffix}`;
    const fixtureSecret = await encryptSecret({ kind: "password", password: "fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username,
        imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode,
        secret_kind, encrypted_secret, status
      ) VALUES (
        ${mailboxId}::uuid, 'Incoming automation fixture', 'automation@example.test', 'automation@example.test',
        'imap.example.test', 993, 'implicit',
        'smtp.example.test', 465, 'implicit',
        'password', ${fixtureSecret}, 'active'
      )
      RETURNING id
    `;
    if (!connection) throw new Error("Failed to create incoming automation provider connection");
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${scopeFingerprint}, 'active')
      RETURNING id
    `;
    if (!resource) throw new Error("Failed to create incoming automation remote resource");
    remoteResourceId = resource.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator,
        verified_scope_fingerprint, verified_secret_revision
      ) VALUES (
        ${resource.id}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb,
        ${scopeFingerprint}, 1
      )
      RETURNING id
    `;
    if (!binding) throw new Error("Failed to create incoming automation provider binding");
    await sql`UPDATE mail.provider_bindings SET capabilities = capabilities || '{"move":true}'::jsonb WHERE id = ${binding.id}::uuid`;
    const [junkFolder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resource.id}::uuid, ${`incoming-automation-junk-${suffix}`}, 'Junk', 'junk', 'current')
      RETURNING id
    `;
    if (!junkFolder) throw new Error("Failed to create incoming automation junk folder");
    const folders = await sql<{ id: string; stable_key: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES
        (${newShortId()}, ${resource.id}::uuid, ${`incoming-automation-inbox-${suffix}`}, 'Inbox', 'inbox', 'current'),
        (${newShortId()}, ${resource.id}::uuid, ${`incoming-automation-archive-${suffix}`}, 'Archive', 'archive', 'current')
      RETURNING id, stable_key
    `;
    inboxFolderId = folders.find((folder) => folder.stable_key === `incoming-automation-inbox-${suffix}`)?.id ?? "";
    archiveFolderId = folders.find((folder) => folder.stable_key === `incoming-automation-archive-${suffix}`)?.id ?? "";
    if (!inboxFolderId || !archiveFolderId) throw new Error("Failed to create incoming automation folders");
    for (const folder of [
      { id: junkFolder.id, path: "Junk" },
      { id: inboxFolderId, path: "INBOX" },
      { id: archiveFolderId, path: "Archive" },
    ]) {
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (
          ${binding.id}::uuid, ${folder.id}::uuid, ${folder.path}, 1, 1,
          ARRAY['read', 'insert', 'move', 'write_flags']::text[], now()
        )
      `;
    }
  });

  afterAll(async () => {
    if (mailboxId) {
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (userIds.length > 0) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])`;
  });

  test("negated sender preview and backfill include missing From and match only the first From", async () => {
    const domain = `negation-${suffix}.test`;
    // The two-From fixture excludes by the first address; the last fixture has no From at all.
    const senders = [
      [`keep@${domain}`],
      [`skip@${domain}`],
      [`other@negation-other-${suffix}.test`],
      [`skip@${domain}`, `second@negation-other-${suffix}.test`],
      [],
    ];
    for (const [index, addresses] of senders.entries()) {
      await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        captureWorkflowTriggers: false,
        message: {
          remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(9400 + index), modseq: "1" },
          providerMessageId: `negation-${suffix}-${index}`,
          providerThreadId: null,
          messageId: `<negation-${suffix}-${index}@example.test>`,
          inReplyTo: null,
          references: [],
          subject: "Negation fixture",
          sentAt: new Date(),
          internalDate: new Date(),
          sizeBytes: 128,
          flags: [],
          labels: [],
          addresses: { from: addresses.map((address) => ({ name: "Sender", address })), replyTo: [], to: [], cc: [], bcc: [] },
          mimeStructure: {},
        },
      });
    }
    // Later backfill tests expect no other candidates in this mailbox; preview and backfill skip stale copies.
    const retireFixtures = () => sql`
      UPDATE mail.remote_message_refs remote_ref
      SET stale_at = now()
      FROM mail.message_contents message
      WHERE message.id = remote_ref.message_id
        AND message.mailbox_id = ${mailboxId}::uuid
        AND message.message_id LIKE ${`%negation-${suffix}-%`}
    `;
    let automation: { id: string; revision: number } | undefined;
    let backfillStarted = false;
    try {
      const positive = { field: "sender_domain", operator: "is", value: domain } as const;
      const negative = { field: "sender_address", operator: "is_not", value: `skip@${domain}` } as const;
      const preview = async (mode: "all" | "any", items: import("../contracts").MailAutomationCondition[]) => {
        const result = await previewIncomingAutomationMatches({
          context: ownerContext,
          mailboxId,
          input: { scope: { mode: "matching", conditions: { mode, items } } },
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.data;
      };
      expect(await preview("all", [positive, negative])).toMatchObject({ messageCount: 1, exact: true });
      expect(await preview("all", [positive])).toMatchObject({ messageCount: 3, exact: true });
      expect(await preview("all", [negative])).toMatchObject({ messageCount: 3, exact: true });
      const total = await previewIncomingAutomationMatches({ context: ownerContext, mailboxId, input: { scope: { mode: "all" } } });
      if (!total.ok) throw new Error(total.error.message);
      expect(await preview("any", [positive, negative])).toMatchObject({ messageCount: total.data.messageCount, exact: true });
      expect(await preview("all", [positive, negative, { field: "subject", operator: "not_contains", value: "missing" }])).toMatchObject({
        messageCount: 1,
        exact: false,
      });
      expect(await preview("any", [negative, { field: "subject", operator: "not_contains", value: "missing" }])).toMatchObject({
        messageCount: total.data.messageCount,
        exact: false,
      });
      expect(await preview("all", [{ field: "sender_domain", operator: "is_not", value: domain }])).toMatchObject({
        messageCount: total.data.messageCount - 3,
        exact: true,
      });
      expect(
        normalizeMailAutomationConditions({
          mode: "all",
          items: [
            { field: "sender_address", operator: "is_not", value: `SKIP@${domain.toUpperCase()}` },
            { field: "sender_domain", operator: "is_not", value: domain.toUpperCase() },
          ],
        }),
      ).toEqual({ ok: true, data: { mode: "all", items: [negative, { field: "sender_domain", operator: "is_not", value: domain }] } });
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Missing From ${suffix}`,
          enabled: true,
          scope: { mode: "matching", conditions: { mode: "all", items: [{ field: "sender_domain", operator: "is_not", value: domain }] } },
          steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      automation = created.data;
      await startIncomingAutomationBackfillRuntime();
      backfillStarted = true;
      const operationId = crypto.randomUUID();
      expect(
        await runBackfillUntilSettled(
          {
            context: ownerContext,
            mailboxId,
            automationId: created.data.id,
            input: { operationId, expectedRevision: created.data.revision },
          },
          10_000,
        ),
      ).toMatchObject({ state: "completed", candidateCount: 2, newlyAcceptedCount: 2, remainingCount: 0 });
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      const runs = await sql<{ id: string; from_address: string }[]>`
        SELECT run.id, run.inputs #>> '{message,fromAddress}' AS from_address FROM workflows.run run
        WHERE run.workflow_id = ${created.data.workflowId}::uuid
      `;
      expect(runs.map((run) => run.from_address).sort()).toEqual(["", `other@negation-other-${suffix}.test`]);
      for (const run of runs) {
        expect(await runMailWorkflow(run.id)).toMatchObject({ state: "finished", result: { state: "waiting" } });
        const [command] = await sql<{ id: string; ref: string }[]>`
          SELECT id, target ->> 'remoteMessageRefId' AS ref FROM mail.commands
          WHERE correlation_id = ${run.id} AND kind = 'change_message_state'
        `;
        if (!command) throw new Error("Missing From automation did not run Mark as read");
        await sql`UPDATE mail.message_placements SET flags = ARRAY['\\Seen']::text[] WHERE remote_message_ref_id = ${command.ref}::uuid`;
        await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${command.id}::uuid`;
        await wakeWorkflowRunsWaitingOn({ appId: "mail", kind: "mail.command", key: command.id });
        expect(await runMailWorkflow(run.id)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
        const [read] = await sql<{ output: Record<string, unknown> }[]>`
          SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
          WHERE run_id = ${run.id}::uuid AND outcome #>> '{outcome,output,action}' = 'addFlag'
        `;
        expect(read?.output).toMatchObject({ action: "addFlag", applied: true, value: "seen" });
      }
    } finally {
      if (backfillStarted) await stopIncomingAutomationBackfillRuntime();
      if (automation)
        await deleteIncomingAutomation({
          context: ownerContext,
          mailboxId,
          automationId: automation.id,
          input: { expectedRevision: automation.revision },
        });
      await retireFixtures();
    }
  }, 30_000);

  test("negated own senders are allowed but cannot authorize destructive scope", async () => {
    const own = `own-negation-${suffix}@internal-${suffix}.test`;
    await sql`INSERT INTO mail.sender_identities (short_id, mailbox_id, label, from_address, status) VALUES (${newShortId()}, ${mailboxId}::uuid, 'Negation identity', ${own}, 'verified')`;
    const positive = { field: "sender_domain", operator: "is", value: `external-${suffix}.test` } as const;
    const negative = { field: "sender_address", operator: "is_not", value: own } as const;
    let created = 0;
    const create = (mode: "all" | "any", items: import("../contracts").MailAutomationCondition[], destructive = true) =>
      createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Negated safety ${++created}`,
          enabled: false,
          scope: { mode: "matching", conditions: { mode, items } },
          steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: destructive ? "junk" : "mark_read" } }],
        },
      });
    try {
      expect((await create("all", [negative], false)).ok).toBe(true);
      expect((await create("all", [{ ...negative, operator: "is" }], false)).ok).toBe(false);
      expect((await create("all", [negative])).ok).toBe(false);
      expect((await create("all", [{ field: "sender_domain", operator: "is_not", value: positive.value }])).ok).toBe(false);
      expect((await create("any", [positive, negative])).ok).toBe(false);
      expect((await create("any", [positive])).ok).toBe(true);
      const ownDomain = { field: "sender_domain", operator: "is", value: own.split("@")[1]! } as const;
      expect((await create("all", [ownDomain, { ...positive, operator: "is_not" }])).ok).toBe(false);
      const safe = await create("all", [positive, negative]);
      if (!safe.ok) throw new Error(safe.error.message);
      // Re-check an enabled persisted definition, including an older unsafe scope.
      await sql`UPDATE mail.incoming_automations SET enabled = true WHERE id = ${safe.data.id}::uuid`;
      const validate = () =>
        validateDestructiveIncomingAutomationsForMailbox({ mailboxId, identityAddresses: [own], internalDomains: [], db: sql });
      expect((await validate()).ok).toBe(true);
      for (const conditions of [
        { mode: "all", items: [negative] },
        { mode: "any", items: [positive, negative] },
      ]) {
        await sql`UPDATE mail.incoming_automations SET scope = ${{ mode: "matching", conditions }}::jsonb WHERE id = ${safe.data.id}::uuid`;
        expect((await validate()).ok).toBe(false);
      }
      await sql`UPDATE mail.incoming_automations SET enabled = false WHERE id = ${safe.data.id}::uuid`;
    } finally {
      await sql`DELETE FROM mail.sender_identities WHERE mailbox_id = ${mailboxId}::uuid AND from_address = ${own}`;
    }
  });

  // Starts a backfill and returns its state once its run settled on the Sync worker.
  // It waits for the run's settle event: re-sending the start request would lock the
  // automation row that the run locks for every message it dispatches.
  const runBackfillUntilSettled = async (request: Parameters<typeof startIncomingAutomationBackfill>[0], timeoutMs: number) => {
    const { automationId, input } = request;
    const key = `${automationId}:${input.operationId}`;
    const listening = new AbortController();
    // Subscribed before the start request, so the settle event of a fast run cannot be missed.
    const settled = (async () => {
      const signal = AbortSignal.any([listening.signal, AbortSignal.timeout(timeoutMs)]);
      for await (const event of getProcessSync().events({ signal })) {
        if (event.type === "pump_run_settled" && event.detail?.key === key) return true;
      }
      return false;
    })();
    let didSettle = false;
    try {
      const started = await startIncomingAutomationBackfill(request);
      if (!started.ok) throw new Error(started.error.message);
      didSettle = await settled;
    } finally {
      listening.abort();
    }
    const current = await getIncomingAutomationBackfill({ context: ownerContext, mailboxId, automationId, operationId: input.operationId });
    if (!current.ok) throw new Error(current.error.message);
    if (!didSettle) {
      const { state, newlyAcceptedCount, remainingCount } = current.data;
      throw new Error(
        `Backfill ${key} did not receive pump_run_settled within ${timeoutMs} ms: status=${state}, newlyAcceptedCount=${newlyAcceptedCount}, remainingCount=${remainingCount}`,
      );
    }
    return current.data;
  };

  test("completes an empty durable backfill and preserves its terminal state and activity on replay", async () => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Durable backfill",
        enabled: true,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const operationId = crypto.randomUUID();
    const request = {
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { operationId, expectedRevision: created.data.revision },
    };
    // Simulate a second request arriving while another process owns the complete start critical section.
    const mutex = getProcessSync().mutex({ id: "mail:incoming-automation-start", ttlMs: 30_000, retry: { maxAttempts: 1 } });
    const lock = await mutex.acquire({ resource: created.data.id });
    expect(lock).not.toBeNull();
    if (!lock) return;
    try {
      const concurrent = await startIncomingAutomationBackfill(request);
      expect(concurrent.ok).toBe(false);
      if (!concurrent.ok) expect(concurrent.error.message).toContain("being started");
    } finally {
      await mutex.release(lock);
    }
    await startIncomingAutomationBackfillRuntime();
    try {
      const result = await runBackfillUntilSettled(request, 10_000);
      expect(result.state).toBe("completed");
      expect(result.newlyAcceptedCount).toBe(0);
      const repeated = await startIncomingAutomationBackfill(request);
      expect(repeated.ok && repeated.data.updatedAt).toBe(result.updatedAt);
      // The settle event closes the run's span through a queued trace write, which can land later.
      const closedSpan = async () => {
        const [span] = await sql<{ attributes: Record<string, unknown>; summary: Record<string, unknown> }[]>`
          SELECT attributes, summary FROM logging.trace_spans
          WHERE source = 'mail:incoming-automation-backfill'
            AND attributes ->> 'mail.backfill.operation_id' = ${operationId}
            AND ended_at IS NOT NULL
        `;
        return span;
      };
      const deadline = Date.now() + 10_000;
      let span = await closedSpan();
      while (!span && Date.now() < deadline) {
        await Bun.sleep(20);
        span = await closedSpan();
      }
      expect(span?.attributes["mail.mailbox.id"]).toBe(mailboxId);
      expect(span?.summary.status).toBe("completed");
      expect(span?.summary.dispatched).toBe(0);
    } finally {
      await stopIncomingAutomationBackfillRuntime();
    }
  });

  test("reports a backfill that stopped at its application limit and keeps accepted counts monotonic", async () => {
    const sender = `limited-${suffix}@external.test`;
    const total = 102;
    for (let index = 0; index < total; index += 1) {
      const uid = 20_000 + index;
      await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: {
          remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: String(uid) },
          providerMessageId: `limited-${suffix}-${index}`,
          providerThreadId: null,
          messageId: `<limited-${suffix}-${index}@external.test>`,
          inReplyTo: null,
          references: [],
          subject: `Limited backfill ${index}`,
          sentAt: new Date(Date.now() - (index + 1) * 60_000),
          internalDate: new Date(Date.now() - (index + 1) * 60_000),
          sizeBytes: 128,
          flags: [],
          labels: [],
          addresses: {
            from: [{ name: "Sender", address: sender }],
            replyTo: [],
            to: [{ name: "Support", address: "automation@example.test" }],
            cc: [],
            bcc: [],
          },
          mimeStructure: {},
        } as never,
        captureWorkflowTriggers: false,
      });
    }
    const [reference] = await sql<{ id: string }[]>`
      SELECT id FROM mail.remote_message_refs
      WHERE folder_id = ${inboxFolderId}::uuid AND uid = 20000 AND uid_validity = 1
    `;
    if (!reference) throw new Error("Missing ingested backfill message reference");
    // These freshly ingested rows have no current statistics yet; this read runs once per dispatched message.
    // An unbounded row estimate made Postgres JIT-compile every read, preventing the backfill from finishing in time.
    type ExplainRow = { "QUERY PLAN": [{ Plan: { "Plan Rows": number; "Total Cost": number } }] };
    const [explained] = await sql<ExplainRow[]>`
      EXPLAIN (FORMAT JSON) ${workflowSnapshotQuery({ mailboxId, remoteMessageRefId: reference.id })}
    `;
    if (!explained) throw new Error("Missing workflow snapshot query plan");
    const plan = explained["QUERY PLAN"][0].Plan;
    const defaultJitAboveCost = 100_000; // Postgres's default jit_above_cost threshold.
    expect(plan["Plan Rows"]).toBe(1);
    expect(plan["Total Cost"]).toBeLessThan(defaultJitAboveCost);

    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: `Limited backfill ${suffix}`,
        enabled: true,
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: sender }] },
        },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    let operationId = "";
    const runBackfill = async (revision: number) => {
      operationId = crypto.randomUUID();
      const request = {
        context: ownerContext,
        mailboxId,
        automationId: created.data.id,
        input: { operationId, expectedRevision: revision },
      };
      return { request, result: await runBackfillUntilSettled(request, 20_000) };
    };

    await startIncomingAutomationBackfillRuntime();
    try {
      const first = await runBackfill(created.data.revision);
      // One run applies at most 100 messages; it must not claim completion while candidates remain.
      expect(first.result).toMatchObject({
        state: "limited",
        candidateCount: total,
        alreadyAcceptedCount: 0,
        newlyAcceptedCount: 100,
        remainingCount: 2,
      });

      // Executing the accepted actions moves those messages out of the candidate set.
      await sql`
        UPDATE mail.message_placements placement
        SET deleted_at = now()
        FROM mail.remote_message_refs remote_ref
        WHERE placement.remote_message_ref_id = remote_ref.id
          AND EXISTS (
            SELECT 1 FROM workflows.event event
            WHERE event.app_id = 'mail'
              AND event.scope_id = ${mailboxId}
              AND event.dedupe_key LIKE ${`incoming-automation-existing:${created.data.id}:%`}
              AND event.dedupe_key LIKE '%' || remote_ref.id::text
          )
      `;
      const later = await getIncomingAutomationBackfill({
        context: ownerContext,
        mailboxId,
        automationId: created.data.id,
        operationId: first.request.input.operationId,
      });
      if (!later.ok) throw new Error(later.error.message);
      expect(later.data).toMatchObject({
        state: "limited",
        candidateCount: total,
        alreadyAcceptedCount: 0,
        newlyAcceptedCount: 100,
        remainingCount: 2,
      });

      const second = await runBackfill(created.data.revision);
      expect(second.result).toMatchObject({ state: "completed", newlyAcceptedCount: 2, remainingCount: 0 });
    } finally {
      // A run that did not settle in time would keep dispatching through the drain while later
      // tests use this mailbox. Canceled, it stops at its next checkpoint and the drain returns.
      if (operationId) {
        await cancelIncomingAutomationBackfill({ context: ownerContext, mailboxId, automationId: created.data.id, operationId });
      }
      await stopIncomingAutomationBackfillRuntime();
      // Leave no pending backfill events behind for later tests that dispatch this mailbox scope.
      await sql`
        DELETE FROM workflows.event
        WHERE app_id = 'mail' AND scope_id = ${mailboxId}
          AND dedupe_key LIKE ${`incoming-automation-existing:${created.data.id}:%`}
      `;
      await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: created.data.id,
        input: { expectedRevision: created.data.revision },
      });
    }
  });

  test("requires admin and persists one unified managed workflow", async () => {
    const denied = await createIncomingAutomation({
      context: writerContext,
      mailboxId,
      input: {
        name: "Writer attempt",
        enabled: false,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
      },
    });
    expect(denied.ok).toBe(false);

    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Unified flow",
        enabled: false,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.enabled).toBe(false);
    expect(created.data.workflowSource).toContain("addFlag:");

    const listed = await listIncomingAutomations(ownerContext, mailboxId);
    expect(listed.ok && listed.data.map((item) => item.id)).toContain(created.data.id);

    const enabledResult = await setIncomingAutomationEnabled({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: created.data.revision, enabled: true },
    });
    expect(enabledResult.ok && enabledResult.data.enabled).toBe(true);
    if (!enabledResult.ok) return;

    const classifierId = crypto.randomUUID();
    const updated = await updateIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: {
        expectedRevision: enabledResult.data.revision,
        name: "Unified AI flow",
        enabled: true,
        scope: { mode: "all" },
        steps: [
          {
            id: classifierId,
            kind: "ai_classify",
            instructions: "Choose a category",
            choices: [
              { name: "Important", description: "Needs attention" },
              { name: "Routine", description: "Routine mail" },
            ],
          },
          {
            id: crypto.randomUUID(),
            kind: "if",
            condition: { sourceStepId: classifierId, operator: "equals", value: "Important" },
            then: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "set_status", status: "needs_action" } }],
            else: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
          },
        ],
      },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.workflowSource).toContain("aiClassify:");

    const backfill = await startIncomingAutomationBackfill({
      context: ownerContext,
      mailboxId,
      automationId: updated.data.id,
      input: { operationId: crypto.randomUUID(), expectedRevision: updated.data.revision },
    });
    expect(backfill.ok).toBe(false);
    if (!backfill.ok) expect(backfill.error.message).toContain("AI");

    const deleted = await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: updated.data.id,
      input: { expectedRevision: updated.data.revision },
    });
    expect(deleted.ok).toBe(true);
    const activityMetadata = await listIncomingAutomationActivityMetadata(ownerContext, mailboxId, [updated.data.workflowId]);
    expect(activityMetadata.ok && activityMetadata.data).toContainEqual({
      id: updated.data.id,
      workflowId: updated.data.workflowId,
      name: updated.data.name,
    });
  });

  test("creates a disabled automation with a paused bounded mandate and no user token", async () => {
    const credentialCount = async () => {
      const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM auth.service_account_credentials`;
      return row!.count;
    };
    const beforeCredentials = await credentialCount();
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Mandated Spaces effects",
        enabled: false,
        scope: { mode: "all" },
        steps: [
          { id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" },
          {
            id: crypto.randomUUID(),
            kind: "create_space_event",
            spaceId: "Space1",
            columnId: "Column",
            event: {
              kind: "custom",
              title: "Planning",
              startsAt: "2026-09-03T10:00:00Z",
              endsAt: "2026-09-03T11:00:00Z",
              allDay: false,
            },
          },
        ],
      },
    });
    if (!created.ok) throw new Error(created.error.message);

    const [stored] = await sql<
      {
        mandate_id: string | null;
        state: string | null;
        owner_app_id: string | null;
        workload_id: string | null;
        subject_user_id: string | null;
        policy: unknown;
      }[]
    >`
        SELECT automation.mandate_id,
               mandate.state,
               mandate.owner_app_id,
               mandate.workload_id,
               mandate.subject_user_id,
               mandate.policy
        FROM mail.incoming_automations automation
        LEFT JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
        WHERE automation.id = ${created.data.id}::uuid
      `;
    expect(stored).toMatchObject({
      state: "paused",
      owner_app_id: "mail",
      workload_id: created.data.id,
      subject_user_id: ownerContext.actor.kind === "user" ? ownerContext.actor.user.id : null,
      policy: {
        version: 1,
        apps: ["spaces"],
        operations: ["capability.action.run:event.create", "capability.action.run:item.reference.add"],
        actions: "preapproved",
      },
    });
    expect(stored?.mandate_id).not.toBeNull();
    expect(await credentialCount()).toBe(beforeCredentials);

    const deleted = await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: created.data.revision },
    });
    expect(deleted.ok).toBe(true);
    const [revoked] = await sql<{ state: string; revoke_reason: string | null }[]>`
        SELECT state, revoke_reason
        FROM auth.mandates
        WHERE id = ${stored?.mandate_id ?? null}::uuid
      `;
    expect(revoked).toEqual({ state: "revoked", revoke_reason: "Incoming automation deleted" });
  });

  test("lets a shared mailbox admin stop but not repurpose or resume another user's mandate", async () => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Shared mailbox authority",
        enabled: true,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    let current = created.data;
    const [binding] = await sql<{ mandate_id: string }[]>`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${current.id}::uuid`;
    const originalMandate = await mandates.get(binding!.mandate_id);
    if (!originalMandate) throw new Error("Expected mandate");
    const update = (context: MailRequestContext, patch: Partial<Parameters<typeof updateIncomingAutomation>[0]["input"]>) =>
      updateIncomingAutomation({
        context,
        mailboxId,
        automationId: current.id,
        input: {
          expectedRevision: current.revision,
          name: current.name,
          enabled: current.enabled,
          scope: current.scope,
          steps: current.steps,
          ...patch,
        },
      });

    const renamed = await update(sharedAdminContext, { name: "Renamed by shared admin" });
    if (!renamed.ok) throw new Error(renamed.error.message);
    current = renamed.data;
    expect(current.workflowVersionId).toBe(created.data.workflowVersionId);
    expect((await mandates.get(originalMandate.id))?.revision).toBe(originalMandate.revision);
    const unchanged = await update(sharedAdminContext, {});
    expect(unchanged.ok && unchanged.data.revision).toBe(current.revision);

    const targetChange = await update(sharedAdminContext, {
      steps: [{ id: current.steps[0]!.id, kind: "link_space_item", itemId: "Item02" }],
    });
    expect(targetChange.ok ? null : targetChange.error.code).toBe("FORBIDDEN");
    expect(targetChange.ok ? null : targetChange.error.message).toContain("reauthorization");
    const scopeChange = await update(sharedAdminContext, {
      scope: {
        mode: "matching",
        conditions: {
          mode: "all",
          items: [{ field: "sender_address", operator: "is", value: "only@example.test" }],
        },
      },
    });
    expect(scopeChange.ok ? null : scopeChange.error.code).toBe("FORBIDDEN");
    expect((await mandates.get(originalMandate.id))?.revision).toBe(originalMandate.revision);

    const paused = await setIncomingAutomationEnabled({
      context: sharedAdminContext,
      mailboxId,
      automationId: current.id,
      input: { expectedRevision: current.revision, enabled: false },
    });
    if (!paused.ok) throw new Error(paused.error.message);
    current = paused.data;
    expect((await mandates.get(originalMandate.id))?.state).toBe("paused");
    const pausedNoop = await setIncomingAutomationEnabled({
      context: sharedAdminContext,
      mailboxId,
      automationId: current.id,
      input: { expectedRevision: current.revision, enabled: false },
    });
    expect(pausedNoop.ok && pausedNoop.data.revision).toBe(current.revision);
    const pausedRename = await update(sharedAdminContext, { name: "Still paused" });
    if (!pausedRename.ok) throw new Error(pausedRename.error.message);
    current = pausedRename.data;
    const resume = await setIncomingAutomationEnabled({
      context: sharedAdminContext,
      mailboxId,
      automationId: current.id,
      input: { expectedRevision: current.revision, enabled: true },
    });
    expect(resume.ok ? null : resume.error.code).toBe("FORBIDDEN");
    const updateResume = await update(sharedAdminContext, { enabled: true });
    expect(updateResume.ok ? null : updateResume.error.code).toBe("FORBIDDEN");
    expect((await mandates.get(originalMandate.id))?.state).toBe("paused");

    const ownerUpdate = await update(ownerContext, {
      enabled: true,
      steps: [{ id: current.steps[0]!.id, kind: "link_space_item", itemId: "Item02" }],
    });
    if (!ownerUpdate.ok) throw new Error(ownerUpdate.error.message);
    current = ownerUpdate.data;
    expect((await mandates.get(originalMandate.id))?.state).toBe("active");
    expect((await mandates.get(originalMandate.id))?.subject).toEqual(originalMandate.subject);
    const deleted = await deleteIncomingAutomation({
      context: sharedAdminContext,
      mailboxId,
      automationId: current.id,
      input: { expectedRevision: current.revision },
    });
    expect(deleted.ok).toBe(true);
    expect((await mandates.get(originalMandate.id))?.state).toBe("revoked");
    const lifecycleAudit = await sql<{ action: string; actor_user_id: string | null; metadata: unknown }[]>`
        SELECT action, actor_user_id, metadata FROM audit.events
        WHERE target_type = 'mandate' AND target_id = ${originalMandate.id} AND action IN ('mandate.pause', 'mandate.revoke')
        ORDER BY id
      `;
    expect(
      lifecycleAudit.map((event) => ({
        action: event.action,
        actor_user_id: event.actor_user_id,
        owner_app_id: parsePgJsonRecord(event.metadata)?.ownerAppId,
      })),
    ).toEqual([
      { action: "mandate.pause", actor_user_id: null, owner_app_id: "mail" },
      { action: "mandate.revoke", actor_user_id: null, owner_app_id: "mail" },
    ]);
  });

  test("the mobile app's session never creates, widens or resumes an automation's mandate", async () => {
    const appContext: MailRequestContext = {
      ...ownerContext,
      actor: ownerContext.actor.kind === "user" ? { ...ownerContext.actor, sessionKind: "app" } : ownerContext.actor,
    };
    const webOnly = { code: "FORBIDDEN", message: "Use Cloud on the web for this." };
    const steps = [{ id: crypto.randomUUID(), kind: "link_space_item" as const, itemId: "Item01" }];
    const input = { name: "Phone authority", enabled: false, scope: { mode: "all" as const }, steps };
    const fromPhone = await createIncomingAutomation({ context: appContext, mailboxId, input });
    expect(fromPhone.ok ? null : fromPhone.error).toMatchObject(webOnly);

    const created = await createIncomingAutomation({ context: ownerContext, mailboxId, input });
    if (!created.ok) throw new Error(created.error.message);
    const [binding] = await sql<
      { mandate_id: string }[]
    >`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`;
    const mandate = await mandates.get(binding!.mandate_id);
    const update = (patch: Partial<Parameters<typeof updateIncomingAutomation>[0]["input"]>, revision = created.data.revision) =>
      updateIncomingAutomation({
        context: appContext,
        mailboxId,
        automationId: created.data.id,
        input: { expectedRevision: revision, ...input, ...patch },
      });

    // Renaming leaves the mandate alone, so the phone may do it.
    const renamed = await update({ name: "Renamed on the phone" });
    if (!renamed.ok) throw new Error(renamed.error.message);
    const widened = await update({ steps: [{ ...steps[0]!, itemId: "Item02" }] }, renamed.data.revision);
    expect(widened.ok ? null : widened.error).toMatchObject(webOnly);
    const resumed = await setIncomingAutomationEnabled({
      context: appContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: renamed.data.revision, enabled: true },
    });
    expect(resumed.ok ? null : resumed.error).toMatchObject(webOnly);
    expect(await mandates.get(mandate!.id)).toMatchObject({ state: "paused", revision: mandate!.revision });

    const deleted = await deleteIncomingAutomation({
      context: appContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: renamed.data.revision },
    });
    expect(deleted.ok).toBe(true);
  });

  test("stops mandate-bearing steps when the authorizing user loses mailbox access", async () => {
    const uid = `incoming-automation-mandate-loss-${suffix}`;
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'mandate loss incoming automation test', false)
      RETURNING id
    `;
    if (!row) throw new Error("Failed to create mandate loss user");
    userIds.push(row.id);
    const authorContext = contextFor({ id: row.id, uid, displayName: "mandate loss incoming automation test" });
    const granted = await grantMailboxAccess({
      context: ownerContext,
      mailboxId,
      principal: { type: "user", userId: row.id },
      permission: "admin",
    });
    if (!granted.ok) throw new Error(granted.error.message);

    const created = await createIncomingAutomation({
      context: authorContext,
      mailboxId,
      input: {
        name: `Mandate loss ${suffix}`,
        enabled: true,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const runId = await createWorkflowRun({
      appId: "mail",
      scopeId: mailboxId,
      workflowId: created.data.workflowId,
      workflowVersionId: created.data.workflowVersionId,
      mode: "execute",
      authorization: {},
      idempotencyKey: `mandate-loss-${suffix}`,
      occurredAt: new Date(),
    });
    const previousCredential = process.env.CLOUD_APP_CREDENTIAL;
    process.env.CLOUD_APP_CREDENTIAL = "mandate-loss-test-credential";
    try {
      const caller = await resolveIncomingAutomationMandateCaller(runId);
      expect(caller.mandate.callingAppId).toBe("mail");
      const mandateId = caller.mandate.id;

      const access = await listMailboxAccess(ownerContext, mailboxId);
      if (!access.ok) throw new Error(access.error.message);
      const entry = access.data.find((item) => item.principal.type === "user" && item.principal.userId === row.id);
      if (!entry) throw new Error("Expected mailbox access entry");
      const revoked = await revokeMailboxAccess({ context: ownerContext, mailboxId, accessId: entry.id });
      if (!revoked.ok) throw new Error(revoked.error.message);

      await expect(resolveIncomingAutomationMandateCaller(runId)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect((await mandates.get(mandateId))?.state).toBe("paused");
    } finally {
      if (previousCredential === undefined) delete process.env.CLOUD_APP_CREDENTIAL;
      else process.env.CLOUD_APP_CREDENTIAL = previousCredential;
    }
  });

  test("lets a shared mailbox admin remove all Spaces effects and disable revoked authority", async () => {
    for (const externallyRevoked of [false, true]) {
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Remove shared Spaces ${externallyRevoked}`,
          enabled: true,
          scope: { mode: "all" },
          steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const [binding] = await sql<
        { mandate_id: string }[]
      >`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`;
      const mandate = await mandates.get(binding!.mandate_id);
      if (!mandate) throw new Error("Expected mandate");
      if (externallyRevoked) {
        const revoked = await mandates.revoke({
          mandateId: mandate.id,
          expectedRevision: mandate.revision,
          authority: { kind: "workload", ownerAppId: "mail" },
          reason: "External revocation test",
        });
        if (!revoked.ok) throw new Error(revoked.error.message);
      }
      const updated = await updateIncomingAutomation({
        context: sharedAdminContext,
        mailboxId,
        automationId: created.data.id,
        input: {
          expectedRevision: created.data.revision,
          name: created.data.name,
          enabled: false,
          scope: created.data.scope,
          steps: externallyRevoked ? created.data.steps : [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
        },
      });
      expect(updated.ok).toBe(true);
      expect((await mandates.get(mandate.id))?.state).toBe("revoked");
      const [after] = await sql<
        { mandate_id: string | null }[]
      >`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`;
      expect(after?.mandate_id).toBe(externallyRevoked ? mandate.id : null);
      if (updated.ok)
        expect(
          (
            await deleteIncomingAutomation({
              context: sharedAdminContext,
              mailboxId,
              automationId: created.data.id,
              input: { expectedRevision: updated.data.revision },
            })
          ).ok,
        ).toBe(true);
    }
  });

  test("pauses the mandate when an enabled automation is disabled", async () => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Disable mandated automation",
        enabled: true,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const disabled = await setIncomingAutomationEnabled({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: created.data.revision, enabled: false },
    });
    if (!disabled.ok) throw new Error(disabled.error.message);
    const [mandate] = await sql<{ id: string; state: string }[]>`
        SELECT mandate.id, mandate.state
        FROM mail.incoming_automations automation
        JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
        WHERE automation.id = ${created.data.id}::uuid
      `;
    expect(mandate?.state).toBe("paused");
    await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: disabled.data.revision },
    });
  });

  test("resumes a paused mandate when the automation is enabled interactively", async () => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Resume mandated automation",
        enabled: false,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const enabled = await setIncomingAutomationEnabled({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: created.data.revision, enabled: true },
    });
    if (!enabled.ok) throw new Error(enabled.error.message);
    const [mandate] = await sql<{ id: string; state: string }[]>`
        SELECT mandate.id, mandate.state
        FROM mail.incoming_automations automation
        JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
        WHERE automation.id = ${created.data.id}::uuid
      `;
    expect(mandate?.state).toBe("active");
    await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: { expectedRevision: enabled.data.revision },
    });
  });
  for (const ordering of ["read first", "move first"] as const) {
    test(`records the cross-automation read/move race with ${ordering}`, async () => {
      const [archive] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid
    `;
      if (!archive) throw new Error("Failed to load the archive folder public id");
      const [inbox] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.folders WHERE id = ${inboxFolderId}::uuid`;
      if (!inbox) throw new Error("Failed to load inbox public id");
      const sender = `ordered-${ordering.replaceAll(" ", "-")}-${suffix}@external.test`;
      const scope = {
        mode: "matching" as const,
        conditions: { mode: "all" as const, items: [{ field: "sender_address" as const, operator: "is" as const, value: sender }] },
      };
      const older = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Ordered move ${suffix}`,
          enabled: true,
          scope,
          steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: archive.short_id } }],
        },
      });
      if (!older.ok) throw new Error(older.error.message);
      const newer = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Ordered read and move ${suffix}`,
          enabled: true,
          scope,
          steps: [
            { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } },
            { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: inbox.short_id } },
          ],
        },
      });
      if (!newer.ok) throw new Error(newer.error.message);
      // The list is the run order.
      const listed = await listIncomingAutomations(ownerContext, mailboxId);
      const listedIds = listed.ok ? listed.data.map((item) => item.id) : [];
      expect(listedIds.indexOf(older.data.id)).toBeLessThan(listedIds.indexOf(newer.data.id));

      const uid = ordering === "read first" ? 8101 : 8102;
      await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: {
          remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: "1" },
          providerMessageId: `ordered-${ordering.replaceAll(" ", "-")}-${suffix}`,
          providerThreadId: null,
          messageId: `<ordered-${ordering.replaceAll(" ", "-")}-${suffix}@external.test>`,
          inReplyTo: null,
          references: [],
          subject: "Ordered automations",
          sentAt: new Date(),
          internalDate: new Date(),
          sizeBytes: 128,
          flags: [],
          labels: [],
          addresses: {
            from: [{ name: "Boss", address: sender }],
            replyTo: [],
            to: [{ name: "Support", address: "automation@example.test" }],
            cc: [],
            bcc: [],
          },
          mimeStructure: {},
        } as never,
        captureWorkflowTriggers: true,
      });
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      const runIdFor = async (workflowId: string): Promise<string> => {
        const [row] = await sql<{ id: string }[]>`
        SELECT run.id
        FROM workflows.run run
        WHERE run.workflow_id = ${workflowId}::uuid
        ORDER BY run.created_at DESC
        LIMIT 1
      `;
        if (!row) throw new Error("Automation run was not dispatched");
        return row.id;
      };
      const olderRunId = await runIdFor(older.data.workflowId);
      const newerRunId = await runIdFor(newer.data.workflowId);

      // Each run issues its provider command and parks on it. The run the worker claims first queues its
      // command first, and the mailbox executes commands in that order.
      const commandsFor = async (runId: string) => sql<{ kind: string }[]>`
      SELECT kind FROM mail.commands WHERE correlation_id = ${runId}
    `;
      for (const runId of ordering === "read first" ? [newerRunId, olderRunId] : [olderRunId, newerRunId]) {
        expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      }
      expect((await commandsFor(olderRunId)).map((command) => command.kind)).toEqual(["move"]);
      const [readCommand] = await sql<{ id: string; ref: string }[]>`
        SELECT id, target ->> 'remoteMessageRefId' AS ref FROM mail.commands
        WHERE correlation_id = ${newerRunId} AND kind = 'change_message_state'
      `;
      const [moveCommand] = await sql<{ id: string }[]>`
        SELECT id FROM mail.commands WHERE correlation_id = ${olderRunId} AND kind = 'move'
      `;
      if (!readCommand || !moveCommand) throw new Error("Missing ordered automation commands");
      let flags: string[] = [];
      let moved = false;
      const state = () => ({
        exists: !moved,
        flags,
        keywords: [],
        messageId: `<ordered-${ordering.replaceAll(" ", "-")}-${suffix}@external.test>`,
        modseq: flags.length ? "2" : "1",
      });
      const getState = spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async () => state());
      const getStates = spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(
        async (_config, messages) => new Map(moved ? [] : messages.uids.map((uid) => [uid, state()] as const)),
      );
      const change = spyOn(imapSmtpConnector, "changeMessageState").mockImplementation(async (_config, _target, requested) => {
        flags = requested.addFlags;
        return state();
      });
      const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
        uidValidity: "1",
        uidNext: 9001,
        highestModseq: null,
        messages: 0,
      });
      const move = spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (_config, messages) => {
        moved = true;
        return { completed: true, destinationUidValidity: "1", destinationUids: new Map(messages.uids.map((uid) => [uid, 9001])) };
      });
      try {
        if (ordering === "read first") {
          // #1036: a confirmed read invalidates the older move's frozen provider precondition.
          expect(await executeMutationCommand(readCommand.id)).toBe("confirmed");
          expect(await runMailWorkflow(newerRunId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
          const [skipped] = await sql<{ output: Record<string, unknown> }[]>`
            SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
            WHERE run_id = ${newerRunId}::uuid AND outcome #>> '{outcome,output,action}' = 'moveMessage'
          `;
          expect(skipped?.output).toEqual({ action: "moveMessage", applied: false, skipped: "earlier_automation" });
          const [readStep] = await sql<{ output: Record<string, unknown> }[]>`
            SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
            WHERE run_id = ${newerRunId}::uuid AND outcome #>> '{outcome,output,action}' = 'addFlag'
          `;
          expect(readStep?.output).toMatchObject({ applied: true, value: "seen" });
          expect(await executeMutationCommand(moveCommand.id)).toBe("failed");
          const [failed] = await sql<{ last_error_code: string }[]>`
            SELECT last_error_code FROM mail.commands WHERE id = ${moveCommand.id}::uuid
          `;
          expect(failed?.last_error_code).toBe("REMOTE_STATE_CHANGED");
          expect(await runMailWorkflow(olderRunId)).toMatchObject({ state: "finished", result: { state: "failed" } });
          expect(change).toHaveBeenCalledTimes(1);
          expect(move).not.toHaveBeenCalled();
        } else {
          // #1036: the older move removes the source before the newer read executes.
          expect(await executeMutationCommand(moveCommand.id)).toBe("confirmed");
          expect(await runMailWorkflow(olderRunId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
          expect(await executeMutationCommand(readCommand.id)).toBe("failed");
          const [failed] = await sql<{ last_error_code: string }[]>`
            SELECT last_error_code FROM mail.commands WHERE id = ${readCommand.id}::uuid
          `;
          expect(failed?.last_error_code).toBe("REMOTE_MESSAGE_STALE");
          expect(await runMailWorkflow(newerRunId)).toMatchObject({ state: "finished", result: { state: "failed" } });
          expect(change).not.toHaveBeenCalled();
          expect(move).toHaveBeenCalledTimes(1);
        }
        const [olderRun] = await sql<{ state: string; effects_used: Record<string, number> | string }[]>`
          SELECT state, effects_used FROM workflows.run WHERE id = ${olderRunId}::uuid
        `;
        expect(olderRun?.state).toBe(ordering === "read first" ? "failed" : "succeeded");
        const used = typeof olderRun?.effects_used === "string" ? JSON.parse(olderRun.effects_used) : olderRun?.effects_used;
        expect(used?.maxMoves).toBe(1);
        expect((await commandsFor(olderRunId)).map((command) => command.kind)).toEqual(["move"]);
        expect(await commandsFor(newerRunId)).toEqual([{ kind: "change_message_state" }]);
        const [newerRun] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id = ${newerRunId}::uuid`;
        expect(newerRun?.state).toBe(ordering === "read first" ? "succeeded" : "failed");
        const placements = await sql<{ folder_id: string; flags: string[] }[]>`
          SELECT folder_id, flags FROM mail.message_placements WHERE message_id = (
            SELECT message_id FROM mail.remote_message_refs WHERE id = ${readCommand.ref}::uuid
          ) AND deleted_at IS NULL
        `;
        expect(placements).toEqual([
          {
            folder_id: ordering === "read first" ? inboxFolderId : archiveFolderId,
            flags: ordering === "read first" ? ["\\Seen"] : [],
          },
        ]);
        expect(moved).toBe(ordering === "move first");
        expect(flags).toEqual(ordering === "read first" ? ["\\Seen"] : []);
      } finally {
        move.mockRestore();
        status.mockRestore();
        change.mockRestore();
        getStates.mockRestore();
        getState.mockRestore();
        for (const automation of [newer.data, older.data]) {
          const [current] = await sql<{ revision: string | number }[]>`
            SELECT revision FROM mail.incoming_automations WHERE id = ${automation.id}::uuid
          `;
          await deleteIncomingAutomation({
            context: ownerContext,
            mailboxId,
            automationId: automation.id,
            input: { expectedRevision: Number(current!.revision) },
          });
        }
      }
    });
  }

  test("re-runs only failed or canceled incoming automation attempts with an opt-in backfill", async () => {
    const [archive] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid
    `;
    if (!archive) throw new Error("Failed to load the archive folder public id");
    const sender = `retry-backfill-${suffix}@external.test`;
    const automation = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: `Retry backfill ${suffix}`,
        enabled: true,
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: sender }] },
        },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: archive.short_id } }],
      },
    });
    if (!automation.ok) throw new Error(automation.error.message);
    const messages: Array<{ ref: string; messageId: string; uid: number; state: string }> = [];
    let operationId = "";
    let nonRepeatableAutomation: { id: string; revision: number } | undefined;
    const requestFor = (retryFailed = false) => {
      operationId = crypto.randomUUID();
      return {
        context: ownerContext,
        mailboxId,
        automationId: automation.data.id,
        input: { operationId, expectedRevision: automation.data.revision, retryFailed },
      };
    };
    const events = () => sql<{ dedupe_key: string; ref: string }[]>`
      SELECT dedupe_key, context #>> '{preconditions,message,remoteMessageRefId}' AS ref
      FROM workflows.event
      WHERE app_id = 'mail' AND scope_id = ${mailboxId}
        AND dedupe_key LIKE ${`incoming-automation-existing:${automation.data.id}:%`}
      ORDER BY dedupe_key
    `;
    const ingest = async (index: number, capture: boolean) => {
      const uid = 30_000 + index;
      const messageId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: {
          remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: String(uid) },
          providerMessageId: `retry-backfill-${suffix}-${index}`,
          providerThreadId: null,
          messageId: `<retry-backfill-${suffix}-${index}@external.test>`,
          inReplyTo: null,
          references: [],
          subject: `Retry backfill ${index}`,
          sentAt: new Date(),
          internalDate: new Date(),
          sizeBytes: 128,
          flags: [],
          labels: [],
          addresses: {
            from: [{ name: "Sender", address: sender }],
            replyTo: [],
            to: [{ name: "Support", address: "automation@example.test" }],
            cc: [],
            bcc: [],
          },
          mimeStructure: {},
        },
        captureWorkflowTriggers: capture,
      });
      const [reference] = await sql<{ id: string }[]>`
        SELECT id FROM mail.remote_message_refs
        WHERE folder_id = ${inboxFolderId}::uuid AND uid = ${uid} AND uid_validity = 1
      `;
      if (!reference) throw new Error("Missing retry backfill message reference");
      return { ref: reference.id, messageId, uid };
    };
    await startIncomingAutomationBackfillRuntime();
    try {
      for (const [index, state] of ["failed", "canceled", "succeeded"].entries()) {
        messages.push({ ...(await ingest(index, false)), state });
      }
      expect(await runBackfillUntilSettled(requestFor(), 10_000)).toMatchObject({
        retryFailed: false,
        candidateCount: 3,
        newlyAcceptedCount: 3,
        remainingCount: 0,
        state: "completed",
      });
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      for (const message of messages) {
        // Simulate #876's terminal outcomes without executing the original move runs.
        const runs = await sql<{ id: string }[]>`
          UPDATE workflows.run run SET state = ${message.state}, finished_at = now()
          FROM workflows.event event
          WHERE run.event_id = event.id AND run.workflow_id = ${automation.data.workflowId}::uuid
            AND run.parent_run_id IS NULL
            AND event.context #>> '{preconditions,message,remoteMessageRefId}' = ${message.ref}
          RETURNING run.id
        `;
        expect(runs).toHaveLength(1);
      }
      const originalEvents = await events();
      expect(originalEvents).toHaveLength(3);
      expect(await runBackfillUntilSettled(requestFor(), 10_000)).toMatchObject({
        retryFailed: false,
        newlyAcceptedCount: 0,
        remainingCount: 0,
        state: "completed",
      });
      expect(await events()).toEqual(originalEvents);

      // Normal backfills also re-run live messages: acceptance matches incoming-automation-existing: keys, not message: keys.
      for (const [index, state] of [
        [3, "failed"],
        [4, "running"],
      ] as const) {
        messages.push({ ...(await ingest(index, true)), state });
      }
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      for (const message of messages.filter((message) => message.uid >= 30_003)) {
        const runs = await sql<{ id: string }[]>`
          UPDATE workflows.run run
          SET state = ${message.state}, finished_at = ${message.state === "failed" ? sql`now()` : sql`NULL`}
          FROM workflows.event event
          WHERE run.event_id = event.id AND run.workflow_id = ${automation.data.workflowId}::uuid
            AND run.parent_run_id IS NULL
            AND event.dedupe_key = ${`message:${message.ref}:${automation.data.workflowId}`}
          RETURNING run.id
        `;
        expect(runs).toHaveLength(1);
      }

      const retryRequest = requestFor(true);
      const retry = await runBackfillUntilSettled(retryRequest, 10_000);
      expect(retry).toMatchObject({
        retryFailed: true,
        candidateCount: 3,
        alreadyAcceptedCount: 0,
        newlyAcceptedCount: 3,
        remainingCount: 0,
        state: "completed",
      });
      const retriedEvents = (await events()).filter((event) => event.dedupe_key.endsWith(`:retry:${retryRequest.input.operationId}`));
      expect(retriedEvents).toHaveLength(3);
      for (const message of messages) {
        expect(retriedEvents.filter((event) => event.ref === message.ref)).toEqual(
          message.state === "succeeded" || message.state === "running"
            ? []
            : [
                {
                  ref: message.ref,
                  dedupe_key: `incoming-automation-existing:${automation.data.id}:v${automation.data.workflowVersionId}:${message.ref}:retry:${retryRequest.input.operationId}`,
                },
              ],
        );
      }
      const repeated = await startIncomingAutomationBackfill(retryRequest);
      expect(repeated.ok && repeated.data).toEqual(retry);
      expect(await events()).toHaveLength(6);
      const conflicting = await startIncomingAutomationBackfill({ ...retryRequest, input: { ...retryRequest.input, retryFailed: false } });
      expect(conflicting.ok).toBe(false);
      if (!conflicting.ok) expect(conflicting.error.code).toBe("CONFLICT");

      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      const retriedRuns = await sql<{ id: string; ref: string }[]>`
        SELECT run.id, event.context #>> '{preconditions,message,remoteMessageRefId}' AS ref
        FROM workflows.run run JOIN workflows.event event ON event.id = run.event_id
        WHERE run.workflow_id = ${automation.data.workflowId}::uuid AND run.parent_run_id IS NULL
          AND event.dedupe_key = ANY(${toPgTextArray(retriedEvents.map((event) => event.dedupe_key))}::text[])
      `;
      expect(retriedRuns).toHaveLength(3);
      for (const run of retriedRuns) {
        expect((await runMailWorkflow(run.id)).state).toBe("finished");
        const [move] = await sql<{ id: string; ref: string }[]>`
          SELECT id, target ->> 'remoteMessageRefId' AS ref FROM mail.commands
          WHERE correlation_id = ${run.id} AND kind = 'move' AND state = 'queued'
        `;
        if (!move) throw new Error("Retry did not create a move command");
        expect(move.ref).toBe(run.ref);
        const message = messages.find((message) => message.ref === run.ref);
        if (!message) throw new Error("Retry run did not match an ingested message");
        // Record the provider move as the command runtime does, then resume the real workflow.
        const [archived] = await sql<{ id: string }[]>`
          WITH source AS (
            UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${move.ref}::uuid RETURNING message_id
          ), placement AS (
            UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${move.ref}::uuid
          )
          INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
          SELECT ${archiveFolderId}::uuid, message_id, 1, ${message.uid} FROM source RETURNING id
        `;
        if (!archived) throw new Error("Failed to record the retried move");
        await sql`
          INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
          SELECT id, folder_id, message_id FROM mail.remote_message_refs WHERE id = ${archived.id}::uuid
        `;
        await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${move.id}::uuid`;
        expect(await wakeWorkflowRunsWaitingOn({ appId: "mail", kind: "mail.command", key: move.id })).toContain(run.id);
        expect((await runMailWorkflow(run.id)).state).toBe("finished");
        const [finished] = await sql<{ state: string }[]>`SELECT state FROM workflows.run WHERE id = ${run.id}::uuid`;
        expect(finished?.state).toBe("succeeded");
      }
      const stillRunning = messages.find((message) => message.uid === 30_004);
      if (!stillRunning) throw new Error("Missing still-running live message");
      const lateFailures = await sql<{ id: string }[]>`
        UPDATE workflows.run run SET state = 'failed', finished_at = now()
        FROM workflows.event event
        WHERE run.event_id = event.id AND run.workflow_id = ${automation.data.workflowId}::uuid
          AND run.parent_run_id IS NULL
          AND event.dedupe_key = ${`message:${stillRunning.ref}:${automation.data.workflowId}`}
        RETURNING run.id
      `;
      expect(lateFailures).toHaveLength(1);
      const frozen = await getIncomingAutomationBackfill({
        context: ownerContext,
        mailboxId,
        automationId: automation.data.id,
        operationId: retryRequest.input.operationId,
      });
      expect(frozen.ok && frozen.data).toMatchObject({ state: "completed", candidateCount: 3, remainingCount: 0 });

      const finalRetryRequest = requestFor(true);
      expect(await runBackfillUntilSettled(finalRetryRequest, 10_000)).toMatchObject({
        retryFailed: true,
        candidateCount: 1,
        newlyAcceptedCount: 1,
        remainingCount: 0,
        state: "completed",
      });
      for (const message of messages) {
        const placements = await sql<{ folder_id: string }[]>`
          SELECT folder_id FROM mail.message_placements WHERE message_id = ${message.messageId}::uuid AND deleted_at IS NULL
        `;
        expect(placements).toEqual([
          { folder_id: message.state === "succeeded" || message.uid === 30_004 ? inboxFolderId : archiveFolderId },
        ]);
      }

      const nonRepeatable = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: `Non-repeatable retry backfill ${suffix}`,
          enabled: true,
          scope: {
            mode: "matching",
            conditions: {
              mode: "all",
              items: [{ field: "sender_address", operator: "is", value: `non-repeatable-${suffix}@external.test` }],
            },
          },
          steps: [
            { id: crypto.randomUUID(), kind: "add_comment", body: { kind: "custom", value: "Filed by rule" } },
            { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: archive.short_id } },
          ],
        },
      });
      if (!nonRepeatable.ok) throw new Error(nonRepeatable.error.message);
      nonRepeatableAutomation = nonRepeatable.data;
      const rejected = await startIncomingAutomationBackfill({
        context: ownerContext,
        mailboxId,
        automationId: nonRepeatable.data.id,
        input: { operationId: crypto.randomUUID(), expectedRevision: nonRepeatable.data.revision, retryFailed: true },
      });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe("BAD_INPUT");

      const denied = await startIncomingAutomationBackfill({ ...finalRetryRequest, context: writerContext });
      expect(denied.ok).toBe(false);
      if (!denied.ok) expect(denied.error.code).toBe("FORBIDDEN");
    } finally {
      if (nonRepeatableAutomation) {
        await deleteIncomingAutomation({
          context: ownerContext,
          mailboxId,
          automationId: nonRepeatableAutomation.id,
          input: { expectedRevision: nonRepeatableAutomation.revision },
        });
      }
      if (operationId)
        await cancelIncomingAutomationBackfill({ context: ownerContext, mailboxId, automationId: automation.data.id, operationId });
      await stopIncomingAutomationBackfillRuntime();
      await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: automation.data.id,
        input: { expectedRevision: automation.data.revision },
      });
      await sql`
        DELETE FROM workflows.event
        WHERE app_id = 'mail' AND scope_id = ${mailboxId}
          AND dedupe_key LIKE ${`incoming-automation-existing:${automation.data.id}:%`}
      `;
    }
  }, 30_000);

  test("retry-failed uses current seen state after a confirmed read and a failed move", async () => {
    const [archive] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid`;
    if (!archive) throw new Error("Missing retry destination");
    const sender = `retry-read-move-${suffix}@external.test`;
    const automation = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: `Retry read then move ${suffix}`,
        enabled: true,
        scope: { mode: "matching", conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: sender }] } },
        steps: [
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } },
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: archive.short_id } },
        ],
      },
    });
    if (!automation.ok) throw new Error(automation.error.message);
    const uid = 31_000;
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      captureWorkflowTriggers: true,
      message: {
        remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: "1" },
        providerMessageId: `retry-read-move-${suffix}`,
        providerThreadId: null,
        messageId: `<retry-read-move-${suffix}@external.test>`,
        inReplyTo: null,
        references: [],
        subject: "Retry read then move",
        sentAt: new Date(),
        internalDate: new Date(),
        sizeBytes: 128,
        flags: [],
        labels: [],
        addresses: { from: [{ name: "Sender", address: sender }], replyTo: [], to: [], cc: [], bcc: [] },
        mimeStructure: {},
      },
    });
    const runFor = async () => {
      const [run] = await sql<{ id: string }[]>`
        SELECT id FROM workflows.run WHERE workflow_id = ${automation.data.workflowId}::uuid ORDER BY created_at DESC, id DESC LIMIT 1
      `;
      if (!run) throw new Error("Missing retry read-move run");
      return run.id;
    };
    const commandFor = async (runId: string, kind: string) => {
      const [command] = await sql<{ id: string; target: { remoteMessageRefId: string; expectedRemoteState: Record<string, unknown> } }[]>`
        SELECT id, target FROM mail.commands WHERE correlation_id = ${runId} AND kind = ${kind}
      `;
      if (!command) throw new Error(`Missing ${kind} command`);
      return command;
    };
    let flags: string[] = [];
    let moved = false;
    const state = () => ({
      exists: !moved,
      flags,
      keywords: [],
      messageId: `<retry-read-move-${suffix}@external.test>`,
      modseq: flags.length ? "2" : "1",
    });
    const getState = spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async () => state());
    const getStates = spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(
      async (_config, messages) => new Map(moved ? [] : messages.uids.map((uid) => [uid, state()] as const)),
    );
    const change = spyOn(imapSmtpConnector, "changeMessageState").mockImplementation(async (_config, _target, requested) => {
      flags = requested.addFlags;
      return state();
    });
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
      uidValidity: "1",
      uidNext: uid,
      highestModseq: null,
      messages: 0,
    });
    const moveMessages = spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (_config, messages) => {
      moved = true;
      return { completed: true, destinationUidValidity: "1", destinationUids: new Map(messages.uids.map((sourceUid) => [sourceUid, uid])) };
    });
    try {
      await startIncomingAutomationBackfillRuntime();
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      const firstRun = await runFor();
      expect(await runMailWorkflow(firstRun)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      const read = await commandFor(firstRun, "change_message_state");
      expect(await executeMutationCommand(read.id)).toBe("confirmed");
      const [confirmed] = await sql<{ modseq: string }[]>`
        SELECT modseq::text FROM mail.remote_message_refs WHERE id = ${read.target.remoteMessageRefId}::uuid
      `;
      expect(confirmed?.modseq).toBe("2");
      expect(change).toHaveBeenCalledTimes(1);
      expect(await runMailWorkflow(firstRun)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      const failedMove = await commandFor(firstRun, "move");
      expect(failedMove.target.expectedRemoteState).toEqual({ flags: ["seen"], keywords: [] });
      // A definite provider rejection leaves the message in the Inbox.
      await sql`UPDATE mail.commands SET state = 'failed', last_error_code = 'REMOTE_MOVE_FAILED',
        last_error_message = 'Provider refused the move', finished_at = now() WHERE id = ${failedMove.id}::uuid`;
      await wakeWorkflowRunsWaitingOn({ appId: "mail", kind: "mail.command", key: failedMove.id });
      expect(await runMailWorkflow(firstRun)).toMatchObject({ state: "finished", result: { state: "failed" } });
      const [source] = await sql<
        { stale_at: Date | null }[]
      >`SELECT stale_at FROM mail.remote_message_refs WHERE id = ${read.target.remoteMessageRefId}::uuid`;
      expect(source?.stale_at).toBeNull();
      const retry = () =>
        runBackfillUntilSettled(
          {
            context: ownerContext,
            mailboxId,
            automationId: automation.data.id,
            input: { operationId: crypto.randomUUID(), expectedRevision: automation.data.revision, retryFailed: true },
          },
          10_000,
        );
      expect(await retry()).toMatchObject({ state: "completed", candidateCount: 1, newlyAcceptedCount: 1 });
      await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
      const retryRun = await runFor();
      expect(retryRun).not.toBe(firstRun);
      expect(await runMailWorkflow(retryRun)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      expect(
        await sql<{ id: string }[]>`SELECT id FROM mail.commands WHERE correlation_id = ${retryRun} AND kind = 'change_message_state'`,
      ).toEqual([]);
      const [readStep] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${retryRun}::uuid AND outcome #>> '{outcome,output,action}' = 'addFlag'
      `;
      expect(readStep?.output).toEqual({ action: "addFlag", applied: false });
      const move = await commandFor(retryRun, "move");
      expect(move.target.expectedRemoteState).toEqual({ modseq: "2", flags: ["seen"], keywords: [] });
      expect(await executeMutationCommand(move.id)).toBe("confirmed");
      expect(moveMessages).toHaveBeenCalledTimes(1);
      expect(await runMailWorkflow(retryRun)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      // Even a failed latest run cannot retry a stale source reference after placement.
      await sql`UPDATE workflows.run SET state = 'failed', finished_at = now() WHERE id = ${retryRun}::uuid`;
      expect(await retry()).toMatchObject({ state: "completed", candidateCount: 0, newlyAcceptedCount: 0 });
    } finally {
      moveMessages.mockRestore();
      status.mockRestore();
      change.mockRestore();
      getStates.mockRestore();
      getState.mockRestore();
      await stopIncomingAutomationBackfillRuntime();
      await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: automation.data.id,
        input: { expectedRevision: automation.data.revision },
      });
    }
  }, 30_000);

  test("keeps a move whose provider command outlasts the dependency recheck and reports it applied", async () => {
    const [archive] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid
    `;
    if (!archive) throw new Error("Failed to load the archive folder public id");
    const sender = `recheck-${suffix}@external.test`;
    const automation = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: `Recheck move ${suffix}`,
        enabled: true,
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: sender }] },
        },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: archive.short_id } }],
      },
    });
    if (!automation.ok) throw new Error(automation.error.message);
    // Apart from the UIDs of the other tests in this folder: a reused UID is the same message.
    const uid = 9800 + Math.floor(Math.random() * 200);
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: {
        remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: String(uid) },
        providerMessageId: `recheck-${suffix}`,
        providerThreadId: null,
        messageId: `<recheck-${suffix}@external.test>`,
        inReplyTo: null,
        references: [],
        subject: "Recheck move",
        sentAt: new Date(),
        internalDate: new Date(),
        sizeBytes: 128,
        flags: [],
        labels: [],
        addresses: {
          from: [{ name: "Bot", address: sender }],
          replyTo: [],
          to: [{ name: "Support", address: "automation@example.test" }],
          cc: [],
          bcc: [],
        },
        mimeStructure: {},
      } as never,
      captureWorkflowTriggers: true,
    });
    await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
    const [run] = await sql<{ id: string }[]>`
      SELECT id FROM workflows.run WHERE workflow_id = ${automation.data.workflowId}::uuid ORDER BY created_at DESC LIMIT 1
    `;
    if (!run) throw new Error("Automation run was not dispatched");
    // Every enabled automation gets a run for the message. Settle the others
    // first, as the worker would, so this one has the placement turn.
    const others = await sql<{ id: string }[]>`
      SELECT id FROM workflows.run WHERE scope_id = ${mailboxId} AND state = 'queued' AND id <> ${run.id}::uuid
    `;
    for (const other of others) await runMailWorkflow(other.id);
    const snapshot = async () => {
      const [current] = await sql<{ state: string; execution_generation: string | number; error: unknown }[]>`
        SELECT state, execution_generation, error FROM workflows.run WHERE id = ${run.id}::uuid
      `;
      const commands = await sql<{ id: string; kind: string; state: string; ref: string }[]>`
        SELECT id, kind, state, target ->> 'remoteMessageRefId' AS ref
        FROM mail.commands
        WHERE correlation_id = ${run.id}
      `;
      return { run: current, commands };
    };

    // The move parks on its provider command with a recheck deadline.
    expect((await runMailWorkflow(run.id)).state).toBe("finished");
    const parked = await snapshot();
    expect(parked.run?.state).toBe("waiting");
    expect(parked.commands).toEqual([{ id: expect.any(String), kind: "move", state: "queued", ref: expect.any(String) }]);

    // The provider stays busy past the deadline. The recheck runs the move
    // again, and the move waits for the command it already issued.
    await sql`UPDATE workflows.run SET wake_at = now() - interval '1 second' WHERE id = ${run.id}::uuid`;
    expect(await wakeExpiredWorkflowRuns(100, { appId: "mail" })).toContain(run.id);
    expect((await runMailWorkflow(run.id)).state).toBe("finished");
    const rechecked = await snapshot();
    expect(rechecked.run).toMatchObject({ state: "waiting", error: null });
    expect(Number(rechecked.run?.execution_generation)).toBeGreaterThan(Number(parked.run?.execution_generation));
    expect(rechecked.commands).toEqual(parked.commands);

    const [move] = parked.commands;
    if (!move) throw new Error("The move command was not created");

    // The provider moves the message, and Mail records it in the archive the
    // way the command runtime does: the inbox reference goes stale.
    const [archived] = await sql<{ id: string }[]>`
      WITH source AS (
        UPDATE mail.remote_message_refs
        SET stale_at = now()
        WHERE id = ${move.ref}::uuid
        RETURNING message_id
      ), placement AS (
        UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${move.ref}::uuid
      )
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      SELECT ${archiveFolderId}::uuid, message_id, 1, ${uid} FROM source
      RETURNING id
    `;
    if (!archived) throw new Error("Failed to record the moved message");
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id)
      SELECT id, folder_id, message_id FROM mail.remote_message_refs WHERE id = ${archived.id}::uuid
    `;
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${move.id}::uuid`;
    expect(await wakeWorkflowRunsWaitingOn({ appId: "mail", kind: "mail.command", key: move.id })).toContain(run.id);

    // The resumed move takes its own confirmed command, although the message
    // has left the folder the step found it in, and the run finishes with one
    // move spent.
    expect((await runMailWorkflow(run.id)).state).toBe("finished");
    const [finished] = await sql<{ state: string; effects_used: Record<string, number> | string }[]>`
      SELECT state, effects_used FROM workflows.run WHERE id = ${run.id}::uuid
    `;
    expect(finished?.state).toBe("succeeded");
    const used = typeof finished?.effects_used === "string" ? JSON.parse(finished.effects_used) : finished?.effects_used;
    expect(used?.maxMoves).toBe(1);
    expect((await snapshot()).commands).toEqual([{ ...move, state: "confirmed" }]);
    const [moveStep] = await sql<{ outcome: { outcome?: { output?: Record<string, unknown> } } | string }[]>`
      SELECT outcome FROM workflows.step_outcome
      WHERE run_id = ${run.id}::uuid AND state = 'completed' AND outcome #>> '{outcome,output,action}' = 'moveMessage'
    `;
    const moveOutcome = typeof moveStep?.outcome === "string" ? JSON.parse(moveStep.outcome) : moveStep?.outcome;
    expect(moveOutcome?.outcome?.output).toMatchObject({ action: "moveMessage", applied: true });

    const [current] = await sql<{ revision: string | number }[]>`
      SELECT revision FROM mail.incoming_automations WHERE id = ${automation.data.id}::uuid
    `;
    await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: automation.data.id,
      input: { expectedRevision: Number(current!.revision) },
    });
  });

  test("orders automations created within the same millisecond by their microseconds", async () => {
    const [archive] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid
    `;
    if (!archive) throw new Error("Failed to load the archive folder public id");
    const sender = `microsecond-${suffix}@external.test`;
    const scope = {
      mode: "matching" as const,
      conditions: { mode: "all" as const, items: [{ field: "sender_address" as const, operator: "is" as const, value: sender }] },
    };
    const create = async (name: string, action: { kind: "move_to_folder"; folderId: string } | { kind: "junk" }) => {
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: { name, enabled: true, scope, steps: [{ id: crypto.randomUUID(), kind: "mail_action", action }] },
      });
      if (!created.ok) throw new Error(created.error.message);
      return created.data;
    };
    const older = await create(`Microsecond move ${suffix}`, { kind: "move_to_folder", folderId: archive.short_id });
    const newer = await create(`Microsecond junk ${suffix}`, { kind: "junk" });
    // One millisecond, two microseconds: a JavaScript Date cannot tell them apart.
    await sql`
      UPDATE mail.incoming_automations
      SET created_at = CASE id
        WHEN ${older.id}::uuid THEN '2026-01-01T00:00:00.000100Z'::timestamptz
        ELSE '2026-01-01T00:00:00.000900Z'::timestamptz
      END
      WHERE id IN (${older.id}::uuid, ${newer.id}::uuid)
    `;

    // A UID no other test in this folder uses: a reused UID is the same message and triggers nothing.
    const uid = 32_000;
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: {
        remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: String(uid) },
        providerMessageId: `microsecond-${suffix}`,
        providerThreadId: null,
        messageId: `<microsecond-${suffix}@external.test>`,
        inReplyTo: null,
        references: [],
        subject: "Microsecond automations",
        sentAt: new Date(),
        internalDate: new Date(),
        sizeBytes: 128,
        flags: [],
        labels: [],
        addresses: {
          from: [{ name: "Boss", address: sender }],
          replyTo: [],
          to: [{ name: "Support", address: "automation@example.test" }],
          cc: [],
          bcc: [],
        },
        mimeStructure: {},
      } as never,
      captureWorkflowTriggers: true,
    });
    await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
    const runFor = async (workflowId: string): Promise<{ id: string; message_id: string }> => {
      const [row] = await sql<{ id: string; message_id: string }[]>`
        SELECT run.id, run.context #>> '{preconditions,message,id}' AS message_id
        FROM workflows.run run
        WHERE run.workflow_id = ${workflowId}::uuid
        ORDER BY run.created_at DESC
        LIMIT 1
      `;
      if (!row) throw new Error("Automation run was not dispatched");
      return row;
    };
    const olderRun = await runFor(older.workflowId);
    const newerRun = await runFor(newer.workflowId);
    const turnFor = (run: { id: string; message_id: string }) =>
      resolveIncomingAutomationPlacementTurn({ db: sql, runId: run.id, mailboxId, messageId: run.message_id, folderId: inboxFolderId });

    // Neither run has moved the message yet, so only the automation order decides.
    expect(await turnFor(olderRun)).toEqual({ state: "ready" });
    expect(await turnFor(newerRun)).toEqual({ state: "skip", reason: "earlier_automation" });

    for (const automation of [newer, older]) {
      const [current] = await sql<{ revision: string | number }[]>`
        SELECT revision FROM mail.incoming_automations WHERE id = ${automation.id}::uuid
      `;
      await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: automation.id,
        input: { expectedRevision: Number(current!.revision) },
      });
    }
  });

  test("names catalog destination folders by their path through non-selectable containers", async () => {
    const [binding] = await sql<{ id: string }[]>`
      SELECT id FROM mail.provider_bindings WHERE remote_resource_id = ${remoteResourceId}::uuid
    `;
    if (!binding) throw new Error("Missing incoming automation provider binding");
    const folder = async (key: string, name: string, parentId: string | null, selectable = true) => {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status, parent_id, selectable)
        VALUES (
          ${newShortId()}, ${remoteResourceId}::uuid, ${`incoming-automation-${key}-${suffix}`}, ${name}, 'other', 'current',
          ${parentId}::uuid, ${selectable}
        )
        RETURNING id
      `;
      if (!row) throw new Error(`Failed to create folder ${key}`);
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (
          ${binding.id}::uuid, ${row.id}::uuid, ${`${key}-${suffix}`}, 1, 1,
          ${selectable ? "{read,insert,move}" : "{read}"}::text[], now()
        )
      `;
      return row.id;
    };
    const projects = await folder("projects", "Projects", null, false);
    const year = await folder("projects-2025", "2025", projects);
    await folder("projects-2025-archive", "Archive", year);

    const catalog = snapshotMailWorkflowCatalog(await loadMailWorkflowCatalog({ context: ownerContext, mailboxId }));
    const archives = catalog.folders.filter((entry) => entry.name === "Archive").map((entry) => entry.path);
    expect(archives.sort()).toEqual(["Archive", "Projects / 2025 / Archive"]);
    expect(catalog.folders.some((entry) => entry.name === "Projects")).toBe(false);

    // The HTTP catalog serves the same public IDs instead of failing with 500.
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const api = new Hono<MailApiContext>()
      .use(async (c, next) => {
        c.set("actor", ownerContext.actor);
        c.set("accessSubject", ownerContext.accessSubject);
        c.set("internalMailboxId", mailboxId);
        await next();
      })
      .route("/", incomingAutomationRoutes);
    const response = await api.request(`/mailboxes/${mailboxRow!.short_id}/incoming-automations/catalog`);
    expect(response.status).toBe(200);
    const served = (await response.json()) as typeof catalog;
    expect(served.folders).toEqual(catalog.folders);
    expect(served.folders.find((entry) => entry.path === "Projects / 2025 / Archive")?.id).toMatch(/^[A-Za-z0-9_-]{6,}$/);
  });

  test("creates guided move_to_folder automations over HTTP for real folder names and IDs", async () => {
    const [binding] = await sql<{ id: string }[]>`
      SELECT id FROM mail.provider_bindings WHERE remote_resource_id = ${remoteResourceId}::uuid
    `;
    if (!binding) throw new Error("Missing incoming automation provider binding");
    const folder = async (key: string, name: string) => {
      const [row] = await sql<{ id: string; short_id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${remoteResourceId}::uuid, ${`incoming-automation-${key}-${suffix}`}, ${name}, 'other', 'current')
        RETURNING id, short_id
      `;
      if (!row) throw new Error(`Failed to create folder ${key}`);
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (${binding.id}::uuid, ${row.id}::uuid, ${`${key}-${suffix}`}, 1, 1, '{read,insert,move}'::text[], now())
      `;
      return row.short_id;
    };
    const it = await folder("it", "IT & Entwicklung");
    const newsletter = await folder("newsletter", "Newsletter");
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const api = new Hono<MailApiContext>()
      .use(async (c, next) => {
        c.set("actor", ownerContext.actor);
        c.set("accessSubject", ownerContext.accessSubject);
        c.set("internalMailboxId", mailboxId);
        await next();
      })
      .route("/", incomingAutomationRoutes);
    const create = (name: string, folderId: string) =>
      api.request(`/mailboxes/${mailboxRow!.short_id}/incoming-automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          scope: {
            mode: "matching",
            conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: `news-${suffix}@example.org` }] },
          },
          steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId } }],
        }),
      });
    const folderOf = async (response: Response) => {
      const body = (await response.json()) as { message?: string; steps?: Array<{ action: { folderId: string } }> };
      expect({ status: response.status, message: body.message }).toEqual({ status: 200, message: undefined });
      return body.steps?.[0]?.action.folderId;
    };

    expect(await folderOf(await create(`Move by ID ${suffix}`, it))).toBe(it);
    // An exact folder name resolves like the canonical moveMessage action and is stored as the public ID.
    expect(await folderOf(await create(`Move by name ${suffix}`, "Newsletter"))).toBe(newsletter);

    const unknown = await create(`Move unknown ${suffix}`, "No such folder");
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as { message: string }).message).toBe(
      'Invalid incoming automation definition: steps.0.action.folderId: Unknown or inaccessible folder "No such folder".',
    );
  });

  test("creates guided add_local_tag and create_reply_draft automations over HTTP for real tag and sender identity IDs", async () => {
    // Real public IDs are mixed-case; the reported failure only hit IDs that are not uppercase-only.
    let tagId = newShortId();
    while (!/[a-z]/.test(tagId) || !/[A-Z]/.test(tagId)) tagId = newShortId();
    const tagName = `Triage ${suffix}`;
    await sql`
      INSERT INTO mail.local_tags (short_id, mailbox_id, name, normalized_name, created_by_actor_kind, created_by_actor_id)
      VALUES (${tagId}, ${mailboxId}::uuid, ${tagName}, ${tagName.toLowerCase()}, 'user', ${userIds[0]}::uuid)
    `;
    const senderIdentityId = newShortId();
    await sql`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, from_address, label, status, automation_policy)
      VALUES (${senderIdentityId}, ${mailboxId}::uuid, ${`replies-${suffix}@example.org`}, 'Replies', 'verified', 'mailbox')
    `;
    const [mailboxRow] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    const api = new Hono<MailApiContext>()
      .use(async (c, next) => {
        c.set("actor", ownerContext.actor);
        c.set("accessSubject", ownerContext.accessSubject);
        c.set("internalMailboxId", mailboxId);
        await next();
      })
      .route("/", incomingAutomationRoutes);
    const create = (name: string, steps: unknown[]) =>
      api.request(`/mailboxes/${mailboxRow!.short_id}/incoming-automations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          scope: {
            mode: "matching",
            conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: `triage-${suffix}@example.org` }] },
          },
          steps,
        }),
      });
    const classified = (tag: string) => {
      const classifierId = crypto.randomUUID();
      return [
        {
          id: classifierId,
          kind: "ai_classify",
          instructions: "Choose a category",
          choices: [
            { name: "Important", description: "Needs attention" },
            { name: "Routine", description: "Routine mail" },
          ],
        },
        {
          id: crypto.randomUUID(),
          kind: "if",
          condition: { sourceStepId: classifierId, operator: "equals", value: "Important" },
          then: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "add_local_tag", tagId: tag } }],
          else: [],
        },
      ];
    };
    type Created = { message?: string; steps?: Array<{ then?: Array<{ action: { tagId: string } }>; senderIdentityId?: string }> };
    const created = async (response: Response) => {
      const body = (await response.json()) as Created;
      expect({ status: response.status, message: body.message }).toEqual({ status: 200, message: undefined });
      return body;
    };

    expect((await created(await create(`Tag by ID ${suffix}`, classified(tagId)))).steps?.[1]?.then?.[0]?.action.tagId).toBe(tagId);
    // An exact tag name resolves like the canonical addLocalTag action and is stored as the public ID.
    expect((await created(await create(`Tag by name ${suffix}`, classified(tagName)))).steps?.[1]?.then?.[0]?.action.tagId).toBe(tagId);

    const rejected = async (response: Response) => {
      expect(response.status).toBe(400);
      return ((await response.json()) as { message: string }).message;
    };
    expect(await rejected(await create(`Tag unknown ${suffix}`, classified("No such tag")))).toBe(
      'Invalid incoming automation definition: steps.1.then.0.action.tagId: Unknown local tag "No such tag".',
    );
    // A name and an ID of the same tag on one path are the same tag once resolved.
    const tagTwice = [
      { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "add_local_tag", tagId: tagName } },
      { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "add_local_tag", tagId } },
    ];
    expect(await rejected(await create(`Tag twice ${suffix}`, tagTwice))).toBe(
      "Invalid incoming automation definition: steps.1.action: One reachable path cannot add the same tag twice",
    );

    // Marking read changes the provider message; setting the status is a separate, local slot on the same path.
    await created(
      await create(`Read and status ${suffix}`, [
        { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } },
        { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "set_status", status: "done" } },
      ]),
    );

    const draft = await created(
      await create(`Reply draft ${suffix}`, [
        { id: crypto.randomUUID(), kind: "create_reply_draft", senderIdentityId, body: { kind: "custom", value: "Thanks, we are on it." } },
      ]),
    );
    expect(draft.steps?.[0]?.senderIdentityId).toBe(senderIdentityId);
  });

  const statusEnvelope = (uid: number, key: string, inReplyTo: string | null = null, senderKey = key): ConnectorEnvelope => ({
    remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: "1" },
    providerMessageId: `status-${key}-${uid}-${suffix}`,
    providerThreadId: null,
    messageId: `<status-${key}-${uid}-${suffix}@external.test>`,
    inReplyTo,
    references: inReplyTo ? [inReplyTo] : [],
    subject: `Status hydration ${key}`,
    sentAt: new Date(inReplyTo ? "2026-10-01T08:01:00.000Z" : "2026-10-01T08:00:00.000Z"),
    internalDate: new Date(inReplyTo ? "2026-10-01T08:01:00.000Z" : "2026-10-01T08:00:00.000Z"),
    sizeBytes: 256,
    flags: [],
    labels: [],
    addresses: {
      from: [{ name: "Sender", address: `status-${senderKey}-${suffix}@external.test` }],
      replyTo: [],
      to: [{ name: "Support", address: "automation@example.test" }],
      cc: [],
      bcc: [],
    },
    mimeStructure: {},
  });

  const hydrateStatusMessage = async (messageId: string, envelope: ConnectorEnvelope) => {
    const source = Buffer.from(
      [
        `Message-ID: ${envelope.messageId}`,
        `From: ${envelope.addresses.from[0]!.address}`,
        `To: ${envelope.addresses.to[0]!.address}`,
        `Subject: ${envelope.subject}`,
        ...(envelope.inReplyTo ? [`In-Reply-To: ${envelope.inReplyTo}`] : []),
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Status hydration test body",
      ].join("\r\n"),
    );
    await hydrateMessageFromSource({ messageId, source: Readable.from([source]), expectedSize: source.byteLength });
  };

  const statusConversation = async (messageId: string) => {
    const [conversation] = await sql<{ id: string; revision: number; work_status: string; snoozed_until: Date | string | null }[]>`
      SELECT conversation.id, conversation.revision::int AS revision, conversation.work_status, conversation.snoozed_until
      FROM mail.conversation_messages link
      JOIN mail.conversations conversation ON conversation.id = link.conversation_id
      WHERE link.message_id = ${messageId}::uuid
    `;
    if (!conversation) throw new Error("Status message was not linked to a conversation");
    return conversation;
  };

  const reconciledStatusActivities = (messageId: string) => sql<{ id: string }[]>`
    SELECT id FROM mail.activity_events
    WHERE mailbox_id = ${mailboxId}::uuid
      AND action = 'conversation.work_state_changed' AND outcome = 'reconciled'
      AND metadata ->> 'messageId' = ${messageId}
  `;

  const markStatusConversationDone = async (messageId: string) => {
    const conversation = await statusConversation(messageId);
    const updated = await updateConversationCollaboration({
      context: ownerContext,
      mailboxId,
      conversationId: conversation.id,
      locale: "en",
      input: { expectedRevision: conversation.revision, completion: "done" },
    });
    if (!updated.ok) throw new Error(updated.error.message);
    expect(updated.data.workStatus).toBe("done");
  };

  const createStatusAutomation = async (key: string, archiveId?: string, status: "needs_action" | "waiting" | "done" = "done") => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: `Status hydration ${key} ${suffix}`,
        enabled: true,
        scope: {
          mode: "matching",
          conditions: { mode: "all", items: [{ field: "sender_address", operator: "is", value: `status-${key}-${suffix}@external.test` }] },
        },
        steps: [
          { id: crypto.randomUUID(), kind: "mail_action", action: { kind: "set_status", status } },
          ...(archiveId
            ? [{ id: crypto.randomUUID(), kind: "mail_action" as const, action: { kind: "move_to_folder" as const, folderId: archiveId } }]
            : []),
        ],
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.data;
  };

  const dispatchStatusRun = async (workflowId: string) => {
    await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
    const [run] = await sql<{ id: string }[]>`
      SELECT id FROM workflows.run WHERE workflow_id = ${workflowId}::uuid ORDER BY created_at DESC LIMIT 1
    `;
    if (!run) throw new Error("Status automation run was not dispatched");
    return run.id;
  };

  const deleteStatusAutomation = async (automationId: string) => {
    const [current] = await sql<{ revision: number }[]>`
      SELECT revision::int AS revision FROM mail.incoming_automations WHERE id = ${automationId}::uuid
    `;
    if (!current) throw new Error("Status automation was not found for cleanup");
    const deleted = await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId,
      input: { expectedRevision: current.revision },
    });
    if (!deleted.ok) throw new Error(deleted.error.message);
  };

  // #1142: a workflow status decision covers only its triggering message, even before hydration.
  test("does not cover a reply that joined before the automation's status step", async () => {
    const automation = await createStatusAutomation("joined-before-status");
    try {
      const first = statusEnvelope(13001, "joined-before-status");
      const firstId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: first,
        captureWorkflowTriggers: true,
      });
      const second = statusEnvelope(13002, "joined-before-status", first.messageId, "other-sender");
      const secondId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: second,
        captureWorkflowTriggers: false,
      });
      expect((await statusConversation(secondId)).id).toBe((await statusConversation(firstId)).id);
      const runId = await dispatchStatusRun(automation.workflowId);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      expect((await statusConversation(firstId)).work_status).toBe("done");
      await hydrateStatusMessage(firstId, first);
      expect((await statusConversation(firstId)).work_status).toBe("done");
      expect(await reconciledStatusActivities(firstId)).toEqual([]);
      await hydrateStatusMessage(secondId, second);
      expect((await statusConversation(secondId)).work_status).toBe("needs_action");
      expect(await reconciledStatusActivities(secondId)).toHaveLength(1);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("clears a snooze for new mail when an automation's needs_action is a no-op", async () => {
    const first = statusEnvelope(13011, "needs-action-noop");
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: first,
      captureWorkflowTriggers: false,
    });
    await hydrateStatusMessage(firstId, first);
    const conversation = await statusConversation(firstId);
    const futureSnooze = new Date(Date.now() + 60 * 60_000).toISOString();
    const snoozed = await updateConversationCollaboration({
      context: ownerContext,
      mailboxId,
      conversationId: conversation.id,
      locale: "en",
      input: { expectedRevision: conversation.revision, snoozedUntil: futureSnooze },
    });
    if (!snoozed.ok) throw new Error(snoozed.error.message);
    expect(snoozed.data.snoozedUntil).toBe(futureSnooze);
    const automation = await createStatusAutomation("needs-action-noop", undefined, "needs_action");
    try {
      const reply = statusEnvelope(13012, "needs-action-noop", first.messageId);
      const replyId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: reply,
        captureWorkflowTriggers: true,
      });
      expect((await statusConversation(replyId)).id).toBe(conversation.id);
      const runId = await dispatchStatusRun(automation.workflowId);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      const [step] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND outcome #>> '{outcome,output,action}' = 'setConversationStatus'
      `;
      expect(step?.output).toMatchObject({ action: "setConversationStatus", applied: false });
      await hydrateStatusMessage(replyId, reply);
      expect(await statusConversation(replyId)).toMatchObject({ work_status: "needs_action", snoozed_until: null });
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("keeps Done from an incoming automation when Mail hydrates the triggering message", async () => {
    const [archive] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid`;
    if (!archive) throw new Error("Archive folder was not found");
    const automation = await createStatusAutomation("done-move", archive.short_id);
    try {
      const envelope = statusEnvelope(12001, "done-move");
      const messageId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: envelope,
        captureWorkflowTriggers: true,
      });
      const runId = await dispatchStatusRun(automation.workflowId);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      const [command] = await sql<{ id: string }[]>`
        SELECT id FROM mail.commands WHERE correlation_id = ${runId} AND kind = 'move'
      `;
      if (!command) throw new Error("Status automation did not queue its move");
      let moved = false;
      const state = () => ({ exists: !moved, flags: [], keywords: [], messageId: envelope.messageId, modseq: "1" });
      const getState = spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async () => state());
      const getStates = spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(
        async (_config, messages) => new Map(moved ? [] : messages.uids.map((uid) => [uid, state()] as const)),
      );
      const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
        uidValidity: "1",
        uidNext: 12002,
        highestModseq: null,
        messages: 0,
      });
      const move = spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (_config, messages) => {
        moved = true;
        return { completed: true, destinationUidValidity: "1", destinationUids: new Map(messages.uids.map((uid) => [uid, 12001])) };
      });
      try {
        expect(await executeMutationCommand(command.id)).toBe("confirmed");
        expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
        expect(move).toHaveBeenCalledTimes(1);
      } finally {
        move.mockRestore();
        status.mockRestore();
        getStates.mockRestore();
        getState.mockRestore();
      }
      expect((await statusConversation(messageId)).work_status).toBe("done");
      await hydrateStatusMessage(messageId, envelope);
      expect((await statusConversation(messageId)).work_status).toBe("done");
      expect(await reconciledStatusActivities(messageId)).toEqual([]);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("keeps an already Done conversation Done when an automation's set_status done is a no-op", async () => {
    const first = statusEnvelope(12011, "done-noop");
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: first,
      captureWorkflowTriggers: false,
    });
    await hydrateStatusMessage(firstId, first);
    await markStatusConversationDone(firstId);
    const automation = await createStatusAutomation("done-noop");
    try {
      const second = statusEnvelope(12012, "done-noop", first.messageId);
      const secondId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: second,
        captureWorkflowTriggers: true,
      });
      expect((await statusConversation(secondId)).id).toBe((await statusConversation(firstId)).id);
      const runId = await dispatchStatusRun(automation.workflowId);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      const [step] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND outcome #>> '{outcome,output,action}' = 'setConversationStatus'
      `;
      expect(step?.output).toMatchObject({ action: "setConversationStatus", applied: false });
      expect((await statusConversation(secondId)).work_status).toBe("done");
      await hydrateStatusMessage(secondId, second);
      expect((await statusConversation(secondId)).work_status).toBe("done");
      expect(await reconciledStatusActivities(secondId)).toEqual([]);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("keeps Done for the triggering message when another change moved the revision before a no-op status step", async () => {
    const first = statusEnvelope(13031, "done-noop-revision");
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: first,
      captureWorkflowTriggers: false,
    });
    await hydrateStatusMessage(firstId, first);
    await markStatusConversationDone(firstId);
    const automation = await createStatusAutomation("done-noop-revision");
    try {
      const reply = statusEnvelope(13032, "done-noop-revision", first.messageId);
      const replyId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: reply,
        captureWorkflowTriggers: true,
      });
      expect((await statusConversation(replyId)).id).toBe((await statusConversation(firstId)).id);
      const runId = await dispatchStatusRun(automation.workflowId);
      const conversation = await statusConversation(replyId);
      if (ownerContext.actor.kind !== "user") throw new Error("Expected a user actor for the mailbox owner");
      const assigned = await updateConversationCollaboration({
        context: ownerContext,
        mailboxId,
        conversationId: conversation.id,
        locale: "en",
        input: { expectedRevision: conversation.revision, assigneeUserIds: [ownerContext.actor.user.id] },
      });
      if (!assigned.ok) throw new Error(assigned.error.message);
      expect((await statusConversation(replyId)).revision).toBeGreaterThan(conversation.revision);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      const [run] = await sql<{ state: string }[]>`
        SELECT state FROM workflows.run WHERE id = ${runId}::uuid
      `;
      expect(run?.state).toBe("succeeded");
      const [step] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND outcome #>> '{outcome,output,action}' = 'setConversationStatus'
      `;
      expect(step?.output).toEqual({ action: "setConversationStatus", applied: false });
      await hydrateStatusMessage(replyId, reply);
      expect((await statusConversation(replyId)).work_status).toBe("done");
      expect(await reconciledStatusActivities(replyId)).toEqual([]);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("does not let a stale status step override a newer decision that released the triggering message", async () => {
    const key = "waiting-noop-released";
    const first = statusEnvelope(13041, key);
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: first,
      captureWorkflowTriggers: false,
    });
    await hydrateStatusMessage(firstId, first);
    const conversation = await statusConversation(firstId);
    expect(conversation.work_status).toBe("needs_action");
    await sql`
      UPDATE mail.conversations SET work_status = 'waiting', revision = revision + 1
      WHERE id = ${conversation.id}::uuid
    `;
    const automation = await createStatusAutomation(key, undefined, "waiting");
    try {
      const reply = statusEnvelope(13042, key, first.messageId);
      const replyId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: reply,
        captureWorkflowTriggers: true,
      });
      expect((await statusConversation(replyId)).id).toBe(conversation.id);
      const runId = await dispatchStatusRun(automation.workflowId);
      const current = await statusConversation(replyId);
      const snoozed = await updateConversationCollaboration({
        context: ownerContext,
        mailboxId,
        conversationId: conversation.id,
        locale: "en",
        input: { expectedRevision: current.revision, snoozedUntil: new Date(Date.now() + 60 * 60_000).toISOString() },
      });
      if (!snoozed.ok) throw new Error(snoozed.error.message);
      const released = await updateConversationCollaboration({
        context: ownerContext,
        mailboxId,
        conversationId: conversation.id,
        locale: "en",
        input: { expectedRevision: snoozed.data.revision, snoozedUntil: null },
      });
      if (!released.ok) throw new Error(released.error.message);
      expect(released.data).toMatchObject({ workStatus: "waiting", snoozedUntil: null });
      expect(released.data.revision).toBeGreaterThan(current.revision);
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      const [run] = await sql<{ state: string }[]>`
        SELECT state FROM workflows.run WHERE id = ${runId}::uuid
      `;
      expect(run?.state).toBe("succeeded");
      const [step] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND outcome #>> '{outcome,output,action}' = 'setConversationStatus'
      `;
      expect(step?.output).toEqual({ action: "setConversationStatus", applied: false });
      await hydrateStatusMessage(replyId, reply);
      expect(await statusConversation(replyId)).toMatchObject({ work_status: "needs_action", snoozed_until: null });
      expect(await reconciledStatusActivities(replyId)).toHaveLength(1);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  test("does not let a no-op release undo an automation's decision", async () => {
    const key = "waiting-noop-release";
    const first = statusEnvelope(13051, key);
    const firstId = await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: first,
      captureWorkflowTriggers: false,
    });
    await hydrateStatusMessage(firstId, first);
    const conversation = await statusConversation(firstId);
    expect(conversation.work_status).toBe("needs_action");
    await sql`
      UPDATE mail.conversations SET work_status = 'waiting', revision = revision + 1
      WHERE id = ${conversation.id}::uuid
    `;
    const automation = await createStatusAutomation(key, undefined, "waiting");
    try {
      const reply = statusEnvelope(13052, key, first.messageId);
      const replyId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: reply,
        captureWorkflowTriggers: true,
      });
      expect((await statusConversation(replyId)).id).toBe(conversation.id);
      const runId = await dispatchStatusRun(automation.workflowId);
      const current = await statusConversation(replyId);
      expect(current.snoozed_until).toBeNull();
      const released = await updateConversationCollaboration({
        context: ownerContext,
        mailboxId,
        conversationId: conversation.id,
        locale: "en",
        input: { expectedRevision: current.revision, snoozedUntil: null },
      });
      if (!released.ok) throw new Error(released.error.message);
      expect(released.data).toMatchObject({ workStatus: "waiting", snoozedUntil: null, revision: current.revision });
      expect((await statusConversation(replyId)).revision).toBe(current.revision);
      const [link] = await sql<{ status_covered: boolean | null }[]>`
        SELECT status_covered FROM mail.conversation_messages WHERE message_id = ${replyId}::uuid
      `;
      expect(link?.status_covered).toBeNull();
      expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      const [run] = await sql<{ state: string }[]>`
        SELECT state FROM workflows.run WHERE id = ${runId}::uuid
      `;
      expect(run?.state).toBe("succeeded");
      const [step] = await sql<{ output: Record<string, unknown> }[]>`
        SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
        WHERE run_id = ${runId}::uuid AND outcome #>> '{outcome,output,action}' = 'setConversationStatus'
      `;
      expect(step?.output).toMatchObject({ action: "setConversationStatus", applied: false, value: "waiting" });
      await hydrateStatusMessage(replyId, reply);
      expect(await statusConversation(replyId)).toMatchObject({ work_status: "waiting", snoozed_until: null });
      expect(await reconciledStatusActivities(replyId)).toEqual([]);
    } finally {
      await deleteStatusAutomation(automation.id);
    }
  }, 30_000);

  for (const initiallyDone of [false, true]) {
    test(`applies an automation's status after Mail hydrated its triggering message in a longer conversation${initiallyDone ? " that was Done" : ""}`, async () => {
      const key = initiallyDone ? "hydrated-first-done" : "hydrated-first-open";
      const uid = initiallyDone ? 12031 : 12021;
      const first = statusEnvelope(uid, key);
      const firstId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: first,
        captureWorkflowTriggers: false,
      });
      await hydrateStatusMessage(firstId, first);
      expect((await statusConversation(firstId)).work_status).toBe("needs_action");
      if (initiallyDone) await markStatusConversationDone(firstId);
      const automation = await createStatusAutomation(key);
      try {
        const second = statusEnvelope(uid + 1, key, first.messageId);
        const secondId = await ingestEnvelope({
          db: sql,
          mailboxId,
          remoteResourceId,
          folderId: inboxFolderId,
          message: second,
          captureWorkflowTriggers: true,
        });
        expect((await statusConversation(secondId)).id).toBe((await statusConversation(firstId)).id);
        const runId = await dispatchStatusRun(automation.workflowId);
        await hydrateStatusMessage(secondId, second);
        expect((await statusConversation(secondId)).work_status).toBe("needs_action");
        expect((await runMailWorkflow(runId)).state).toBe("finished");
        const [run] = await sql<{ state: string; error: string | null }[]>`
          SELECT state, error ->> 'message' AS error FROM workflows.run WHERE id = ${runId}::uuid
        `;
        expect(run).toEqual({ state: "succeeded", error: null });
        expect((await statusConversation(secondId)).work_status).toBe("done");
      } finally {
        await deleteStatusAutomation(automation.id);
      }
    }, 30_000);
  }

  for (const initiallyDone of [false, true]) {
    // A Done view must not turn into a silent no-op while the conversation is open again.
    test(`keeps the revision conflict when another message joined after the run's view${initiallyDone ? " of a Done conversation" : ""}`, async () => {
      const key = initiallyDone ? "hydrated-first-joined-done" : "hydrated-first-joined";
      const uid = initiallyDone ? 12051 : 12041;
      const first = statusEnvelope(uid, key);
      const firstId = await ingestEnvelope({
        db: sql,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: first,
        captureWorkflowTriggers: false,
      });
      await hydrateStatusMessage(firstId, first);
      if (initiallyDone) await markStatusConversationDone(firstId);
      const automation = await createStatusAutomation(key);
      try {
        const second = statusEnvelope(uid + 1, key, first.messageId);
        const secondId = await ingestEnvelope({
          db: sql,
          mailboxId,
          remoteResourceId,
          folderId: inboxFolderId,
          message: second,
          captureWorkflowTriggers: true,
        });
        const runId = await dispatchStatusRun(automation.workflowId);
        await hydrateStatusMessage(secondId, second);
        // A reply that joins after the run's view stays envelope-only, so it changes no revision.
        const third = statusEnvelope(uid + 2, key, second.messageId);
        const thirdId = await ingestEnvelope({
          db: sql,
          mailboxId,
          remoteResourceId,
          folderId: inboxFolderId,
          message: third,
          captureWorkflowTriggers: false,
        });
        expect((await statusConversation(thirdId)).id).toBe((await statusConversation(secondId)).id);
        expect((await runMailWorkflow(runId)).state).toBe("finished");
        const [run] = await sql<{ state: string; error: string | null }[]>`
        SELECT state, error ->> 'message' AS error FROM workflows.run WHERE id = ${runId}::uuid
      `;
        expect(run?.state).toBe("failed");
        expect(run?.error).toContain("changed by another collaborator");
        expect((await statusConversation(thirdId)).work_status).toBe("needs_action");
      } finally {
        await deleteStatusAutomation(automation.id);
      }
    }, 30_000);
  }
});
