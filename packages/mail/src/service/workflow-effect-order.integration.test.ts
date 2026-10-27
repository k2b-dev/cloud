import { afterAll, beforeAll, expect, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { deleteWorkflowScope, dispatchPendingWorkflowEvents, getWorkflowRun, wakeExpiredWorkflowRuns } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { applyConversationCollaboration } from "./collaboration";
import { createMailbox } from "./mailboxes";
import { ingestEnvelope } from "./sync-runtime";
import { getWorkflowSnapshot } from "./workflow-data";
import { activateWorkflow, createWorkflow, deactivateWorkflow } from "./workflow-definition-service";
import { claimMailWorkflowEffect, resolveMailWorkflowEffectTurn } from "./workflow-effect-order";
import { ensureMailWorkflowEffectOrderSchema } from "./workflow-effect-order-schema";
import { runMailWorkflow } from "./workflow-runtime";

const suite = suiteFor("database", "nats");

suite("Durable Mail workflow effect order", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const inboxStableKey = `placement-inbox-${suffix}`;
  let userId = "";
  let mailboxId = "";
  let remoteResourceId = "";
  let inboxFolderId = "";
  let context: MailRequestContext;

  beforeAll(async () => {
    await migrate();
    await ensureMailWorkflowEffectOrderSchema(sql);
    const [user] = await sql<{ id: string; uid: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`mail-workflow-placement-${suffix}`}, 'local', 'user', 'Mail workflow placement', false)
      RETURNING id, uid
    `;
    if (!user) throw new Error("Failed to create placement test user");
    userId = user.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: user.id,
          uid: user.uid,
          provider: "local",
          profile: "user",
          displayName: "Mail workflow placement",
          givenname: "Mail",
          sn: "Placement",
          mail: `${user.uid}@example.test`,
          avatarHash: null,
          roles: ["user"],
          ipa: null,
          accountExpires: null,
          lastLoginLocal: null,
          memberofGroup: [],
          memberofGroupIds: [],
          manages: [],
          managesGroupIds: [],
        },
      },
      accessSubject: { type: "user", userId },
      requestId: `mail-workflow-placement-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Workflow placement ${suffix}` });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${"e".repeat(64)}, 'active')
      RETURNING id
    `;
    if (!resource) throw new Error("Failed to create placement remote resource");
    remoteResourceId = resource.id;
    const fixtureSecret = await encryptSecret({ kind: "password", password: "fixture-secret" });
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username,
        imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode,
        secret_kind, encrypted_secret, status
      ) VALUES (
        ${mailboxId}::uuid, 'Workflow placement fixture', 'support@example.test', 'support@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 465, 'implicit',
        'password', ${fixtureSecret}, 'active'
      )
      RETURNING id
    `;
    if (!connection) throw new Error("Failed to create placement provider connection");
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator,
        verified_scope_fingerprint, verified_secret_revision, capabilities
      ) VALUES (
        ${remoteResourceId}::uuid, ${connection.id}::uuid, 'active', '{}'::jsonb,
        ${"e".repeat(64)}, 1, '{"move":true}'::jsonb
      )
      RETURNING id
    `;
    if (!binding) throw new Error("Failed to create placement provider binding");
    for (const role of ["inbox", "archive", "trash", "junk"] as const) {
      const name = role === "inbox" ? "INBOX" : role[0]!.toUpperCase() + role.slice(1);
      const [folder] = await sql<{ id: string }[]>`
        INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
        VALUES (${newShortId()}, ${remoteResourceId}::uuid, ${`placement-${role}-${suffix}`}, ${name}, ${role}, 'current')
        RETURNING id
      `;
      if (!folder) throw new Error(`Failed to create placement ${role} folder`);
      if (role === "inbox") inboxFolderId = folder.id;
      await sql`
        INSERT INTO mail.binding_folder_refs (
          binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
        ) VALUES (
          ${binding.id}::uuid, ${folder.id}::uuid, ${name}, 1, 1,
          ARRAY['read', 'insert', 'move', 'write_flags']::text[], now()
        )
      `;
    }
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`
        DELETE FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid RETURNING access_id
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
    await sql`DELETE FROM audit.events WHERE request_id = ${context?.requestId}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const ingest = async (uid: number) => {
    const messageId = `<placement-${uid}-${suffix}@example.test>`;
    await sql.begin(async (tx) =>
      ingestEnvelope({
        db: tx,
        mailboxId,
        remoteResourceId,
        folderId: inboxFolderId,
        captureWorkflowTriggers: true,
        message: {
          remoteRef: { folderStableKey: inboxStableKey, uidValidity: "1", uid: String(uid), modseq: "1" },
          providerMessageId: `placement-${uid}-${suffix}`,
          providerThreadId: null,
          messageId,
          inReplyTo: null,
          references: [],
          subject: `Placement message ${uid}`,
          sentAt: new Date("2026-01-15T12:00:00Z"),
          internalDate: new Date("2026-01-15T12:00:00Z"),
          sizeBytes: 128,
          flags: [],
          labels: [],
          addresses: {
            from: [{ name: "Customer", address: "customer@external.test" }],
            replyTo: [],
            to: [{ name: "Support", address: "support@example.test" }],
            cc: [],
            bcc: [],
          },
          mimeStructure: {},
        },
      }),
    );
    const [ref] = await sql<{ id: string }[]>`
      SELECT ref.id FROM mail.remote_message_refs ref JOIN mail.message_contents message ON message.id = ref.message_id
      WHERE message.mailbox_id = ${mailboxId}::uuid AND message.message_id = ${messageId}
    `;
    if (!ref) throw new Error("Missing placement message reference");
    const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: ref.id });
    if (!snapshot) throw new Error("Missing placement message snapshot");
    return { snapshot, remoteMessageRefId: ref.id, messageId };
  };

  let nextUid = 12000;
  const active: { id: string; versionId: string }[] = [];
  const rule = async (priority: number, steps: string, name = `Order rule ${priority}`) => {
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name,
        priority,
        source: `inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "\${{ trigger.message }}"
      conversation: "\${{ trigger.conversation }}"
steps:
${steps}
`,
        effectBudget: {
          maxTargets: 1,
          maxMoves: 2,
          maxCopies: 0,
          maxSends: 0,
          maxDrafts: 0,
          maxFlagChanges: 0,
          maxNotifications: 0,
          maxKeywordChanges: 0,
          maxCollaborationChanges: 10,
          maxAiCalls: 0,
        },
      },
    });
    if (!created.ok) throw new Error(JSON.stringify(created.error));
    const activated = await activateWorkflow({
      context,
      mailboxId,
      workflowId: created.data.id,
      input: { expectedVersionId: created.data.currentVersion.id },
    });
    if (!activated.ok) throw new Error(JSON.stringify(activated.error));
    const result = { id: created.data.id, versionId: created.data.currentVersion.id };
    active.push(result);
    return result;
  };
  const disable = async () => {
    for (const workflow of active.splice(0)) {
      const disabled = await deactivateWorkflow({
        context,
        mailboxId,
        workflowId: workflow.id,
        input: { expectedVersionId: workflow.versionId },
      });
      if (!disabled.ok) throw new Error(disabled.error.message);
    }
  };
  const receive = async () => {
    const message = await ingest(nextUid++);
    const events = await sql<{ id: string; target_workflow_id: string }[]>`
      SELECT id::text, target_workflow_id::text FROM workflows.event
      WHERE app_id='mail' AND scope_id=${mailboxId}
        AND dedupe_key LIKE ${`message:${message.remoteMessageRefId}:%`}
    `;
    return { ...message, events };
  };
  const dispatch = async (events: { id: string; target_workflow_id: string }[]) => {
    await dispatchPendingWorkflowEvents(100, { appId: "mail", scopeId: mailboxId });
    const rows = await sql<{ id: string; workflow_id: string; event_id: string }[]>`
      SELECT id::text, workflow_id::text, event_id::text FROM workflows.run
      WHERE scope_id=${mailboxId} AND event_id IN (
        SELECT value::uuid FROM jsonb_array_elements_text(${events.map((event) => event.id)}::jsonb)
      )
    `;
    return (workflowId: string) => {
      const run = rows.find((run) => run.workflow_id === workflowId);
      if (!run) throw new Error(`Missing run ${workflowId}`);
      return run.id;
    };
  };
  const recheck = async (runId: string) => {
    // Advance only this test's durable dependency deadline; no sleeps or clock-dependent fixtures.
    await sql`UPDATE workflows.run SET wake_at='2000-01-01'::timestamptz WHERE id=${runId}::uuid`;
    await wakeExpiredWorkflowRuns(100, { appId: "mail" });
    return runMailWorkflow(runId);
  };
  const outputs = (runId: string) => sql<{ output: Record<string, unknown> }[]>`
    SELECT outcome #> '{outcome,output}' AS output FROM workflows.step_outcome
    WHERE run_id=${runId}::uuid AND state='completed' ORDER BY step_key
  `;
  const assign = (target = "Mail workflow placement") =>
    `  - assignConversation: { conversation: inputs.conversation, user: ${JSON.stringify(target)} }`;

  test("an undispatched upper is pending, slow upper wins and both rules add tags", async () => {
    const tags = [];
    for (const name of ["upper", "lower"]) {
      const [tag] = await sql<{ short_id: string }[]>`
        INSERT INTO mail.local_tags (short_id,mailbox_id,name,normalized_name,created_by_actor_kind,created_by_actor_id)
        VALUES (${newShortId()},${mailboxId}::uuid,${`${name}-${suffix}`},${`${name}-${suffix}`},'user',${userId}::uuid)
        RETURNING short_id
      `;
      if (!tag) throw new Error("Missing tag");
      tags.push(tag.short_id);
    }
    const upper = await rule(1, `${assign()}\n  - addLocalTag: { conversation: inputs.conversation, tag: '${tags[0]}' }`, "Upper rule");
    const lower = await rule(2, `${assign()}\n  - addLocalTag: { conversation: inputs.conversation, tag: '${tags[1]}' }`, "Lower rule");
    try {
      const received = await receive();
      expect(received.events).toHaveLength(2);
      // Dispatch only the lower event first: absence of an upper run is not a decision.
      await sql`UPDATE workflows.event SET dispatch_after='2099-01-01' WHERE id=${received.events.find((event) => event.target_workflow_id === upper.id)!.id}::uuid`;
      const run = await dispatch(received.events);
      const lowerRun = run(lower.id);
      expect(await runMailWorkflow(lowerRun)).toMatchObject({ state: "finished", result: { state: "waiting" } });
      expect(await getWorkflowRun(lowerRun)).toMatchObject({ state: "waiting" });
      await sql`UPDATE workflows.event SET dispatch_after='2000-01-01' WHERE id=${received.events.find((event) => event.target_workflow_id === upper.id)!.id}::uuid`;
      const allRuns = await dispatch(received.events);
      const upperRun = allRuns(upper.id);
      // Reordering configuration after ingress cannot reverse this message's frozen order.
      await sql`UPDATE mail.workflow_profile SET priority=900 WHERE id=${upper.id}::uuid`;
      expect(await runMailWorkflow(upperRun)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      expect(await recheck(lowerRun)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
      expect(
        (await outputs(lowerRun)).some(
          ({ output }) => output.skipped === "upper_rule" && output.workflowId === upper.id && output.name === "Upper rule",
        ),
      ).toBe(true);
      const [count] = await sql<{ n: number }[]>`
        SELECT count(*)::integer AS n FROM mail.conversation_local_tags WHERE mailbox_id=${mailboxId}::uuid
      `;
      expect(count?.n).toBe(2);
      const logs = await sql<{ run_id: string; effects: { kind: string; name?: string }[]; by: { position: number; name: string } }[]>`
        SELECT run_id::text, item->'effects' AS effects, item->'by' AS by FROM mail.automation_log
        WHERE run_id IN (${upperRun}::uuid, ${lowerRun}::uuid)
      `;
      expect(logs.find((entry) => entry.run_id === upperRun)?.by).toMatchObject({ position: 1, name: "Upper rule" });
      expect(logs.find((entry) => entry.run_id === upperRun)?.effects).toContainEqual({ kind: "tag", name: `upper-${suffix}` });
      expect(logs.find((entry) => entry.run_id === lowerRun)?.effects).toContainEqual({ kind: "tag", name: `lower-${suffix}` });
      const [claim] = await sql<{ run_id: string }[]>`
        SELECT run_id::text FROM mail.workflow_effect_claim WHERE remote_message_ref_id=${received.remoteMessageRefId}::uuid AND effect_class='assignment'
      `;
      expect(claim?.run_id).toBe(upperRun);
    } finally {
      await disable();
    }
  }, 30000);

  test("upper chooses nobody, lower may assign with the current conversation revision", async () => {
    const upper = await rule(1, assign("null").replace('"null"', "null"));
    const lower = await rule(2, assign());
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "waiting" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      expect(await recheck(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(lower.id))).some(({ output }) => output.action === "assignConversation" && output.applied === true)).toBe(
        true,
      );
    } finally {
      await disable();
    }
  }, 30000);

  test("equal priorities use frozen UUID order; terminal upper with no claim permits lower", async () => {
    const first = await rule(5, assign());
    const second = await rule(5, assign());
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      const [upper, lower] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
      if (!upper || !lower) throw new Error("Missing rules");
      const turn = await sql.begin((tx) => resolveMailWorkflowEffectTurn(tx, { runId: run(lower.id), effectClass: "status" }));
      expect(turn.state).toBe("waiting");
      await sql`UPDATE workflows.run SET state='failed' WHERE id=${run(upper.id)}::uuid`;
      expect(await sql.begin((tx) => resolveMailWorkflowEffectTurn(tx, { runId: run(lower.id), effectClass: "status" }))).toEqual({
        state: "ready",
        ordered: true,
      });
    } finally {
      await disable();
    }
  });

  test("24h expiry permits lower and durably fences a late upper decision", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, assign());
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      await sql`UPDATE mail.workflow_effect_order SET expires_at='2000-01-01' WHERE remote_message_ref_id=${received.remoteMessageRefId}::uuid`;
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(upper.id))).some(({ output }) => output.skipped === "order_expired")).toBe(true);
      const [closed] = await sql<
        { closed: boolean }[]
      >`SELECT closed_at IS NOT NULL AS closed FROM mail.workflow_effect_order WHERE workflow_id=${upper.id}::uuid AND remote_message_ref_id=${received.remoteMessageRefId}::uuid`;
      expect(closed?.closed).toBe(true);
    } finally {
      await disable();
    }
  });

  test("claims roll back with effects and an applied upper still wins after failure or expiry", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, assign());
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      try {
        await sql.begin(async (tx) => {
          expect((await resolveMailWorkflowEffectTurn(tx, { runId: run(upper.id), effectClass: "status" })).state).toBe("ready");
          await claimMailWorkflowEffect(tx, { runId: run(upper.id), effectClass: "status" });
          throw new Error("rollback");
        });
      } catch (error) {
        expect(String(error)).toContain("rollback");
      }
      const claims = await sql`SELECT 1 FROM mail.workflow_effect_claim WHERE remote_message_ref_id=${received.remoteMessageRefId}::uuid`;
      expect(claims).toHaveLength(0);
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      await sql`UPDATE workflows.run SET state='failed' WHERE id=${run(upper.id)}::uuid`;
      await sql`UPDATE mail.workflow_effect_order SET expires_at='2000-01-01' WHERE workflow_id=${upper.id}::uuid AND remote_message_ref_id=${received.remoteMessageRefId}::uuid`;
      expect(await sql.begin((tx) => resolveMailWorkflowEffectTurn(tx, { runId: run(lower.id), effectClass: "assignment" }))).toMatchObject(
        { state: "skip", reason: "upper_rule", workflowId: upper.id },
      );
    } finally {
      await disable();
    }
  });
  test("placement claims share the command transaction and lower placement skips a pending upper intent", async () => {
    const upper = await rule(1, "  - moveMessage: { message: inputs.message, folder: Archive }");
    const lower = await rule(2, "  - trashMessage: { message: inputs.message }");
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "waiting" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "waiting" } });
      const [intent] = await sql<{ run_id: string; correlation_id: string; state: string }[]>`
        SELECT claim.run_id::text, command.correlation_id, command.state
        FROM mail.workflow_effect_claim claim JOIN mail.commands command ON command.correlation_id=claim.run_id::text
        WHERE claim.remote_message_ref_id=${received.remoteMessageRefId}::uuid AND claim.effect_class='placement'
      `;
      expect(intent).toMatchObject({ run_id: run(upper.id), correlation_id: run(upper.id), state: "queued" });
      expect(await recheck(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(lower.id))).some(({ output }) => output.skipped === "upper_rule" && output.workflowId === upper.id)).toBe(
        true,
      );
      const commands = await sql`SELECT 1 FROM mail.commands WHERE correlation_id=${run(lower.id)}`;
      expect(commands).toHaveLength(0);
    } finally {
      await disable();
    }
  }, 30000);

  test("one rule may set status twice; a lower status waits and then skips", async () => {
    const upper = await rule(
      1,
      "  - setConversationStatus: { conversation: inputs.conversation, status: waiting }\n  - setConversationStatus: { conversation: inputs.conversation, status: done }",
    );
    const lower = await rule(2, "  - setConversationStatus: { conversation: inputs.conversation, status: needs_action }");
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "waiting" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(upper.id))).filter(({ output }) => output.applied === true)).toHaveLength(2);
      expect(await recheck(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(lower.id))).some(({ output }) => output.skipped === "upper_rule" && output.value === "needs_action")).toBe(
        true,
      );
      const [conversation] = await sql<{ work_status: string }[]>`
        SELECT conversation.work_status FROM mail.conversations conversation JOIN mail.conversation_messages link ON link.conversation_id=conversation.id
        JOIN mail.remote_message_refs ref ON ref.message_id=link.message_id WHERE ref.id=${received.remoteMessageRefId}::uuid
      `;
      expect(conversation?.work_status).toBe("done");
    } finally {
      await disable();
    }
  }, 30000);

  test("an upper assignment does not block a lower status decision on its fresh revision", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, "  - setConversationStatus: { conversation: inputs.conversation, status: done }");
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect(
        (await outputs(run(lower.id))).some(({ output }) => output.action === "setConversationStatus" && output.applied === true),
      ).toBe(true);
    } finally {
      await disable();
    }
  }, 30000);
  test("a lower status preserves a person's change even after a sibling assignment", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, "  - setConversationStatus: { conversation: inputs.conversation, status: waiting }");
    try {
      const received = await receive(),
        run = await dispatch(received.events);
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      const conversationId = received.snapshot.preconditions.conversation!.id;
      const [current] = await sql<
        { revision: string | number }[]
      >`SELECT revision FROM mail.conversations WHERE id = ${conversationId}::uuid`;
      const changed = await applyConversationCollaboration({
        context,
        mailboxId,
        conversationId,
        input: { expectedRevision: Number(current!.revision), completion: "done" },
      });
      expect(changed.ok).toBe(true);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "failed" } });
      const [after] = await sql<{ work_status: string }[]>`SELECT work_status FROM mail.conversations WHERE id = ${conversationId}::uuid`;
      expect(after?.work_status).toBe("done");
      const claims =
        await sql`SELECT 1 FROM mail.workflow_effect_claim WHERE remote_message_ref_id = ${received.remoteMessageRefId}::uuid AND effect_class = 'status'`;
      expect(claims).toHaveLength(0);
    } finally {
      await disable();
    }
  }, 30000);

  test("concurrent rule workers cannot claim the same exclusive class", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, assign());
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      const results = await Promise.all([runMailWorkflow(run(upper.id)), runMailWorkflow(run(lower.id))]);
      expect(results[0]).toMatchObject({ result: { state: "succeeded" } });
      const lowerState = await getWorkflowRun(run(lower.id));
      if (lowerState?.state === "waiting") await recheck(run(lower.id));
      expect(await getWorkflowRun(run(lower.id))).toMatchObject({ state: "succeeded" });
      expect((await outputs(run(lower.id))).some(({ output }) => output.skipped === "upper_rule" && output.workflowId === upper.id)).toBe(
        true,
      );
      const claims = await sql<{ run_id: string }[]>`
        SELECT run_id::text FROM mail.workflow_effect_claim WHERE remote_message_ref_id=${received.remoteMessageRefId}::uuid AND effect_class='assignment'
      `;
      expect(claims).toEqual([{ run_id: run(upper.id) }]);
    } finally {
      await disable();
    }
  }, 30000);
  test("guided creation age cannot override the mailbox's frozen rule priority", async () => {
    const upper = await rule(1, "  - moveMessage: { message: inputs.message, folder: Archive }");
    const lower = await rule(2, "  - moveMessage: { message: inputs.message, folder: Archive }");
    try {
      for (const [workflow, name, createdAt] of [
        [upper, "newer upper", "2026-01-02T00:00:00Z"],
        [lower, "older lower", "2026-01-01T00:00:00Z"],
      ] as const) {
        await sql`
          INSERT INTO mail.incoming_automations (
            short_id,mailbox_id,workflow_id,name,normalized_name,enabled,scope,steps,
            created_by_actor_kind,created_by_actor_id,created_at
          ) VALUES (
            ${newShortId()},${mailboxId}::uuid,${workflow.id}::uuid,${name},${name},true,
            ${{ mode: "all" }}::jsonb,
            ${[{ id: crypto.randomUUID(), kind: "mail_action", action: { kind: "move_to_folder", folderId: "Archive" } }]}::jsonb,
            'user',${userId}::uuid,${createdAt}::timestamptz
          )
        `;
      }
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "waiting" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "waiting" } });
      const [claim] = await sql<{ run_id: string }[]>`
        SELECT run_id::text FROM mail.workflow_effect_claim WHERE remote_message_ref_id=${received.remoteMessageRefId}::uuid AND effect_class='placement'
      `;
      expect(claim?.run_id).toBe(run(upper.id));
      expect(await recheck(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      expect((await outputs(run(lower.id))).some(({ output }) => output.skipped === "upper_rule" && output.workflowId === upper.id)).toBe(
        true,
      );
    } finally {
      await disable();
    }
  }, 30000);

  test("canceled and needs_attention uppers without claims release lower effects", async () => {
    const upper = await rule(1, assign());
    const lower = await rule(2, assign());
    try {
      for (const state of ["canceled", "needs_attention"] as const) {
        const received = await receive();
        const run = await dispatch(received.events);
        await sql`UPDATE workflows.run SET state=${state} WHERE id=${run(upper.id)}::uuid`;
        expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
        expect((await outputs(run(lower.id))).some(({ output }) => output.action === "assignConversation" && output.applied === true)).toBe(
          true,
        );
      }
    } finally {
      await disable();
    }
  }, 30000);
  test("comments and summaries from both rules remain non-exclusive", async () => {
    const upper = await rule(
      1,
      `${assign()}\n  - setConversationSummary: { conversation: inputs.conversation, summary: 'Upper summary' }\n  - addComment: { conversation: inputs.conversation, body: 'Upper comment' }`,
    );
    const lower = await rule(
      2,
      `${assign()}\n  - setConversationSummary: { conversation: inputs.conversation, summary: 'Lower summary' }\n  - addComment: { conversation: inputs.conversation, body: 'Lower comment' }`,
    );
    try {
      const received = await receive();
      const run = await dispatch(received.events);
      expect(await runMailWorkflow(run(lower.id))).toMatchObject({ result: { state: "waiting" } });
      expect(await runMailWorkflow(run(upper.id))).toMatchObject({ result: { state: "succeeded" } });
      expect(await recheck(run(lower.id))).toMatchObject({ result: { state: "succeeded" } });
      for (const workflow of [upper, lower]) {
        const journal = await outputs(run(workflow.id));
        expect(journal.some(({ output }) => output.action === "setConversationSummary" && output.applied === true)).toBe(true);
        expect(journal.some(({ output }) => typeof output.commentId === "string" && output.applied === true)).toBe(true);
      }
      const [state] = await sql<{ summary: string; n: number }[]>`
        SELECT conversation.summary,(SELECT count(*)::integer FROM mail.conversation_comments comment WHERE comment.conversation_id=conversation.id) AS n
        FROM mail.conversations conversation JOIN mail.conversation_messages link ON link.conversation_id=conversation.id
        JOIN mail.remote_message_refs ref ON ref.message_id=link.message_id WHERE ref.id=${received.remoteMessageRefId}::uuid
      `;
      expect(state).toMatchObject({ summary: "Lower summary", n: 2 });
    } finally {
      await disable();
    }
  }, 30000);
});
