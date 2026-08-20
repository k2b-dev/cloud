import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toPgUuidArray } from "@valentinkolb/cloud/services/postgres";
import {
  createWorkflowRun,
  deleteWorkflowScope,
  dispatchPendingWorkflowEvents,
  emitWorkflowEvent,
} from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { cancelPendingAutomaticRepliesInTransaction, prepareAutomaticReplyInTransaction } from "./automatic-reply";
import { listActivity } from "./collaboration";
import { getDraft, listConversationDrafts } from "./drafts";
import { createMailbox } from "./mailboxes";
import { EMPTY_MESSAGE_PROTOCOL_FACTS } from "./message-protocol";
import { ingestEnvelope } from "./sync-runtime";
import { getWorkflowSnapshot, type MailWorkflowTargetSnapshot, mailWorkflowEventContext } from "./workflow-data";
import {
  activateWorkflow,
  createWorkflow,
  createWorkflowVersion,
  deactivateWorkflow,
  restoreWorkflowVersion,
  updateWorkflowMetadata,
} from "./workflow-definition-service";
import { runMailWorkflow } from "./workflow-runtime";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;
const noEffectBudget = {
  maxTargets: 1,
  maxMoves: 0,
  maxCopies: 0,
  maxSends: 0,
  maxDrafts: 0,
  maxFlagChanges: 0,
  maxNotifications: 0,
  maxKeywordChanges: 0,
  maxCollaborationChanges: 0,
  maxAiCalls: 0,
};

