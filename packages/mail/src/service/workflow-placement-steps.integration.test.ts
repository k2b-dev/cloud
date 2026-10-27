import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { encryptSecret } from "@k2b/cloud/services";
import { deleteWorkflowScope, emitWorkflowEvent, getWorkflowRun } from "@k2b/cloud/workflows/store";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import type { MailRequestContext } from "./auth";
import { executeMutationCommand } from "./command-runtime";
import { imapSmtpConnector } from "./connectors";
import { createLocalTag } from "./local-tags";
import { createMailbox } from "./mailboxes";
import { extractMessageProtocolFacts } from "./message-protocol";
import { ingestEnvelope } from "./sync-runtime";
import { getWorkflowSnapshot, mailWorkflowEventContext } from "./workflow-data";
import { activateWorkflow, createWorkflow, deactivateWorkflow } from "./workflow-definition-service";
import { runMailWorkflow } from "./workflow-runtime";

const suite = suiteFor("database", "nats");
const placementActions = ["moveMessage", "archiveMessage", "trashMessage", "junkMessage"] as const;
type PlacementAction = (typeof placementActions)[number];

suite("Hand-written Mail workflow placement steps", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  const inboxStableKey = `placement-inbox-${suffix}`;
  let userId = "";
  let mailboxId = "";
  let remoteResourceId = "";
  let inboxFolderId = "";
  let context: MailRequestContext;
  const metricBlobIds: string[] = [];

  beforeAll(async () => {
    await migrate();
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
    for (const blobId of metricBlobIds) await sql`DELETE FROM mail.message_part_blobs WHERE id = ${blobId}::uuid`;
    await sql`DELETE FROM audit.events WHERE request_id = ${context?.requestId}`;
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
  });

  const ingest = async (uid: number) => {
    const messageId = `<placement-${uid}-${suffix}@example.test>`;
    await ingestEnvelope({
      db: sql,
      mailboxId,
      remoteResourceId,
      folderId: inboxFolderId,
      captureWorkflowTriggers: false,
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
    });
    const [ref] = await sql<{ id: string }[]>`
      SELECT ref.id FROM mail.remote_message_refs ref JOIN mail.message_contents message ON message.id = ref.message_id
      WHERE message.mailbox_id = ${mailboxId}::uuid AND message.message_id = ${messageId}
    `;
    if (!ref) throw new Error("Missing placement message reference");
    const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: ref.id });
    if (!snapshot) throw new Error("Missing placement message snapshot");
    return { snapshot, remoteMessageRefId: ref.id, messageId };
  };

  const commandsFor = (runId: string) => sql<
    { id: string; kind: string; state: string; last_error_code: string | null; last_error_message: string | null }[]
  >`
    SELECT id, kind, state, last_error_code, last_error_message FROM mail.commands WHERE correlation_id = ${runId}
  `;
  const expectNoSkippedOutcome = async (runId: string) => {
    const skipped = await sql<{ step_key: string }[]>`
      SELECT step_key FROM workflows.step_outcome
      WHERE run_id = ${runId}::uuid AND outcome #> '{outcome,output}' ? 'skipped'
    `;
    expect(skipped).toEqual([]);
  };

  test("messageReceived numeric metrics select the local-tag branch from stored message data", async () => {
    const tagName = `Lang ${suffix}`;
    const tag = await createLocalTag({ context, mailboxId, input: { name: tagName, color: "#2563eb" } });
    if (!tag.ok) throw new Error(tag.error.message);
    const created = await createWorkflow({
      context,
      mailboxId,
      input: {
        name: `Numeric metrics ${suffix}`,
        priority: 100,
        source: `inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "\${{ trigger.message }}"
      conversation: "\${{ trigger.conversation }}"
steps:
  - if:
      all:
        - not: { equals: ["\${{ inputs.message.isBulk }}", true] }
        - any:
            - greaterThan: ["\${{ inputs.message.textLength }}", 150]
            - greaterThan: ["\${{ inputs.conversation.messageCount }}", 3]
    then:
      - addLocalTag: { conversation: inputs.conversation, tag: "${tagName}" }
  - if: { equals: ["\${{ inputs.message.attachmentCount }}", 2] }
    then:
      - succeed: { message: checked }
    else:
      - fail: { message: attachment count incorrect }
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
          maxCollaborationChanges: 1,
          maxAiCalls: 0,
        },
      },
    });
    if (!created.ok) throw new Error(created.error.message);
    const workflowId = created.data.id;
    try {
      const active = await activateWorkflow({
        context,
        mailboxId,
        workflowId,
        input: { expectedVersionId: created.data.currentVersion.id },
      });
      if (!active.ok) throw new Error(active.error.message);
      const cases = [
        { own: "x".repeat(151), messages: 1, bulk: false, tagged: true },
        { own: "Short reply", messages: 1, bulk: false, tagged: false },
        { own: "Short reply", messages: 4, bulk: false, tagged: true },
        { own: "x".repeat(150), messages: 3, bulk: false, tagged: false },
        { own: "x".repeat(151), messages: 1, bulk: true, tagged: false },
      ];
      for (const [index, scenario] of cases.entries()) {
        const initial = await ingest(9500 + index * 10);
        const messageId = initial.snapshot.preconditions.message.id;
        const conversationId = initial.snapshot.preconditions.conversation?.id;
        if (!conversationId) throw new Error("Missing metric conversation");
        const protocol = extractMessageProtocolFacts((name) =>
          scenario.bulk && name === "list-id" ? "Updates <updates.example.test>" : null,
        );
        await sql`UPDATE mail.message_contents SET hydration_status = 'complete',
          plain_text = ${`${scenario.own}\n\n-- \n${"Signature".repeat(50)}\n\nOn Monday, Customer wrote:\n> ${"History".repeat(50)}`},
          sanitized_html = '', protocol_facts = ${protocol}::jsonb WHERE id = ${messageId}::uuid`;
        for (const [partIndex, disposition] of ["attachment", "inline"].entries()) {
          const [blob] = await sql<{ id: string }[]>`INSERT INTO mail.message_part_blobs
            (content_hash, byte_length, chunk_count, complete, completed_at)
            VALUES (${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 1024, 1, true, now()) RETURNING id`;
          if (!blob) throw new Error("Missing metric attachment blob");
          metricBlobIds.push(blob.id);
          const [part] = await sql<{ id: string }[]>`INSERT INTO mail.message_parts
            (message_id, part_path, content_type, disposition, filename, size_bytes, blob_id, hydration_status)
            VALUES (${messageId}::uuid, ${String(partIndex + 2)}, 'image/png', ${disposition}, 'fixture.png', 1024, ${blob.id}::uuid, 'complete') RETURNING id`;
          if (!part) throw new Error("Missing metric attachment part");
          await sql`INSERT INTO mail.attachments (short_id, message_id, part_id, filename, content_type, disposition, size_bytes, blob_id)
            VALUES (${newShortId()}, ${messageId}::uuid, ${part.id}::uuid, 'fixture.png', 'image/png', ${disposition}, 1024, ${blob.id}::uuid)`;
        }
        for (let extra = 1; extra < scenario.messages; extra++) {
          const next = await ingest(9500 + index * 10 + extra);
          await sql`UPDATE mail.conversation_messages SET conversation_id = ${conversationId}::uuid
            WHERE message_id = ${next.snapshot.preconditions.message.id}::uuid`;
        }
        const snapshot = await getWorkflowSnapshot({ mailboxId, remoteMessageRefId: initial.remoteMessageRefId });
        if (!snapshot) throw new Error("Missing metric snapshot");
        expect(snapshot.source.message).toMatchObject({ isBulk: scenario.bulk, attachmentCount: 2, hasAttachments: true });
        expect(snapshot.source.conversation?.messageCount).toBe(scenario.messages);
        const emission = await emitWorkflowEvent(
          {
            appId: "mail",
            scopeId: mailboxId,
            type: "mail.messageReceived",
            targetWorkflowId: workflowId,
            data: { message: snapshot.source.message, conversation: snapshot.source.conversation },
            context: mailWorkflowEventContext(snapshot),
            dedupeKey: `metrics-${suffix}-${index}`,
            occurredAt: new Date("2026-01-15T12:00:00Z"),
          },
          { dispatch: "now" },
        );
        const runId = emission.runIds[0];
        if (!runId) throw new Error("Metric run was not dispatched");
        expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
        const [assignment] = await sql<{ tagged: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM mail.conversation_local_tags WHERE conversation_id = ${conversationId}::uuid AND tag_id = ${tag.data.id}::uuid
        ) AS tagged`;
        expect(assignment?.tagged).toBe(scenario.tagged);
      }
    } finally {
      const disabled = await deactivateWorkflow({
        context,
        mailboxId,
        workflowId,
        input: { expectedVersionId: created.data.currentVersion.id },
      });
      if (!disabled.ok) throw new Error(disabled.error.message);
    }
  });

  for (const [actionIndex, action] of placementActions.entries()) {
    for (const scenario of ["already moved", "pending move"] as const) {
      test(`${action} fails for a hand-written workflow with ${scenario}`, async () => {
        const uid = 8700 + actionIndex * 2 + (scenario === "pending move" ? 1 : 0);
        const { snapshot, remoteMessageRefId, messageId } = await ingest(uid);
        const activeWorkflows: { id: string; versionId: string }[] = [];
        const startRun = async (kind: PlacementAction) => {
          const created = await createWorkflow({
            context,
            mailboxId,
            input: {
              name: `${kind} ${scenario} ${suffix}`,
              priority: 100,
              source: `inputs:
  message: { type: mailMessage, required: true }
triggers:
  messageReceived:
    with: { message: "\${{ trigger.message }}" }
steps:
  - ${kind}: { message: inputs.message${kind === "moveMessage" ? ", folder: Archive" : ""} }
`,
              effectBudget: {
                maxTargets: 1,
                maxMoves: 1,
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
          const activated = await activateWorkflow({
            context,
            mailboxId,
            workflowId: created.data.id,
            input: { expectedVersionId: created.data.currentVersion.id },
          });
          if (!activated.ok) throw new Error(activated.error.message);
          activeWorkflows.push({ id: created.data.id, versionId: created.data.currentVersion.id });
          const emission = await emitWorkflowEvent(
            {
              appId: "mail",
              scopeId: mailboxId,
              type: "mail.messageReceived",
              targetWorkflowId: created.data.id,
              data: { message: snapshot.source.message },
              context: mailWorkflowEventContext(snapshot),
              dedupeKey: `placement-${created.data.id}`,
              occurredAt: new Date("2026-01-15T12:00:00Z"),
            },
            { dispatch: "now" },
          );
          const runId = emission.runIds[0];
          if (!runId) throw new Error("Placement workflow run was not dispatched");
          return runId;
        };
        let moved = false;
        const state = () => ({ exists: !moved, flags: [], keywords: [], messageId, modseq: "1" });
        const getState = spyOn(imapSmtpConnector, "getMessageState").mockImplementation(async () => state());
        const getStates = spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(
          async (_config, messages) => new Map(moved ? [] : messages.uids.map((id) => [id, state()] as const)),
        );
        const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
          uidValidity: "1",
          uidNext: 9700 + uid,
          highestModseq: null,
          messages: 0,
        });
        const move = spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (_config, messages) => {
          moved = true;
          return {
            completed: true,
            destinationUidValidity: "1",
            destinationUids: new Map(messages.uids.map((id) => [id, 9700 + uid])),
          };
        });
        try {
          const runId = await startRun(action);
          if (scenario === "already moved") {
            await sql`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${remoteMessageRefId}::uuid`;
            await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${remoteMessageRefId}::uuid`;
            expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "failed" } });
            expect(await getWorkflowRun(runId)).toMatchObject({
              state: "failed",
              error: { code: "NOT_FOUND", message: "Message provider target is no longer available" },
            });
            await expectNoSkippedOutcome(runId);
            expect(await commandsFor(runId)).toEqual([]);
            expect(move).not.toHaveBeenCalled();
          } else {
            const firstRunId = await startRun("moveMessage");
            expect(await runMailWorkflow(firstRunId)).toMatchObject({ state: "finished", result: { state: "waiting" } });
            const [firstCommand] = await commandsFor(firstRunId);
            expect(firstCommand).toMatchObject({ kind: "move", state: "queued" });
            expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "waiting" } });
            const commands = await commandsFor(runId);
            expect(commands).toHaveLength(1);
            const command = commands[0]!;
            expect(command).toMatchObject({ kind: "move", state: "queued" });
            expect(command.id).not.toBe(firstCommand!.id);
            await expectNoSkippedOutcome(runId);
            expect(move).not.toHaveBeenCalled();
            expect(await executeMutationCommand(firstCommand!.id)).toBe("confirmed");
            expect(await runMailWorkflow(firstRunId)).toMatchObject({ state: "finished", result: { state: "succeeded" } });
            expect(await executeMutationCommand(command.id)).toBe("failed");
            const [failedCommand] = await commandsFor(runId);
            expect(failedCommand).toMatchObject({ state: "failed" });
            expect(failedCommand!.last_error_code).toMatch(/^REMOTE_MESSAGE_(STALE|MISSING)$/);
            expect(await runMailWorkflow(runId)).toMatchObject({ state: "finished", result: { state: "failed" } });
            expect(await getWorkflowRun(runId)).toMatchObject({
              state: "failed",
              error: { code: "MAIL_COMMAND_FAILED", message: failedCommand!.last_error_message },
            });
            await expectNoSkippedOutcome(runId);
            expect(move).toHaveBeenCalledTimes(1);
          }
        } finally {
          move.mockRestore();
          status.mockRestore();
          getStates.mockRestore();
          getState.mockRestore();
          // Attempt every deactivation even if one fails.
          const disabled = await Promise.all(
            activeWorkflows.map((workflow) =>
              deactivateWorkflow({ context, mailboxId, workflowId: workflow.id, input: { expectedVersionId: workflow.versionId } }),
            ),
          );
          for (const result of disabled) if (!result.ok) throw new Error(result.error.message);
        }
      }, 15_000);
    }
  }
});
