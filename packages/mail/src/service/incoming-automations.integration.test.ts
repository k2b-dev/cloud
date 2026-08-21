import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { toPgUuidArray } from "@valentinkolb/cloud/services";
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
    ownerContext = contextFor(owner);
    writerContext = contextFor(writer);
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
});
