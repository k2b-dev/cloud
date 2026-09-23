import { afterAll, beforeAll, expect, test } from "bun:test";
import { getProcessSync } from "@k2b/cloud";
import { mandates, toPgUuidArray } from "@k2b/cloud/services";
import { parsePgJsonRecord } from "@k2b/cloud/services/postgres";
import {
  createWorkflowRun,
  deleteWorkflowScope,
  dispatchPendingWorkflowEvents,
  wakeWorkflowRunsWaitingOn,
} from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess, listMailboxAccess, revokeMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { resolveIncomingAutomationPlacementTurn } from "./incoming-automation-order";
import { resolveIncomingAutomationMandateCaller } from "./incoming-automation-workload";
import {
  createIncomingAutomation,
  deleteIncomingAutomation,
  listIncomingAutomationActivityMetadata,
  listIncomingAutomations,
  setIncomingAutomationEnabled,
  startIncomingAutomationBackfill,
  startIncomingAutomationBackfillRuntime,
  stopIncomingAutomationBackfillRuntime,
  updateIncomingAutomation,
} from "./incoming-automations";
import { createMailbox } from "./mailboxes";
import { ingestEnvelope } from "./sync-runtime";
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
        'password', 'fixture-secret', 'active'
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
          ARRAY['read', 'insert', 'move']::text[], now()
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
      let result = await startIncomingAutomationBackfill(request);
      // The backfill runs on the Sync worker; bound the wait by time, not by iterations.
      const deadline = Date.now() + 10_000;
      while (result.ok && result.data.state !== "completed" && Date.now() < deadline) {
        await Bun.sleep(20);
        result = await startIncomingAutomationBackfill(request);
      }
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.state).toBe("completed");
      expect(result.data.newlyAcceptedCount).toBe(0);
      const repeated = await startIncomingAutomationBackfill(request);
      expect(repeated.ok && repeated.data.updatedAt).toBe(result.data.updatedAt);
      const [span] = await sql<{ attributes: Record<string, unknown>; summary: Record<string, unknown> }[]>`
        SELECT attributes, summary FROM logging.trace_spans
        WHERE source = 'mail:incoming-automation-backfill'
          AND attributes ->> 'mail.backfill.operation_id' = ${operationId}
          AND ended_at IS NOT NULL
      `;
      expect(span?.attributes["mail.mailbox.id"]).toBe(mailboxId);
      expect(span?.summary.status).toBe("completed");
      expect(span?.summary.dispatched).toBe(0);
    } finally {
      await stopIncomingAutomationBackfillRuntime();
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
  test("runs matching automations oldest first and skips a message an older automation moved", async () => {
    const [archive] = await sql<{ short_id: string }[]>`
      SELECT short_id FROM mail.folders WHERE id = ${archiveFolderId}::uuid
    `;
    if (!archive) throw new Error("Failed to load the archive folder public id");
    const sender = `ordered-${suffix}@external.test`;
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
        name: `Ordered junk ${suffix}`,
        enabled: true,
        scope,
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "junk" } }],
      },
    });
    if (!newer.ok) throw new Error(newer.error.message);
    // The list is the run order.
    const listed = await listIncomingAutomations(ownerContext, mailboxId);
    const listedIds = listed.ok ? listed.data.map((item) => item.id) : [];
    expect(listedIds.indexOf(older.data.id)).toBeLessThan(listedIds.indexOf(newer.data.id));

    const uid = 8100 + Math.floor(Math.random() * 800);
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      message: {
        remoteRef: { folderStableKey: `incoming-automation-inbox-${suffix}`, uidValidity: "1", uid: String(uid), modseq: String(uid) },
        providerMessageId: `ordered-${suffix}`,
        providerThreadId: null,
        messageId: `<ordered-${suffix}@external.test>`,
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

    // The older automation issues its move and parks on the provider command.
    await runMailWorkflow(olderRunId);
    const commandsFor = async (runId: string) => sql<{ kind: string }[]>`
      SELECT kind FROM mail.commands WHERE correlation_id = ${runId}
    `;
    expect((await commandsFor(olderRunId)).map((command) => command.kind)).toEqual(["move"]);

    // The newer one leaves the placement to it and finishes cleanly.
    const settled = await runMailWorkflow(newerRunId);
    expect(settled.state).toBe("finished");
    expect(await commandsFor(newerRunId)).toEqual([]);
    const [skipped] = await sql<{ state: string; outcome: { outcome?: { output?: Record<string, unknown> } } | string }[]>`
      SELECT run.state, step.outcome
      FROM workflows.run run
      JOIN workflows.step_outcome step ON step.run_id = run.id AND step.state = 'completed'
      WHERE run.id = ${newerRunId}::uuid
      ORDER BY step.step_key DESC
      LIMIT 1
    `;
    expect(skipped?.state).toBe("succeeded");
    const outcome = typeof skipped?.outcome === "string" ? JSON.parse(skipped.outcome) : skipped?.outcome;
    expect(outcome?.outcome?.output).toMatchObject({ action: "junkMessage", applied: false, skipped: "earlier_automation" });

    // The provider confirms the move, and the parked run resumes to observe it.
    // Its allowance is one move, which the move already spent: charging the
    // resume again failed every guided placement automation.
    const [moveCommand] = await sql<{ id: string }[]>`
      SELECT id FROM mail.commands WHERE correlation_id = ${olderRunId} AND kind = 'move'
    `;
    if (!moveCommand) throw new Error("The move command was not created");
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${moveCommand.id}::uuid`;
    expect(await wakeWorkflowRunsWaitingOn({ appId: "mail", kind: "mail.command", key: moveCommand.id })).toContain(olderRunId);

    const resumed = await runMailWorkflow(olderRunId);
    expect(resumed.state).toBe("finished");
    const [older_run] = await sql<{ state: string; effects_used: Record<string, number> | string }[]>`
      SELECT state, effects_used FROM workflows.run WHERE id = ${olderRunId}::uuid
    `;
    expect(older_run?.state).toBe("succeeded");
    const used = typeof older_run?.effects_used === "string" ? JSON.parse(older_run.effects_used) : older_run?.effects_used;
    expect(used?.maxMoves).toBe(1);
    // Still one move: the resume adopted the command it already issued.
    expect((await commandsFor(olderRunId)).map((command) => command.kind)).toEqual(["move"]);

    const attention = await sql<{ id: string }[]>`
      SELECT id FROM workflows.run
      WHERE scope_id = ${mailboxId} AND state = 'needs_attention'
    `;
    expect(attention).toEqual([]);

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

    const uid = 9000 + Math.floor(Math.random() * 800);
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
});
