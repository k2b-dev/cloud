import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@k2b/cloud";
import { mandates } from "@k2b/cloud/services";
import { validateMandateIssueAuthority } from "@k2b/cloud/services/mandates";
import { createWorkflowRun, deleteWorkflowScope } from "@k2b/cloud/workflows/store";
import { useTestAppRegistry } from "../../../scripts/fixtures/app-registry";
import { suiteFor } from "../../../scripts/fixtures/test-infra";
// This interop test needs Mail's isolated database and process Sync, just like its own integration suites.
import "../../mail/test/integration-preload";
import { bindAppEvents } from "../../cloud/src/events/app-events";
import type { MailRequestContext } from "../../mail/src/service/auth";
import { migrateIncomingAutomationTargets } from "../../mail/src/service/incoming-automation-targets-migrate";
import { resolveIncomingAutomationMandateCaller } from "../../mail/src/service/incoming-automation-workload";
import { createIncomingAutomation } from "../../mail/src/service/incoming-automations";
import { createMailbox } from "../../mail/src/service/mailboxes";
import { spacesCapabilities } from "./capabilities";
import { spacesService } from "./service";

suiteFor("database", "nats")("incoming Mail automation target upgrade against Spaces", () => {
  useTestAppRegistry(["mail", "spaces"]);
  let ownerContext: MailRequestContext;
  let mailboxId = "";
  let userId = "";
  beforeAll(async () => {
    // Production app.start binds the publisher; this boundary fixture does not start a server.
    bindAppEvents("spaces", spacesCapabilities);
    const [user] = await sql<{ id: string }[]>`INSERT INTO auth.users(uid, provider, profile, display_name)
      VALUES ('fictional-mail-spaces-target-upgrade', 'local', 'user', 'Fictional Mail owner') RETURNING id`;
    userId = user!.id;
    ownerContext = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid: "fictional-mail-spaces-target-upgrade",
          provider: "local",
          profile: "user",
          displayName: "Fictional Mail owner",
          givenname: "Fictional",
          sn: "Owner",
          mail: "fictional-mail-owner@example.test",
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroup: [],
          manages: [],
          managesGroupIds: [],
          avatarHash: null,
          ipa: null,
          accountExpires: null,
          lastLoginLocal: null,
        },
      },
      accessSubject: { type: "user", userId },
      requestId: "fictional-mail-spaces-upgrade",
    };
    const mailbox = await createMailbox(ownerContext, { name: "Fictional target upgrade Mailbox" });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
  });
  afterAll(async () => {
    if (mailboxId) {
      await deleteWorkflowScope({ appId: "mail", scopeId: mailboxId });
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });
  test("old-format Spaces automation keeps creating events only at its configured target; migration is audited, atomic and idempotent", async () => {
    if (ownerContext.actor.kind !== "user") throw new Error("Expected fixture person");
    const user = ownerContext.actor.user;
    const space = await spacesService.space.create({
      data: { name: "Fictional upgrade Space", color: "#3b82f6", starter: "blank" },
      creatorId: user.id,
    });
    if (!space.ok) throw new Error(space.error);
    const [target] = await sql<{ space_id: string; column_id: string }[]>`SELECT space.short_id AS space_id, col.short_id AS column_id
      FROM spaces.spaces space JOIN spaces.columns col ON col.space_id = space.id WHERE space.id = ${space.data.id}::uuid LIMIT 1`;
    if (!target) throw new Error("Expected fixture column");
    try {
      const created = await createIncomingAutomation({
        context: ownerContext,
        mailboxId,
        input: {
          name: "Fictional legacy event automation",
          enabled: true,
          scope: { mode: "all" },
          steps: [
            {
              id: "00000000-0000-4000-8000-000000000081",
              kind: "create_space_event",
              spaceId: target.space_id,
              columnId: target.column_id,
              event: {
                kind: "custom",
                title: "Fictional planning",
                startsAt: "2026-09-03T10:00:00Z",
                endsAt: "2026-09-03T11:00:00Z",
                allDay: false,
              },
            },
          ],
        },
      });
      if (!created.ok) throw new Error(created.error.message);
      const [binding] = await sql<
        { mandate_id: string }[]
      >`SELECT mandate_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`;
      const fresh = await mandates.get(binding!.mandate_id);
      expect(fresh?.policy.grants).toEqual([
        {
          appId: "spaces",
          capabilityId: "event.create",
          kind: "action",
          target: { type: "spaces.space", id: target.space_id },
          refs: {},
          fixedInput: { columnId: target.column_id },
        },
      ]);
      // Exact pre-C0g2 stored policy: operation allowlist, no grants or target coordinates.
      const oldPolicy = {
        version: 1 as const,
        apps: ["spaces"],
        operations: ["capability.action.run:event.create"],
        actions: "preapproved" as const,
      };
      await sql`UPDATE auth.mandates SET policy = ${JSON.stringify(oldPolicy)}::text::jsonb WHERE id = ${binding!.mandate_id}::uuid`;
      await sql`UPDATE mail.incoming_automations SET capability_target_version = 0 WHERE id = ${created.data.id}::uuid`;
      const before = (
        await sql<
          { steps: unknown; scope: unknown; workflow_id: string }[]
        >`SELECT steps, scope, workflow_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`
      )[0];
      await expect(
        sql.begin(async (tx) => {
          await migrateIncomingAutomationTargets(tx);
          throw new Error("fictional rollback");
        }),
      ).rejects.toThrow("fictional rollback");
      expect((await mandates.get(binding!.mandate_id))?.policy).toEqual(oldPolicy);
      await sql.begin(migrateIncomingAutomationTargets);
      const migrated = await mandates.get(binding!.mandate_id);
      expect(migrated?.state).toBe("active");
      const runId = await createWorkflowRun({
        appId: "mail",
        scopeId: mailboxId,
        workflowId: created.data.workflowId,
        workflowVersionId: created.data.workflowVersionId,
        mode: "execute",
        authorization: {},
        idempotencyKey: "fictional-mail-target-upgrade",
        occurredAt: new Date("2026-09-03T10:00:00Z"),
      });
      const caller = await resolveIncomingAutomationMandateCaller(runId);
      expect((await sql`SELECT steps, scope, workflow_id FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`)[0]).toEqual(
        before,
      );
      const input = {
        columnId: target.column_id,
        title: "Fictional planning",
        startsAt: "2026-09-03T10:00:00Z",
        endsAt: "2026-09-03T11:00:00Z",
      };
      const call = { capability: "spaces.event.create", target: { type: "spaces.space", id: target.space_id }, refs: {}, input };
      const admit = (requested = call) =>
        validateMandateIssueAuthority({
          mandateId: caller.mandate.id,
          expectedRevision: caller.mandate.revision,
          ownerAppId: caller.mandate.callingAppId,
          targetAppId: "spaces",
          operation: "capability.action.run:event.create",
          input: requested.input,
          call: requested,
          capabilityApproval: spacesCapabilities.actions["event.create"].approval,
        });
      expect((await admit()).ok).toBe(true);
      expect((await admit({ ...call, target: { type: "spaces.space", id: "Other1" } })).ok).toBe(false);
      expect((await admit({ ...call, input: { ...input, columnId: "OtherC" } })).ok).toBe(false);
      // The admitted call reaches the real Spaces action and durable application storage.
      const result = await spacesCapabilities.actions["event.create"].run(input, {
        ...ownerContext,
        user,
        locale: "en",
        requestId: "fictional-mail-upgrade",
        origin: "app",
        target: call.target,
        signal: new AbortController().signal,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(
        (await sql`SELECT title FROM spaces.items WHERE space_id = ${space.data.id}::uuid AND title = 'Fictional planning'`).length,
      ).toBe(1);
      const snapshot = async () =>
        JSON.stringify({
          automation: (await sql`SELECT * FROM mail.incoming_automations WHERE id = ${created.data.id}::uuid`)[0],
          mandate: await mandates.get(binding!.mandate_id),
          audit:
            await sql`SELECT * FROM audit.events WHERE action = 'mail.incoming_automation.targets.migrate' AND target_id = ${created.data.id} ORDER BY id`,
        });
      const once = await snapshot();
      await sql.begin(migrateIncomingAutomationTargets);
      expect(await snapshot()).toBe(once);
      expect(
        (
          await sql`SELECT id FROM audit.events WHERE action = 'mail.incoming_automation.targets.migrate' AND target_id = ${created.data.id}`
        ).length,
      ).toBe(1);
    } finally {
      await sql`DELETE FROM spaces.spaces WHERE id = ${space.data.id}::uuid`;
    }
  });
});
