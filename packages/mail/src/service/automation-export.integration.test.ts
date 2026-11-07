import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { accounts } from "@k2b/cloud/services";
import { createTestSession } from "@k2b/cloud/services/session/session.test-fixture";
import "../../../../scripts/fixtures/authorization-preload";
import { deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { Hono } from "hono";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import exportRoutes from "../api/automation-export";
import type { MailApiContext } from "../api/public-resource-boundary";
import type { MailAutomationExportPage } from "../automation-export-contracts";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { exportMailAutomation } from "./automation-export";
import { createMailbox } from "./mailboxes";

suiteFor(
  "database",
  "nats",
  "valkey",
)("Mail automation definition exports", () => {
  const users: string[] = [];
  let ownerSession = "";
  let mailboxId = "";
  let mailboxShortId = "";
  let owner: MailRequestContext;
  let writer: MailRequestContext;
  let admin: MailRequestContext;
  const workflowId = "44bb0000-0000-4000-8000-000000000001";
  const source =
    '# exact spacing and comment\nsteps:\n  - aiGenerateText:\n      prompt: "Summarize only supplied facts"\n      maxOutputChars: 1000\n';
  beforeAll(async () => {
    setSystemTime(new Date("2026-11-07T00:00:00.000Z"));
    await migrate();
    const context = async (uid: string, isAdmin = false): Promise<MailRequestContext> => {
      const [row] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name, admin)
        VALUES (${uid}, 'local', 'user', ${uid}, ${isAdmin}) RETURNING id`;
      const user = await accounts.users.get({ id: row!.id });
      if (!user) throw new Error("Missing export fixture user");
      users.push(user.id);
      return { actor: { kind: "user", user }, accessSubject: { type: "user", userId: user.id } };
    };
    owner = await context("mail-export-owner");
    ownerSession = await createTestSession(users[0]!);
    writer = await context("mail-export-writer");
    admin = await context("mail-export-admin", true);
    const mailbox = await createMailbox(owner, { name: "Automation export fixture" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [row] = await sql<{ short_id: string }[]>`SELECT short_id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    mailboxShortId = row!.short_id;
    const grant = await grantMailboxAccess({
      context: owner,
      mailboxId,
      principal: { type: "user", userId: users[1]! },
      permission: "write",
    });
    if (!grant.ok) throw new Error(grant.error.message);
    await sql`INSERT INTO workflows.workflow(id, app_id, scope_id, key, name, created_by_kind)
      VALUES (${workflowId}::uuid, 'mail', ${mailboxId}, 'export-fixture', 'All versions', 'system')`;
    await sql`INSERT INTO mail.workflow_profile(id, mailbox_id, priority, enabled, managed_by)
      VALUES (${workflowId}::uuid, ${mailboxId}::uuid, 7, false, 'incoming_automation')`;
    await sql`INSERT INTO mail.incoming_automations(short_id, mailbox_id, workflow_id, name, normalized_name, enabled, scope, steps, created_by_actor_kind, created_by_actor_id)
      VALUES ('ExRule', ${mailboxId}::uuid, ${workflowId}::uuid, 'Export rule', 'export rule', false,
      '{"mode":"all"}'::jsonb,
      '[{"kind":"link_space_item","id":"step1","itemId":"Item01"}]'::jsonb,
      'user', ${users[0]}::uuid)`;
    await sql`INSERT INTO workflows.version(id, workflow_id, revision, source, source_hash, plan, effect_budget,
      language_id, language_version, manifest_hash, created_by_kind)
      SELECT ('44bb0000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${workflowId}::uuid, n,
        ${source}, ${"a".repeat(64)}, '{"bindings":{"spaceItem":"Item01"}}'::jsonb,
        '{"maxAiCalls":1,"maxTargets":1}'::jsonb, 'mail', 1, ${"b".repeat(64)}, 'system'
      FROM generate_series(1, 205) n`;
    await sql`UPDATE workflows.workflow SET active_version_id = '44bb0000-0000-4000-8000-000000000001' WHERE id = ${workflowId}::uuid`;
  });
  afterAll(async () => {
    if (mailboxId) {
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    for (const id of users) await sql`DELETE FROM auth.users WHERE id = ${id}::uuid`;
    setSystemTime();
  });
  const router = (context: MailRequestContext) =>
    new Hono<MailApiContext>()
      .use("*", async (c, next) => {
        c.set("actor", context.actor);
        c.set("accessSubject", context.accessSubject);
        await next();
      })
      .route("/", exportRoutes);

  test("exports all 205 managed versions through the owning API without changing source or enabled state", async () => {
    const entries: MailAutomationExportPage["items"] = [];
    let after: string | null = null;
    do {
      const response = await router(owner).request(`/mailboxes/${mailboxShortId}/automation-export${after ? `?after=${after}` : ""}`);
      expect(response.status).toBe(200);
      const page: MailAutomationExportPage = await response.json();
      expect(page).toMatchObject({ format: "cloud.mail-automation", version: 1, authority: "none", scope: "mailbox" });
      entries.push(...page.items);
      after = page.nextCursor;
    } while (after);
    expect(entries).toHaveLength(205);
    expect(new Set(entries.map((item) => item.version.id)).size).toBe(205);
    expect(entries[0]).toMatchObject({
      mailbox: { id: mailboxShortId },
      workflow: { enabled: false, priority: 7, order: 1, managedBy: "incoming_automation" },
      version: { source, bindings: { spaceItem: "Item01" }, effectBudget: { maxAiCalls: 1, maxTargets: 1 } },
      guidedDefinition: { id: "ExRule", revision: 1, steps: [{ itemId: "Item01" }] },
    });
    expect(entries.at(-1)!.version.revision).toBe(205);
    expect(entries[0]!.workflow.currentVersionId).toBe(entries.at(-1)!.version.id);
    expect(entries[0]!.workflow.activeVersionId).toBe(entries[0]!.version.id);
  });
  test("writers cannot export a mailbox and ordinary people cannot export the installation", async () => {
    expect((await router(writer).request(`/mailboxes/${mailboxShortId}/automation-export`)).status).toBe(403);
    expect((await router(owner).request("/admin/automation-export", { headers: { cookie: `session_token=${ownerSession}` } })).status).toBe(
      403,
    );
    expect(await exportMailAutomation(owner, {})).toMatchObject({ ok: false, error: { status: 403 } });
    expect(
      (
        await exportMailAutomation(
          {
            ...admin,
            actor: {
              ...admin.actor,
              delegation: { kind: "invocation", callingAppId: "assistant", credentialKind: "mandate", invocationId: "fixture" },
            },
          },
          {},
        )
      ).ok,
    ).toBe(false);
    expect((await exportMailAutomation(admin, { limit: 1 })).ok).toBe(true);
  });
  test("marks definitions from deleted mailboxes as historical evidence", async () => {
    await sql`UPDATE mail.mailboxes SET deleted_at = '2026-11-06T00:00:00Z' WHERE id = ${mailboxId}::uuid`;
    try {
      const result = await exportMailAutomation(admin, { after: "44bb0000-0000-4000-8000-000000000000" });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data.items[0]?.mailbox).toMatchObject({ id: mailboxShortId, deletedAt: expect.stringContaining("2026-11-06") });
    } finally {
      await sql`UPDATE mail.mailboxes SET deleted_at = NULL WHERE id = ${mailboxId}::uuid`;
    }
  });
  test("never exports activation authority or stored credentials", async () => {
    await sql`INSERT INTO workflows.activation(workflow_id, workflow_version_id, key, event_type, config, authorization_snapshot, enabled)
      VALUES (${workflowId}::uuid, '44bb0000-0000-4000-8000-000000000001', 'received', 'mail.messageReceived', '{}',
      '{"accessToken":"not-exportable","credentialId":"not-exportable","authorization":"not-exportable"}'::jsonb, false)`;
    const result = await exportMailAutomation(owner, { mailboxId, limit: 1 });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain("not-exportable");
    if (result.ok) expect(result.data.items[0]!.activations).toMatchObject([{ key: "received", enabled: false }]);
  });
});