suite("Mail shared workflow kernel", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let deniedUserId = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let remoteResourceId = "";
  let inboxFolderId = "";
  let copyFolderId = "";
  let senderIdentityId = "";
  let senderIdentityShortId = "";
  let context: MailRequestContext;
  let deniedContext: MailRequestContext;

  const envelope = (params: { uid: number; providerMessageId: string; from?: string; messageId?: string }) => ({
    remoteRef: {
      folderStableKey: `workflow-inbox-${suffix}`,
      uidValidity: "1",
      uid: String(params.uid),
      modseq: String(params.uid),
    },
    providerMessageId: params.providerMessageId,
    providerThreadId: null,
    messageId: params.messageId ?? `<workflow-${params.uid}-${suffix}@example.test>`,
    inReplyTo: null,
    references: [],
    subject: `Workflow message ${params.uid}`,
    sentAt: new Date(`2026-07-26T12:${String(params.uid % 60).padStart(2, "0")}:00.000Z`),
    internalDate: new Date(`2026-07-26T12:${String(params.uid % 60).padStart(2, "0")}:00.000Z`),
    sizeBytes: 128,
    flags: [],
    labels: [],
    addresses: {
      from: [{ name: "Customer", address: params.from ?? "customer@example.test" }],
      replyTo: [],
      to: [{ name: "Support", address: "support@example.test" }],
      cc: [],
      bcc: [],
    },
    mimeStructure: {},
  });

  beforeAll(async () => {
    await migrate();
    const [user] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-workflow-kernel-${suffix}`}, 'local', 'user', 'Mail workflow kernel', false)
      RETURNING id, uid
    `;
    if (!user) throw new Error("Failed to create Mail workflow test user");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid: user.uid,
          provider: "local",
          profile: "user",
          displayName: "Mail workflow kernel",
          givenName: "Mail",
          sn: "Workflow",
          mail: `${user.uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: user.id },
      requestId: `mail-workflow-kernel-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Workflow kernel ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [mailboxPublic] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid
    `;
    mailboxShortId = mailboxPublic!.short_id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"d".repeat(64)}, 'active')
      RETURNING id
    `;
    if (!resource) throw new Error("Failed to create Mail workflow remote resource");
    remoteResourceId = resource.id;
    const folders = await sql<{ id: string; stable_key: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES
        (${newShortId()}, ${remoteResourceId}::uuid, ${`workflow-inbox-${suffix}`}, 'Inbox', 'inbox', 'current'),
        (${newShortId()}, ${remoteResourceId}::uuid, ${`workflow-copy-${suffix}`}, 'Archive', 'archive', 'current')
      RETURNING id, stable_key
    `;
    inboxFolderId = folders.find((folder) => folder.stable_key === `workflow-inbox-${suffix}`)?.id ?? "";
    copyFolderId = folders.find((folder) => folder.stable_key === `workflow-copy-${suffix}`)?.id ?? "";
    if (!inboxFolderId || !copyFolderId) throw new Error("Failed to create Mail workflow folders");
    const [identity] = await sql<{ id: string; short_id: string }[]>`
      INSERT INTO mail.sender_identities (short_id, mailbox_id, label, display_name, from_address, is_default, status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Support', 'Support', 'support@example.test', true, 'verified')
      RETURNING id, short_id
    `;
    if (!identity) throw new Error("Failed to create Mail workflow sender identity");
    senderIdentityId = identity.id;
    senderIdentityShortId = identity.short_id;
    const [deniedUser] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-workflow-denied-${suffix}`}, 'local', 'user', 'Mail workflow denied', false)
      RETURNING id, uid
    `;
    if (!deniedUser) throw new Error("Failed to create unauthorized Mail workflow test user");
    deniedUserId = deniedUser.id;
    deniedContext = {
      actor: {
        kind: "user",
        user: {
          id: deniedUser.id,
          uid: deniedUser.uid,
          provider: "local",
          profile: "user",
          displayName: "Mail workflow denied",
          givenName: "Mail",
          sn: "Denied",
          mail: `${deniedUser.uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId: deniedUser.id },
      requestId: `mail-workflow-denied-${suffix}`,
    };
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        DELETE FROM mail.mailbox_access
        WHERE mailbox_id = ${mailboxId}::uuid
        RETURNING access_id
      `;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      if (access.length) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${access.map((row) => row.access_id)}::jsonb))
        `;
      }
    }
    await sql`DELETE FROM audit.events WHERE request_id IN (${context?.requestId}, ${deniedContext?.requestId})`;
    if (deniedUserId) await sql`DELETE FROM auth.users WHERE id = ${deniedUserId}::uuid`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  test("keeps definition changes optimistic, immutable, authorized, and fully audited", async () => {
    const originalSource = `# exact historical source
triggers:
  messageReceived:
    with: {}
steps:
  - succeed:
      message: Original
`;
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: "Lifecycle audit",
        description: "Initial",
        priority: 100,
        source: originalSource,
        effectBudget: {
          maxTargets: 1,
          maxMoves: 0,
          maxCopies: 0,
          maxSends: 0,
          maxDrafts: 0,
          maxFlagChanges: 0,
          maxNotifications: 0,
          maxKeywordChanges: 0,
          maxCollaborationChanges: 0,
          maxAiCalls: 0,
        },
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const originalVersion = created.data.currentVersion;

    const staleUpdate = await updateWorkflowMetadata({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedUpdatedAt: "2020-01-01T00:00:00.000Z", name: "Stale" },
    });
    expect(staleUpdate).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const updated = await updateWorkflowMetadata({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedUpdatedAt: created.data.updatedAt, name: "Lifecycle renamed", description: null, priority: 25 },
    });
    expect(updated).toMatchObject({
      ok: true,
      data: {
        name: "Lifecycle renamed",
        description: null,
        priority: 25,
        currentVersionId: originalVersion.id,
      },
    });
    if (!updated.ok) throw new Error(updated.error.message);

    const deniedActivation = await activateWorkflow({
      context: deniedContext,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: originalVersion.id },
    });
    expect(deniedActivation).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: originalVersion.id },
    });
    expect(activated).toMatchObject({ ok: true, data: { activeVersionId: originalVersion.id, enabled: true } });

    const deactivated = await deactivateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: originalVersion.id },
    });
    expect(deactivated).toMatchObject({ ok: true, data: { activeVersionId: originalVersion.id, enabled: false } });

    const replacementSource = `${originalSource}# replacement\n`;
    const versioned = await createWorkflowVersion({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { source: replacementSource, effectBudget: noEffectBudget },
    });
    if (!versioned.ok) throw new Error(versioned.error.message);

    const staleRestore = await restoreWorkflowVersion({
      context,
      mailboxId,
      workflowId: created.data.id,
      versionId: originalVersion.id,
      input: { expectedCurrentVersionId: originalVersion.id },
    });
    expect(staleRestore).toMatchObject({ ok: false, error: { code: "CONFLICT" } });

    const restored = await restoreWorkflowVersion({
      context,
      mailboxId,
      workflowId: created.data.id,
      versionId: originalVersion.id,
      input: { expectedCurrentVersionId: versioned.data.currentVersion.id },
    });
    expect(restored).toMatchObject({
      ok: true,
      data: {
        activeVersionId: originalVersion.id,
        enabled: false,
        currentVersion: { source: originalSource, sourceHash: originalVersion.sourceHash },
      },
    });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(restored.data.currentVersion.id).not.toBe(originalVersion.id);

    const auditRows = await sql<
      {
        action: string;
        outcome: string;
        actor_user_id: string | null;
        request_id: string | null;
        metadata: Record<string, unknown> | string;
      }[]
    >`
      SELECT action, outcome, actor_user_id::text, request_id, metadata
      FROM audit.events
      WHERE target_type = 'workflow'
        AND target_id = ${created.data.id}
        AND action IN (
          'mail.workflow.metadata.update',
          'mail.workflow.activate',
          'mail.workflow.deactivate',
          'mail.workflow.version.restore'
        )
      ORDER BY id
    `;
    expect(auditRows.map(({ action, outcome }) => ({ action, outcome }))).toEqual([
      { action: "mail.workflow.metadata.update", outcome: "failed" },
      { action: "mail.workflow.metadata.update", outcome: "allowed" },
      { action: "mail.workflow.activate", outcome: "denied" },
      { action: "mail.workflow.activate", outcome: "allowed" },
      { action: "mail.workflow.deactivate", outcome: "allowed" },
      { action: "mail.workflow.version.restore", outcome: "failed" },
      { action: "mail.workflow.version.restore", outcome: "allowed" },
    ]);
    for (const row of auditRows) {
      const metadata = typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata;
      expect(metadata).toMatchObject({ mailboxId });
      expect(row.request_id).toBe((row.actor_user_id === deniedUserId ? deniedContext.requestId : context.requestId) ?? null);
    }
    expect(
      auditRows
        .filter((row) => row.action === "mail.workflow.activate" || row.action === "mail.workflow.deactivate")
        .map((row) => (typeof row.metadata === "string" ? JSON.parse(row.metadata) : row.metadata)),
    ).toEqual([
      { mailboxId, versionId: originalVersion.id, sourceHash: null },
      { mailboxId, versionId: originalVersion.id, sourceHash: originalVersion.sourceHash },
      { mailboxId, versionId: originalVersion.id, sourceHash: originalVersion.sourceHash },
    ]);
  });

  test("emits only first-link incremental inbound events and converges duplicate delivery", async () => {
    const source = `triggers:
  messageReceived:
    with: {}
steps:
  - succeed:
      message: Inbound handled
`;
    const workflowIds: string[] = [];
    for (const name of ["Inbound alpha", "Inbound beta"]) {
      const created = await createWorkflow({
        context,
        mailboxId,
        input: { name: `${name} ${suffix}`, priority: 100, source, effectBudget: noEffectBudget },
      });
      if (!created.ok) throw new Error(created.error.message);
      const activated = await activateWorkflow({
        context,
        mailboxId,
        workflowId: created.data.id,
        input: { expectedVersionId: created.data.currentVersion.id },
      });
      if (!activated.ok) throw new Error(activated.error.message);
      workflowIds.push(created.data.id);
    }

    const inbound = envelope({ uid: 7001, providerMessageId: `workflow-inbound-${suffix}` });
    await expect(
      sql.begin(async (tx) => {
        await ingestEnvelope({
          db: tx,
          mailboxId,
          remoteResourceId,
          folderId: inboxFolderId,
          message: inbound,
          captureWorkflowTriggers: true,
        });
        const [inside] = await tx<{ events: number; runs: number }[]>`
          SELECT
            (SELECT COUNT(*)::int FROM workflows.event WHERE target_workflow_id IN (${workflowIds[0]}::uuid, ${workflowIds[1]}::uuid)) AS events,
            (SELECT COUNT(*)::int FROM workflows.run WHERE workflow_id IN (${workflowIds[0]}::uuid, ${workflowIds[1]}::uuid)) AS runs
        `;
        expect(inside).toEqual({ events: 2, runs: 0 });
        throw new Error("ROLLBACK_WORKFLOW_INGEST");
      }),
    ).rejects.toThrow("ROLLBACK_WORKFLOW_INGEST");

    const [rolledBack] = await sql<{ messages: number; events: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM mail.message_contents WHERE mailbox_id = ${mailboxId}::uuid AND message_id = ${inbound.messageId}) AS messages,
        (SELECT COUNT(*)::int FROM workflows.event WHERE target_workflow_id IN (${workflowIds[0]}::uuid, ${workflowIds[1]}::uuid)) AS events
    `;
    expect(rolledBack).toEqual({ messages: 0, events: 0 });

    await sql.begin((tx) =>
      ingestEnvelope({
        db: tx,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        message: inbound,
        captureWorkflowTriggers: true,
      }),
    );
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: inbound,
      captureWorkflowTriggers: true,
    });
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: copyFolderId,
      message: {
        ...envelope({ uid: 7002, providerMessageId: inbound.providerMessageId, messageId: inbound.messageId }),
        remoteRef: { folderStableKey: `workflow-copy-${suffix}`, uidValidity: "1", uid: "7002", modseq: "7002" },
      },
      captureWorkflowTriggers: true,
    });
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: envelope({ uid: 7003, providerMessageId: `workflow-historical-${suffix}` }),
      captureWorkflowTriggers: false,
    });
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: envelope({ uid: 7004, providerMessageId: `workflow-outbound-${suffix}`, from: "support@example.test" }),
      captureWorkflowTriggers: true,
    });
    expect((await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId })).dispatched).toBe(2);

    const persisted = await sql<{ target_workflow_id: string; events: number; runs: number }[]>`
      SELECT event.target_workflow_id::text, COUNT(DISTINCT event.id)::int AS events, COUNT(DISTINCT run.id)::int AS runs
      FROM workflows.event event
      LEFT JOIN workflows.run run ON run.event_id = event.id
      WHERE event.target_workflow_id IN (${workflowIds[0]}::uuid, ${workflowIds[1]}::uuid)
      GROUP BY event.target_workflow_id
      ORDER BY event.target_workflow_id
    `;
    expect(persisted).toEqual(
      workflowIds.toSorted().map((targetWorkflowId) => ({ target_workflow_id: targetWorkflowId, events: 1, runs: 1 })),
    );
  });

  test("keeps a 100-workflow inbox lookup mailbox-scoped and index-backed", async () => {
    const targetMailbox = await createMailbox(context, { name: `Workflow scale target ${suffix}` });
    const unrelatedMailbox = await createMailbox(context, { name: `Workflow scale unrelated ${suffix}` });
    if (!targetMailbox.ok || !unrelatedMailbox.ok) throw new Error("Failed to create workflow scale mailboxes");
    const targetMailboxId = targetMailbox.data.id;
    const unrelatedMailboxId = unrelatedMailbox.data.id;
    const accessIds: string[] = [];
    const seedActiveWorkflows = async (scopeId: string, count: number, prefix: string) => {
      const fixtures = Array.from({ length: count }, (_, index) => ({
        workflow_id: crypto.randomUUID(),
        version_id: crypto.randomUUID(),
        workflow_key: `${prefix}-${index}`,
        name: `${prefix} ${index}`,
      }));
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO workflows.workflow (
            id, app_id, scope_id, key, name, active_version_id, created_by_kind
          )
          SELECT
            fixture.workflow_id::uuid, 'mail', ${scopeId}, fixture.workflow_key, fixture.name, NULL, 'system'
          FROM jsonb_to_recordset(${fixtures}::jsonb)
            AS fixture(workflow_id text, version_id text, workflow_key text, name text)
        `;
        await tx`
          INSERT INTO workflows.version (
            id, workflow_id, revision, source, source_hash, plan, diagnostics, effect_budget,
            language_id, language_version, manifest_hash, created_by_kind
          )
          SELECT
            fixture.version_id::uuid,
            fixture.workflow_id::uuid,
            1,
            'triggers:\n  messageReceived:\n    with: {}\nsteps:\n  - succeed:\n      message: scale\n',
            ${"a".repeat(64)},
            ${{
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
            }}::jsonb,
            '[]'::jsonb,
            ${noEffectBudget}::jsonb,
            'mail',
            1,
            ${"b".repeat(64)},
            'system'
          FROM jsonb_to_recordset(${fixtures}::jsonb)
            AS fixture(workflow_id text, version_id text, workflow_key text, name text)
        `;
        await tx`
          UPDATE workflows.workflow workflow
          SET active_version_id = fixture.version_id::uuid
          FROM jsonb_to_recordset(${fixtures}::jsonb)
            AS fixture(workflow_id text, version_id text, workflow_key text, name text)
          WHERE workflow.id = fixture.workflow_id::uuid
        `;
        await tx`
          INSERT INTO mail.workflow_profile (id, mailbox_id, priority, enabled)
          SELECT fixture.workflow_id::uuid, ${scopeId}::uuid, 100, true
          FROM jsonb_to_recordset(${fixtures}::jsonb)
            AS fixture(workflow_id text, version_id text, workflow_key text, name text)
        `;
        await tx`
          INSERT INTO workflows.activation (
            workflow_id, workflow_version_id, key, event_type, config, authorization_snapshot, enabled
          )
          SELECT
            fixture.workflow_id::uuid,
            fixture.version_id::uuid,
            'trigger.messageReceived',
            'mail.messageReceived',
            '{"with": {}}'::jsonb,
            ${{
              appId: "mail",
              scopeId,
              actor: { kind: "system" },
            }}::jsonb,
            true
          FROM jsonb_to_recordset(${fixtures}::jsonb)
            AS fixture(workflow_id text, version_id text, workflow_key text, name text)
        `;
      });
      return fixtures;
    };

    try {
      const targetWorkflows = await seedActiveWorkflows(targetMailboxId, 100, `scale-target-${suffix}`);
      await seedActiveWorkflows(unrelatedMailboxId, 1_000, `scale-unrelated-${suffix}`);
      const [resource] = await sql<{ id: string }[]>`
        INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
        VALUES (${targetMailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 'active')
        RETURNING id
      `;
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${resource!.id}::uuid, ${`scale-inbox-${suffix}`}, 'Inbox', 'inbox', 'current')
        RETURNING id
      `;

      await ingestEnvelope({
        db: sql,
        mailboxId: targetMailboxId,
        remoteResourceId: resource!.id,
        folderId: folder!.id,
        message: {
          ...envelope({ uid: 7100, providerMessageId: `workflow-scale-${suffix}` }),
          remoteRef: { folderStableKey: `scale-inbox-${suffix}`, uidValidity: "1", uid: "7100", modseq: "7100" },
        },
        captureWorkflowTriggers: true,
      });
      const dispatch = await dispatchPendingWorkflowEvents(200, { appId: "mail", scopeId: targetMailboxId });
      expect(dispatch).toMatchObject({ dispatched: 100, failed: 0 });

      const [counts] = await sql<{ target_events: number; target_runs: number; unrelated_events: number }[]>`
        SELECT
          (SELECT COUNT(*)::int FROM workflows.event WHERE app_id = 'mail' AND scope_id = ${targetMailboxId}) AS target_events,
          (SELECT COUNT(*)::int FROM workflows.run WHERE app_id = 'mail' AND scope_id = ${targetMailboxId}) AS target_runs,
          (SELECT COUNT(*)::int FROM workflows.event WHERE app_id = 'mail' AND scope_id = ${unrelatedMailboxId}) AS unrelated_events
      `;
      expect(counts).toEqual({ target_events: 100, target_runs: 100, unrelated_events: 0 });
      expect(
        (
          await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count
            FROM workflows.event
            WHERE target_workflow_id IN (
              SELECT value::uuid
              FROM jsonb_array_elements_text(${targetWorkflows.map((item) => item.workflow_id)}::jsonb)
            )
          `
        )[0],
      ).toEqual({ count: 100 });

      await sql`ANALYZE mail.workflow_profile, workflows.workflow, workflows.activation`;
      const [mailboxPlan, activationPlan] = await sql.begin(async (tx) => {
        await tx`SET LOCAL enable_seqscan = off`;
        return Promise.all([
          tx`
            EXPLAIN (FORMAT JSON)
            SELECT workflow.id
            FROM mail.workflow_profile profile
            JOIN workflows.workflow workflow ON workflow.id = profile.id
            WHERE profile.mailbox_id = ${targetMailboxId}::uuid
              AND profile.enabled
              AND workflow.active_version_id IS NOT NULL
            ORDER BY profile.priority, workflow.id
          `,
          tx`
            EXPLAIN (FORMAT JSON)
            SELECT activation.workflow_id
            FROM workflows.activation activation
            WHERE activation.workflow_id = ANY(
              ${toPgUuidArray(targetWorkflows.map((item) => item.workflow_id))}::uuid[]
            )
              AND activation.event_type = 'mail.messageReceived'
              AND activation.enabled
          `,
        ]);
      });
      expect(JSON.stringify(mailboxPlan)).toContain("workflow_profile_mailbox_priority_idx");
      expect(JSON.stringify(activationPlan)).toContain("activation_workflow_id_key_key");
    } finally {
      for (const scopedMailboxId of [targetMailboxId, unrelatedMailboxId]) {
        const rows = await sql<{ access_id: string }[]>`
          SELECT access_id::text FROM mail.mailbox_access WHERE mailbox_id = ${scopedMailboxId}::uuid
        `;
        accessIds.push(...rows.map((row) => row.access_id));
        await sql`DELETE FROM mail.mailboxes WHERE id = ${scopedMailboxId}::uuid`;
        await deleteWorkflowScope({ appId: "mail", scopeId: scopedMailboxId });
      }
      if (accessIds.length > 0) {
        await sql`
          DELETE FROM auth.access
          WHERE id IN (
            SELECT value::uuid
            FROM jsonb_array_elements_text(${accessIds}::jsonb)
          )
        `;
      }
    }
  }, 15_000);

  test("creates reviewable workflow reply drafts in the source conversation", async () => {
    const incomingBase = envelope({ uid: 7091, providerMessageId: `workflow-reply-draft-${suffix}` });
    const incoming = {
      ...incomingBase,
      addresses: {
        ...incomingBase.addresses,
        replyTo: [{ name: "Reply desk", address: "reply-desk@example.test" }],
      },
    };
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: incoming,
      captureWorkflowTriggers: false,
    });
    const [reference] = await sql<{ id: string }[]>`
      SELECT ref.id
      FROM mail.remote_message_refs ref
      JOIN mail.message_contents message ON message.id = ref.message_id
      WHERE message.mailbox_id = ${mailboxId}::uuid
        AND message.message_id = ${incoming.messageId}
      LIMIT 1
    `;
    if (!reference) throw new Error("Failed to load workflow reply source");
    const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: reference.id });
    if (!snapshot?.source.conversation) throw new Error("Workflow reply source has no conversation");
    expect(snapshot.mailboxShortId).toBe(mailboxShortId);
    expect(snapshot.source.message.id).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(snapshot.source.message.folderId).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(snapshot.source.conversation.id).toMatch(/^[0-9A-Za-z]{6}$/);
    expect(snapshot.source.message).not.toHaveProperty("remoteMessageRefId");
    expect(snapshot.source.message).not.toHaveProperty("messageId");
    expect(snapshot.preconditions.message.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(snapshot.preconditions.message.remoteMessageRefId).toBe(reference.id);
    expect(snapshot.source.message.bodyAvailable).toBe(false);
    await sql`
      UPDATE mail.message_contents
      SET hydration_status = 'body', plain_text = 'A reviewable response'
      WHERE id = ${snapshot.preconditions.message.id}::uuid
    `;

    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: `Reply draft ${suffix}`,
        priority: 100,
        source: `inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "\${{ trigger.message }}"
      conversation: "\${{ trigger.conversation }}"
steps:
  - if:
      contains:
        - "\${{ inputs.message.bodyText }}"
        - reviewable
    then:
      - createReplyDraft:
          message: inputs.message
          conversation: inputs.conversation
          sender: ${senderIdentityShortId}
          body: A reviewable response
          format: plain
          saveAs: draft
`,
        effectBudget: { ...noEffectBudget, maxDrafts: 1 },
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(activated.error.message);
    const emission = await emitWorkflowEvent(
      {
        appId: "mail",
        scopeId: mailboxId,
        type: "mail.messageReceived",
        targetWorkflowId: created.data.id,
        data: { message: snapshot.source.message, conversation: snapshot.source.conversation },
        context: mailWorkflowEventContext(snapshot),
        dedupeKey: `mail-workflow-reply-draft-${suffix}`,
        occurredAt: new Date(snapshot.internalDate),
      },
      { dispatch: "now" },
    );
    const outcome = await runMailWorkflow(emission.runIds[0]!);
    expect(outcome.state).toBe("finished");
    const [draft] = await sql<
      {
        id: string;
        conversation_id: string;
        intent: string;
        source_message_id: string;
        to_addresses: Array<{ name: string | null; address: string }> | string;
        subject: string;
        body_markdown: string;
        delivery_class: string;
        origin: string;
      }[]
    >`
      SELECT id, conversation_id, intent, source_message_id, to_addresses, subject, body_markdown, delivery_class, origin
      FROM mail.drafts
      WHERE author_kind = 'workflow'
        AND author_id = ${created.data.currentVersion.id}::uuid
    `;
    expect(draft).toMatchObject({
      conversation_id: snapshot.preconditions.conversation!.id,
      intent: "reply",
      source_message_id: snapshot.preconditions.message.id,
      subject: `Re: ${incoming.subject}`,
      body_markdown: "A reviewable response",
      delivery_class: "normal",
      origin: "user",
    });
    expect(typeof draft?.to_addresses === "string" ? JSON.parse(draft.to_addresses) : draft?.to_addresses).toEqual([
      { name: "Reply desk", address: "reply-desk@example.test" },
    ]);
    const visibleDraft = await getDraft(context, mailboxId, draft!.id);
    expect(visibleDraft.ok).toBe(true);
    const conversationDrafts = await listConversationDrafts({
      context,
      mailboxId,
      conversationId: snapshot.preconditions.conversation!.id,
    });
    expect(conversationDrafts.ok && conversationDrafts.data.some((item) => item.id === draft!.id)).toBe(true);
  });

  test("guards automatic replies across delivery, repeat, policy-loss, and cancellation boundaries", async () => {
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: `Automatic reply safety ${suffix}`,
        priority: 100,
        source: "steps:\n  - succeed:\n      message: fixture\n",
        effectBudget: noEffectBudget,
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const createRun = (key: string) =>
      createWorkflowRun({
        appId: "mail",
        scopeId: mailboxId,
        workflowId: created.data.id,
        workflowVersionId: created.data.currentVersion.id,
        mode: "execute",
        authorization: {},
        idempotencyKey: `automatic-reply-${suffix}-${key}`,
        occurredAt: new Date("2026-07-26T12:00:00.000Z"),
      });
    const createSource = async (key: string) => {
      const [message] = await sql<{ id: string }[]>`
        INSERT INTO mail.message_contents (short_id,
          mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status
        ) VALUES (${newShortId()},
          ${mailboxId}::uuid,
          ${`<automatic-reply-${key}-${suffix}@example.test>`},
          ${`Automatic reply ${key}`},
          ${`automatic reply ${key}`},
          '2026-07-26T12:00:00.000Z',
          128,
          ${key.padEnd(64, "0").slice(0, 64)},
          'complete'
        )
        RETURNING id
      `;
      const [conversation] = await sql<{ id: string }[]>`
        INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_inbound_at, latest_message_at)
        VALUES (${newShortId()}, ${mailboxId}::uuid, ${`Automatic reply ${key}`}, 'Customer', now(), now())
        RETURNING id
      `;
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${message!.id}::uuid, 1, 'headers')
      `;
      return { messageId: message!.id, conversationId: conversation!.id };
    };
    const prepare = async (params: {
      runId: string;
      source: { messageId: string; conversationId: string };
      recipient: string;
      listId?: string;
    }) =>
      sql.begin((tx) =>
        prepareAutomaticReplyInTransaction({
          db: tx,
          mailboxId,
          workflowVersionId: created.data.currentVersion.id,
          workflowRunId: params.runId,
          stepKey: "steps.0",
          messageId: params.source.messageId,
          conversationId: params.source.conversationId,
          senderIdentityId,
          subject: "Re: automatic reply",
          body: "We received your message.",
          format: "plain",
          protocolFacts: {
            ...EMPTY_MESSAGE_PROTOCOL_FACTS,
            returnPath: `<${params.recipient}>`,
            autoSubmitted: "no",
            list: { ...EMPTY_MESSAGE_PROTOCOL_FACTS.list, id: params.listId ?? null },
          },
          occurredAt: "2026-07-26T12:00:00.000Z",
          minimumIntervalHours: 24,
          schedule: { mode: "always" },
        }),
      );

    const firstSource = await createSource("1");
    const firstRun = await createRun("first");
    const first = await prepare({ runId: firstRun, source: firstSource, recipient: "customer@example.test" });
    expect(first).toMatchObject({ ok: true, data: { state: "queued" } });

    const duplicate = await prepare({
      runId: await createRun("same-message"),
      source: firstSource,
      recipient: "customer@example.test",
    });
    expect(duplicate).toMatchObject({
      ok: true,
      data: { state: "suppressed", reasons: expect.arrayContaining(["already_replied", "recipient_rate_limited"]) },
    });

    const repeatSource = await createSource("2");
    const repeat = await prepare({
      runId: await createRun("same-recipient"),
      source: repeatSource,
      recipient: "customer@example.test",
    });
    expect(repeat).toMatchObject({
      ok: true,
      data: { state: "suppressed", reasons: expect.arrayContaining(["recipient_rate_limited"]) },
    });

    const listSource = await createSource("3");
    const list = await prepare({
      runId: await createRun("list"),
      source: listSource,
      recipient: "list-sender@example.test",
      listId: "announcements.example.test",
    });
    expect(list).toMatchObject({
      ok: true,
      data: { state: "suppressed", reasons: expect.arrayContaining(["mailing_list"]) },
    });

    await sql`UPDATE mail.sender_identities SET status = 'disabled' WHERE id = ${senderIdentityId}::uuid`;
    const policyLossSource = await createSource("4");
    const policyLoss = await prepare({
      runId: await createRun("policy-loss"),
      source: policyLossSource,
      recipient: "fresh@example.test",
    });
    expect(policyLoss).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    await sql`UPDATE mail.sender_identities SET status = 'verified' WHERE id = ${senderIdentityId}::uuid`;

    await sql`
      UPDATE workflows.run
      SET state = 'canceled', finished_at = now()
      WHERE id = ${firstRun}::uuid
    `;
    const cancelled = await sql.begin((tx) =>
      cancelPendingAutomaticRepliesInTransaction({
        db: tx,
        mailboxId,
        workflowRunId: firstRun,
        code: "WORKFLOW_CANCELLED",
        message: "Workflow was cancelled before provider delivery",
      }),
    );
    expect(cancelled).toEqual({ cancelled: 1, needsAttention: 0 });
    const [stored] = await sql<{ effect_state: string; draft_state: string }[]>`
      SELECT effect.state AS effect_state, draft.state AS draft_state
      FROM mail.automatic_reply_effects effect
      JOIN mail.drafts draft ON draft.id = effect.draft_id
      WHERE effect.workflow_run_id = ${firstRun}::uuid
    `;
    expect(stored).toEqual({ effect_state: "cancelled", draft_state: "discarded" });
  });

  test("dispatches an active Mail event and completes its kernel run", async () => {
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: "Event dispatch",
        priority: 100,
        source: `triggers:
  messageReceived:
    with: {}
steps:
  - succeed:
      message: Event handled
`,
        effectBudget: {
          maxTargets: 1,
          maxMoves: 0,
          maxCopies: 0,
          maxSends: 0,
          maxDrafts: 0,
          maxFlagChanges: 0,
          maxNotifications: 0,
          maxKeywordChanges: 0,
          maxCollaborationChanges: 0,
          maxAiCalls: 0,
        },
      },
    });
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(`${activated.error.code}: ${activated.error.message}`);

    const target = {
      targetKey: crypto.randomUUID(),
      mailboxShortId,
      source: {
        message: { id: newShortId() },
        conversation: null,
      },
      preconditions: {
        sourceHash: "event-context-test",
        message: { id: crypto.randomUUID(), remoteMessageRefId: crypto.randomUUID(), folderId: crypto.randomUUID() },
        remoteState: { modseq: "42", flags: ["seen"], keywords: ["review"] },
        conversation: null,
        triggerKind: "messageReceived",
      },
      internalDate: new Date().toISOString(),
    } as unknown as MailWorkflowTargetSnapshot;
    const emission = await emitWorkflowEvent(
      {
        appId: "mail",
        scopeId: mailboxId,
        type: "mail.messageReceived",
        targetWorkflowId: created.data.id,
        data: {},
        context: mailWorkflowEventContext(target),
        dedupeKey: `mail-workflow-kernel-${suffix}`,
        occurredAt: new Date(),
      },
      { dispatch: "now" },
    );
    expect(emission.runIds).toHaveLength(1);
    const outcome = await runMailWorkflow(emission.runIds[0]!);
    expect(outcome.state).toBe("finished");
    const [stored] = await sql<{ state: string; event_id: string | null; context: Record<string, unknown> | string }[]>`
      SELECT state, event_id::text, context
      FROM workflows.run
      WHERE id = ${emission.runIds[0]}::uuid
    `;
    expect(stored).toMatchObject({ state: "succeeded", event_id: emission.eventId });
    expect(typeof stored?.context === "string" ? JSON.parse(stored.context) : stored?.context).toMatchObject({
      preconditions: target.preconditions,
    });
  });

  test("restores projected conversation revisions after a lost worker lease", async () => {
    const [conversation] = await sql<{ id: string; short_id: string; revision: number }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Recovery test', 'Sender', now())
      RETURNING id, short_id, revision
    `;
    if (!conversation) throw new Error("Failed to create workflow conversation");

    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: "Projection recovery",
        priority: 100,
        source: `inputs:
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      conversation: "\${{ trigger.conversation }}"
steps:
  - setConversationStatus:
      conversation: inputs.conversation
      status: waiting
  - setConversationStatus:
      conversation: inputs.conversation
      status: done
`,
        effectBudget: {
          maxTargets: 1,
          maxMoves: 0,
          maxCopies: 0,
          maxSends: 0,
          maxDrafts: 0,
          maxFlagChanges: 0,
          maxNotifications: 0,
          maxKeywordChanges: 0,
          maxCollaborationChanges: 2,
          maxAiCalls: 0,
        },
      },
    });
    if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(`${activated.error.code}: ${activated.error.message}`);

    const snapshot = {
      targetKey: crypto.randomUUID(),
      mailboxShortId,
      source: {
        message: {
          id: newShortId(),
        },
        conversation: {
          id: conversation.short_id,
          subject: "Recovery test",
          assigneeUserId: null,
          workStatus: "needs_action",
          revision: conversation.revision,
          latestMessageAt: new Date().toISOString(),
        },
      },
      preconditions: {
        sourceHash: "recovery-test",
        message: { id: crypto.randomUUID(), remoteMessageRefId: crypto.randomUUID(), folderId: crypto.randomUUID() },
        remoteState: { modseq: "1", flags: [], keywords: [] },
        conversation: { id: conversation.id, revision: conversation.revision },
        triggerKind: "messageReceived",
      },
      internalDate: new Date().toISOString(),
    } as unknown as MailWorkflowTargetSnapshot;
    const emission = await emitWorkflowEvent(
      {
        appId: "mail",
        scopeId: mailboxId,
        type: "mail.messageReceived",
        targetWorkflowId: created.data.id,
        data: { conversation: snapshot.source.conversation },
        context: mailWorkflowEventContext(snapshot),
        dedupeKey: `mail-workflow-recovery-${suffix}`,
        occurredAt: new Date(),
      },
      { dispatch: "now" },
    );
    const runId = emission.runIds[0]!;
    let tookOver = false;
    const first = await runMailWorkflow(runId, {
      emit: async (event) => {
        if (!tookOver && event.type === "step.finished" && event.result.mode === "execute" && event.result.outcome.state === "completed") {
          tookOver = true;
          await sql`UPDATE workflows.run SET execution_generation = execution_generation + 1 WHERE id = ${runId}::uuid`;
        }
      },
    });
    expect(first.state).toBe("lost");

    await sql`
      UPDATE workflows.run
      SET state = 'queued', retry_after = NULL, lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ${runId}::uuid
    `;
    const second = await runMailWorkflow(runId);
    expect(second.state).toBe("finished");
    const [stored] = await sql<{ state: string; revision: string | number; work_status: string }[]>`
      SELECT run.state, conversation.revision, conversation.work_status
      FROM workflows.run run
      JOIN mail.conversations conversation ON conversation.id = ${conversation.id}::uuid
      WHERE run.id = ${runId}::uuid
    `;
    expect(stored).toEqual({ state: "succeeded", revision: String(Number(conversation.revision) + 2), work_status: "done" });
  });

  test("replaces the editable conversation summary through a normal Mail action", async () => {
    const [conversation] = await sql<{ id: string; short_id: string; revision: string; summary_revision: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at)
      VALUES (${newShortId()}, ${mailboxId}::uuid, 'Summary action test', 'Sender', now())
      RETURNING id, short_id, revision, summary_revision
    `;
    if (!conversation) throw new Error("Failed to create summary workflow conversation");

    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: `Summary action ${suffix}`,
        priority: 100,
        source: `inputs:
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      conversation: "\${{ trigger.conversation }}"
steps:
  - setConversationSummary:
      conversation: inputs.conversation
      summary: "Current context for {{ inputs.conversation.subject }}"
`,
        effectBudget: { ...noEffectBudget, maxCollaborationChanges: 1 },
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(activated.error.message);

    const frozenConversation = {
      id: conversation.short_id,
      subject: "Summary action test",
      summary: null,
      summaryRevision: Number(conversation.summary_revision),
      assigneeUserId: null,
      workStatus: "needs_action" as const,
      revision: Number(conversation.revision),
      latestMessageAt: new Date().toISOString(),
    };
    const snapshot = {
      targetKey: crypto.randomUUID(),
      mailboxShortId,
      source: { message: null, conversation: frozenConversation },
      preconditions: {
        sourceHash: "summary-action-test",
        remoteState: null,
        conversation: { id: conversation.id, revision: Number(conversation.revision) },
        triggerKind: "messageReceived",
      },
      internalDate: new Date().toISOString(),
    } as unknown as MailWorkflowTargetSnapshot;
    const emission = await emitWorkflowEvent(
      {
        appId: "mail",
        scopeId: mailboxId,
        type: "mail.messageReceived",
        targetWorkflowId: created.data.id,
        data: { conversation: frozenConversation },
        context: mailWorkflowEventContext(snapshot),
        dedupeKey: `mail-workflow-summary-${suffix}`,
        occurredAt: new Date(snapshot.internalDate),
      },
      { dispatch: "now" },
    );
    const outcome = await runMailWorkflow(emission.runIds[0]!);
    expect(outcome.state).toBe("finished");

    const [stored] = await sql<{ summary: string | null; summary_revision: string; revision: string }[]>`
      SELECT summary, summary_revision, revision
      FROM mail.conversations
      WHERE id = ${conversation.id}::uuid
    `;
    expect(stored).toEqual({
      summary: "Current context for Summary action test",
      summary_revision: String(Number(conversation.summary_revision) + 1),
      revision: String(Number(conversation.revision) + 1),
    });
    const activity = await listActivity({ context, mailboxId, conversationId: conversation.id, limit: 10 });
    expect(activity.ok).toBe(true);
    if (activity.ok) {
      expect(activity.data.items).toContainEqual(
        expect.objectContaining({
          action: "conversation.summary_updated",
          actor: expect.objectContaining({ kind: "workflow", displayName: `Summary action ${suffix}` }),
        }),
      );
    }
  });
});
