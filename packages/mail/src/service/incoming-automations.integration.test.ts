import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mandates, toPgUuidArray } from "@valentinkolb/cloud/services";
import { parsePgJsonRecord } from "@valentinkolb/cloud/services/postgres";
import { deleteWorkflowScope } from "@valentinkolb/cloud/workflows/store";
import { sql } from "bun";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import {
  createIncomingAutomation,
  deleteIncomingAutomation,
  listIncomingAutomationActivityMetadata,
  listIncomingAutomations,
  migrateLegacyIncomingAutomationAuthorities,
  setIncomingAutomationEnabled,
  startIncomingAutomationBackfill,
  updateIncomingAutomation,
} from "./incoming-automations";
import { createMailbox } from "./mailboxes";

const enabled = process.env.MAIL_INTEGRATION_TESTS === "1";
const suite = enabled ? describe : describe.skip;
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
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
      ) VALUES (
        ${binding.id}::uuid, ${junkFolder.id}::uuid, 'Junk', 1, 1,
        ARRAY['read', 'insert', 'move']::text[], now()
      )
    `;
  });

  afterAll(async () => {
    if (mailboxId) {
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (userIds.length > 0) await sql`DELETE FROM auth.users WHERE id = ANY(${toPgUuidArray(userIds)}::uuid[])`;
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

    const destructive = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Overlapping junk",
        enabled: true,
        scope: {
          mode: "matching",
          conditions: {
            mode: "any",
            items: [
              { field: "sender_address", operator: "is", value: "first@example.test" },
              { field: "sender_address", operator: "is", value: "shared@example.test" },
            ],
          },
        },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "junk" } }],
      },
    });
    expect(destructive.ok).toBe(true);
    if (!destructive.ok) return;
    const conflict = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Overlapping trash",
        enabled: true,
        scope: {
          mode: "matching",
          conditions: {
            mode: "any",
            items: [
              { field: "sender_address", operator: "is", value: "other@example.test" },
              { field: "sender_address", operator: "is", value: "shared@example.test" },
            ],
          },
        },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "trash" } }],
      },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.error.message).toContain("Overlapping junk");
    await deleteIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: destructive.data.id,
      input: { expectedRevision: destructive.data.revision },
    });
  });

  test("encrypts and revokes delegated Spaces authorization with the managed definition", async () => {
    const created = await createIncomingAutomation({
      context: ownerContext,
      mailboxId,
      input: {
        name: "Link project item",
        enabled: false,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const [stored] = await sql<
      { integration_credential_id: string | null; encrypted_integration_token: string | null; status: string | null }[]
    >`
      SELECT automation.integration_credential_id, automation.encrypted_integration_token, credential.status
      FROM mail.incoming_automations automation
      LEFT JOIN auth.service_account_credentials credential ON credential.id = automation.integration_credential_id
      WHERE automation.id = ${created.data.id}::uuid
    `;
    expect(stored?.integration_credential_id).not.toBeNull();
    expect(stored?.encrypted_integration_token).not.toContain("cld_");
    expect(stored?.status).toBe("active");

    const updated = await updateIncomingAutomation({
      context: ownerContext,
      mailboxId,
      automationId: created.data.id,
      input: {
        expectedRevision: created.data.revision,
        name: created.data.name,
        enabled: false,
        scope: { mode: "all" },
        steps: [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
      },
    });
    expect(updated.ok).toBe(true);
    const [after] = await sql<
      { integration_credential_id: string | null; encrypted_integration_token: string | null; status: string | null }[]
    >`
      SELECT automation.integration_credential_id, automation.encrypted_integration_token, credential.status
      FROM mail.incoming_automations automation
      LEFT JOIN auth.service_account_credentials credential ON credential.id = ${stored?.integration_credential_id ?? null}::uuid
      WHERE automation.id = ${created.data.id}::uuid
    `;
    expect(after).toMatchObject({ integration_credential_id: null, encrypted_integration_token: null, status: "revoked" });
    if (updated.ok) {
      await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: updated.data.id,
        input: { expectedRevision: updated.data.revision },
      });
    }
  });

  test("atomically migrates a bounded legacy credential to a paused mandate", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "legacy";
    try {
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: "Legacy authority migration",
          enabled: false,
          scope: { mode: "all" },
          steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item01" }],
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const [before] = await sql<{ integration_credential_id: string; mandate_id: string | null }[]>`
        SELECT integration_credential_id, mandate_id
        FROM mail.incoming_automations
        WHERE id = ${created.data.id}::uuid
      `;
      expect(before?.integration_credential_id).toBeDefined();
      expect(before?.mandate_id).toBeNull();

      process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
      const migrated = await migrateLegacyIncomingAutomationAuthorities(100);
      expect(migrated.migrated).toBeGreaterThanOrEqual(1);
      const [after] = await sql<
        {
          mandate_id: string;
          integration_credential_id: string | null;
          encrypted_integration_token: string | null;
          mandate_state: string;
          credential_state: string;
        }[]
      >`
        SELECT automation.mandate_id, automation.integration_credential_id, automation.encrypted_integration_token,
          mandate.state AS mandate_state, credential.status AS credential_state
        FROM mail.incoming_automations automation
        JOIN auth.mandates mandate ON mandate.id = automation.mandate_id
        JOIN auth.service_account_credentials credential ON credential.id = ${before!.integration_credential_id}::uuid
        WHERE automation.id = ${created.data.id}::uuid
      `;
      expect(after).toMatchObject({
        integration_credential_id: null,
        encrypted_integration_token: null,
        mandate_state: "paused",
        credential_state: "revoked",
      });
      expect((await migrateLegacyIncomingAutomationAuthorities(100)).migrated).toBe(0);

      const deleted = await deleteIncomingAutomation({
        context: ownerContext,
        mailboxId,
        automationId: created.data.id,
        input: { expectedRevision: created.data.revision + 1 },
      });
      expect(deleted.ok).toBe(true);
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("retains failed legacy authority without starving later rows and persists retry backoff", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "legacy";
    try {
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: "Legacy authority mismatch",
          enabled: true,
          scope: { mode: "all" },
          steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item02" }],
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      if (ownerContext.actor.kind !== "user") throw new Error("Expected a user test actor");
      const conflicting = await mandates.create({
        authority: { kind: "interactive", userId: ownerContext.actor.user.id },
        subject: { type: "user", id: ownerContext.actor.user.id },
        ownerAppId: "mail",
        workloadType: "incoming.automation",
        workloadId: created.data.id,
        policy: {
          version: 1,
          apps: ["spaces"],
          operations: ["capability.query:space.read"],
          actions: "deny",
        },
      });
      if (!conflicting.ok) throw new Error(conflicting.error.message);

      const healthy = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: "Later healthy legacy authority",
          enabled: false,
          scope: { mode: "all" },
          steps: [{ id: crypto.randomUUID(), kind: "link_space_item", itemId: "Item03" }],
        },
      });
      if (!healthy.ok) throw new Error(healthy.error.message);

      process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
      const migrated = await migrateLegacyIncomingAutomationAuthorities(1);
      expect(migrated).toMatchObject({ failed: 1, migrated: 0, remaining: 2 });
      expect(await migrateLegacyIncomingAutomationAuthorities(1)).toMatchObject({ failed: 0, migrated: 1, remaining: 1 });
      expect(await migrateLegacyIncomingAutomationAuthorities(1)).toMatchObject({ failed: 0, migrated: 0, remaining: 1 });
      const [attempt] = await sql<{ attempted: boolean }[]>`
        SELECT authority_migration_attempted_at IS NOT NULL AS attempted
        FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid
      `;
      expect(attempt?.attempted).toBe(true);
      await sql`
        UPDATE mail.incoming_automations SET authority_migration_attempted_at = now() - interval '2 minutes'
        WHERE id = ${created.data.id}::uuid
      `;
      expect(await migrateLegacyIncomingAutomationAuthorities(1)).toMatchObject({ failed: 1, migrated: 0, remaining: 1 });
      const [after] = await sql<
        {
          mandate_id: string | null;
          integration_credential_id: string | null;
          encrypted_integration_token: string | null;
          status: string;
        }[]
      >`
        SELECT automation.mandate_id, automation.integration_credential_id, automation.encrypted_integration_token, credential.status
        FROM mail.incoming_automations automation
        JOIN auth.service_account_credentials credential ON credential.id = automation.integration_credential_id
        WHERE automation.id = ${created.data.id}::uuid
      `;
      expect(after?.mandate_id).toBeNull();
      expect(after?.integration_credential_id).not.toBeNull();
      expect(after?.encrypted_integration_token).not.toBeNull();
      expect(after?.status).toBe("active");

      const revoked = await mandates.revoke({
        mandateId: conflicting.data.id,
        expectedRevision: conflicting.data.revision,
        authority: { kind: "interactive", userId: ownerContext.actor.user.id },
        reason: "Integration test cleanup",
      });
      expect(revoked.ok).toBe(true);
      expect(
        (
          await deleteIncomingAutomation({
            context: ownerContext,
            mailboxId,
            automationId: healthy.data.id,
            input: { expectedRevision: healthy.data.revision + 1 },
          })
        ).ok,
      ).toBe(true);
      process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "legacy";
      expect(
        (
          await deleteIncomingAutomation({
            context: ownerContext,
            mailboxId,
            automationId: created.data.id,
            input: { expectedRevision: created.data.revision },
          })
        ).ok,
      ).toBe(true);
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("creates a disabled automation with a paused bounded mandate and no user token", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
    try {
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
          integration_credential_id: string | null;
          encrypted_integration_token: string | null;
          state: string | null;
          owner_app_id: string | null;
          workload_id: string | null;
          subject_user_id: string | null;
          policy: unknown;
        }[]
      >`
        SELECT automation.mandate_id,
               automation.integration_credential_id,
               automation.encrypted_integration_token,
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
        integration_credential_id: null,
        encrypted_integration_token: null,
        state: "paused",
        owner_app_id: "mail",
        workload_id: created.data.id,
        subject_user_id: ownerContext.actor.kind === "user" ? ownerContext.actor.user.id : null,
        policy: {
          version: 1,
          apps: ["spaces"],
          operations: ["capability.action.run:event.create-once", "capability.action.run:item.reference.add"],
          actions: "preapproved",
        },
      });
      expect(stored?.mandate_id).not.toBeNull();

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
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("lets a shared mailbox admin stop but not repurpose or resume another user's mandate", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
    try {
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
      const [binding] = await sql<
        { mandate_id: string }[]
      >`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${current.id}::uuid`;
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
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("lets a shared mailbox admin remove all Spaces effects and disable revoked authority", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
    try {
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
            steps: externallyRevoked
              ? created.data.steps
              : [{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "mark_read" } }],
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
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("pauses the mandate when an enabled automation is disabled", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
    try {
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
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });

  test("resumes a paused mandate when the automation is enabled interactively", async () => {
    const previousMode = process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
    process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = "mandate";
    try {
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
    } finally {
      if (previousMode === undefined) delete process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE;
      else process.env.CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE = previousMode;
    }
  });
});
