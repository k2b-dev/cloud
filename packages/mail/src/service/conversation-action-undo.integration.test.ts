import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { encryptSecret, toPgTextArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { suiteFor } from "../../../../scripts/fixtures/test-infra";
import { MAIL_ACTION_OUTCOME_TTL_MS } from "../command-outcomes";
import type { CommandState } from "../contracts";
import { newShortId } from "../lib/short-id";
import { migrate } from "../migrate";
import { grantMailboxAccess } from "./access";
import type { MailRequestContext } from "./auth";
import { executeMutationCommand, finishUndoRequests, runMailboxCommandsJob } from "./command-runtime";
import { recordUndoRequests } from "./command-undo";
import { createActorCommands } from "./commands";
import { imapSmtpConnector } from "./connectors";
import { keepConversation } from "./conversation-keeps";
import { createMailbox } from "./mailboxes";
import { createConversationTriageCommands, undoConversationTriageCommands } from "./triage";

const suite = suiteFor("database", "nats");

suite("mail conversation action undo", () => {
  const suffix = crypto.randomUUID().slice(0, 8);
  let userId = "";
  let context: MailRequestContext;
  let mailboxId = "";
  let bindingId = "";
  let resourceId = "";
  let inboxId = "";
  let archiveId = "";
  let trashId = "";
  let reader: MailRequestContext;
  let readerId = "";
  let nextUid = 1;

  const addFolder = async (name: string, role: string) => {
    const [folder] = await sql<{ id: string }[]>`
      INSERT INTO mail.folders (short_id, remote_resource_id, stable_key, name, role, sync_status)
      VALUES (${newShortId()}, ${resourceId}::uuid, ${`${name}-${suffix}`}, ${name}, ${role}, 'current')
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.binding_folder_refs (
        binding_id, folder_id, remote_path, uid_validity, uid_next, effective_rights, last_verified_at
      ) VALUES (
        ${bindingId}::uuid, ${folder!.id}::uuid, ${name}, 1, 2,
        ARRAY['read', 'write_flags', 'insert', 'move', 'delete_messages']::text[], now()
      )
    `;
    return folder!.id;
  };

  const addCopy = async (params: { messageId: string; folderId: string; uid: number; flags: string[] }) => {
    const [ref] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_message_refs (folder_id, message_id, uid_validity, uid)
      VALUES (${params.folderId}::uuid, ${params.messageId}::uuid, 1, ${params.uid})
      RETURNING id
    `;
    await sql`
      INSERT INTO mail.message_placements (remote_message_ref_id, folder_id, message_id, flags, keywords)
      VALUES (${ref!.id}::uuid, ${params.folderId}::uuid, ${params.messageId}::uuid, ${toPgTextArray(params.flags)}::text[], ARRAY[]::text[])
    `;
    return ref!.id;
  };

  const addConversation = async (subject: string, messageIds: string[]) => {
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO mail.conversations (short_id, mailbox_id, subject, participant_summary, latest_message_at, work_status)
      VALUES (${newShortId()}, ${mailboxId}::uuid, ${subject}, 'customer@example.test', now(), 'needs_action')
      RETURNING id
    `;
    for (const [index, messageId] of messageIds.entries()) {
      await sql`
        INSERT INTO mail.conversation_messages (conversation_id, message_id, position, added_by)
        VALUES (${conversation!.id}::uuid, ${messageId}::uuid, ${index + 1}, 'headers')
      `;
    }
    return conversation!.id;
  };

  const addMessage = async (params: { folderId: string; subject: string; minutesAgo: number; uid?: number; flags?: string[] }) => {
    const [message] = await sql<{ id: string }[]>`
      INSERT INTO mail.message_contents (short_id,
        mailbox_id, message_id, subject, normalized_subject, internal_date, size_bytes, content_hash, hydration_status, plain_text
      ) VALUES (${newShortId()}, ${mailboxId}::uuid, ${`<${crypto.randomUUID()}@example.test>`}, ${params.subject},
        ${params.subject.toLowerCase()}, now() - make_interval(mins => ${params.minutesAgo}), 128,
        ${crypto.randomUUID().replaceAll("-", "").padEnd(64, "0")}, 'complete', ${params.subject})
      RETURNING id
    `;
    await addCopy({ messageId: message!.id, folderId: params.folderId, uid: params.uid ?? nextUid++, flags: params.flags ?? ["\\Seen"] });
    return message!.id;
  };

  beforeAll(async () => {
    await migrate();
    const uid = `mail-conversation-action-undo-${suffix}`;
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${uid}, 'local', 'user', 'Action Owner', false)
      RETURNING id
    `;
    userId = user!.id;
    context = {
      actor: {
        kind: "user",
        user: {
          id: userId,
          uid,
          provider: "local",
          profile: "user",
          displayName: "Action Owner",
          givenName: "Action",
          sn: "Owner",
          mail: `${uid}@example.test`,
          roles: ["user"],
          memberofGroupIds: [],
          memberofGroups: [],
        } as never,
      },
      accessSubject: { type: "user", userId },
      requestId: `mail-conversation-action-undo-${suffix}`,
    };
    const mailbox = await createMailbox(context, { name: `Conversation actions ${suffix}`, description: null });
    if (!mailbox.ok) throw new Error(mailbox.error.message);
    mailboxId = mailbox.data.id;

    const scope = "d".repeat(64);
    const [connection] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_connections (
        owner_mailbox_id, name, email, username, imap_host, imap_port, imap_tls_mode,
        smtp_host, smtp_port, smtp_tls_mode, secret_kind, encrypted_secret,
        authenticated_principal, capabilities, server_identity, last_verified_at
      ) VALUES (
        ${mailboxId}::uuid, 'IMAP', 'team@example.test', 'team@example.test',
        'imap.example.test', 993, 'implicit', 'smtp.example.test', 587, 'starttls',
        'password', ${await encryptSecret({ kind: "password", password: "conversation-actions-secret" })},
        'team@example.test', '{}'::jsonb, '{}'::jsonb, now()
      ) RETURNING id
    `;
    const [resource] = await sql<{ id: string }[]>`
      INSERT INTO mail.remote_resources (mailbox_id, remote_locator, server_identity, scope_fingerprint, status)
      VALUES (${mailboxId}::uuid, '{}'::jsonb, '{}'::jsonb, ${scope}, 'active')
      RETURNING id
    `;
    resourceId = resource!.id;
    const [binding] = await sql<{ id: string }[]>`
      INSERT INTO mail.provider_bindings (
        remote_resource_id, connection_id, state, remote_locator, capabilities, rights,
        verification_evidence, verified_scope_fingerprint, last_verified_at
      ) VALUES (
        ${resourceId}::uuid, ${connection!.id}::uuid, 'active', '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${scope}, now()
      ) RETURNING id
    `;
    bindingId = binding!.id;
    inboxId = await addFolder("INBOX", "inbox");
    archiveId = await addFolder("Archive", "archive");
    trashId = await addFolder("Trash", "trash");
    const [readUser] = await sql<{ id: string }[]>`
      INSERT INTO auth.users (uid, provider, profile, display_name, admin)
      VALUES (${`undo-reader-${suffix}`}, 'local', 'user', 'Undo Reader', false) RETURNING id
    `;
    readerId = readUser!.id;
    if (context.actor.kind !== "user") throw new Error("Fixture actor is not a user");
    reader = {
      ...context,
      actor: { kind: "user", user: { ...context.actor.user, id: readerId } },
      accessSubject: { type: "user", userId: readerId },
    };
    const grant = await grantMailboxAccess({ context, mailboxId, principal: reader.accessSubject, permission: "read" });
    if (!grant.ok) throw new Error(grant.error.message);
  });

  afterAll(async () => {
    if (mailboxId) {
      const access = await sql<{ access_id: string }[]>`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${mailboxId}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${mailboxId}::uuid`;
      const accessIds = access.map((row) => row.access_id);
      if (accessIds.length > 0)
        await sql`DELETE FROM auth.access WHERE id IN (SELECT value::uuid FROM jsonb_array_elements_text(${accessIds}::jsonb))`;
    }
    if (userId) await sql`DELETE FROM auth.users WHERE id = ${userId}::uuid`;
    if (readerId) await sql`DELETE FROM auth.users WHERE id = ${readerId}::uuid`;
  });

  const fixture = async (state: CommandState = "queued", sourceFolderId = inboxId, copies = 1) => {
    const messageId = await addMessage({ folderId: sourceFolderId, subject: crypto.randomUUID(), minutesAgo: 1 });
    for (let index = 1; index < copies; index++) await addCopy({ messageId, folderId: sourceFolderId, uid: nextUid++, flags: [] });
    const conversationId = await addConversation("Undo action", [messageId]);
    const action = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId,
      input: {
        kind: "move_to_folder",
        sourceFolderId,
        destinationFolderId: archiveId,
        idempotencyKey: crypto.randomUUID(),
        correlationId: crypto.randomUUID(),
      },
    });
    if (!action.ok) throw new Error(action.error.message);
    const command = action.data.commands[0]!;
    const [stored] = await sql<{ target: { remoteMessageRefId: string } }[]>`
      SELECT target FROM mail.commands WHERE id = ${command.id}::uuid
    `;
    for (const command of action.data.commands) {
      if (state !== "queued") await sql`UPDATE mail.commands SET state = ${state} WHERE id = ${command.id}::uuid`;
    }
    return {
      messageId,
      conversationId,
      commandId: command.id,
      commandIds: action.data.commands.map((command) => command.id),
      refId: stored!.target.remoteMessageRefId,
      correlationId: action.data.correlationId,
    };
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  const undo = (row: Fixture, commandIds = [row.commandId], actor = context) =>
    undoConversationTriageCommands({ context: actor, mailboxId, conversationId: row.conversationId, input: { commandIds } });
  const snapshot = async (commandId: string) => (await sql`SELECT * FROM mail.commands WHERE id = ${commandId}::uuid`)[0];
  const destinationCopy = async (row: Fixture) => {
    // The runtime stales the source and either projects COPYUID or waits for sync to find this copy.
    await sql`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${row.refId}::uuid`;
    await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${row.refId}::uuid`;
    return addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: ["\\Seen"] });
  };
  const outcome = async (row: Fixture) => {
    const result = await undo(row);
    if (!result.ok) throw new Error(result.error.message);
    return result.data.commands[0]!;
  };

  const undoRecords = (row: Fixture) => sql<{ outcome: string | null; inverse_command_id: string | null }[]>`
    SELECT outcome, inverse_command_id FROM mail.command_undo_requests WHERE command_id = ${row.commandId}::uuid
  `;
  const inverseCommands = (row: Fixture) => sql<{ id: string }[]>`
    SELECT id FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid AND idempotency_key = ${`undo:${row.commandId}`}
  `;

  test("the runtime turn finishes an Undo requested while the provider is moving the message", async () => {
    const row = await fixture();
    const [message] = await sql<{ message_id: string }[]>`SELECT message_id FROM mail.message_contents WHERE id = ${row.messageId}::uuid`;
    const destinationUid = nextUid++;
    let moved = false;
    await sql`UPDATE mail.provider_bindings SET capabilities = '{"move": true}'::jsonb WHERE id = ${bindingId}::uuid`;
    const session = spyOn(imapSmtpConnector, "withSession").mockImplementation(async (config, work) => work(config));
    const status = spyOn(imapSmtpConnector, "getFolderStatus").mockResolvedValue({
      uidValidity: "1",
      uidNext: destinationUid,
      highestModseq: null,
      messages: 0,
    });
    const states = spyOn(imapSmtpConnector, "getMessageStates").mockImplementation(
      async (_, messages) =>
        new Map(
          moved
            ? []
            : messages.uids.map(
                (uid) =>
                  [
                    uid,
                    {
                      exists: true,
                      flags: ["\\Seen"],
                      keywords: [],
                      messageId: message!.message_id,
                      modseq: "1",
                    },
                  ] as const,
              ),
        ),
    );
    const move = spyOn(imapSmtpConnector, "moveMessages").mockImplementation(async (_, messages) => {
      expect((await snapshot(row.commandId)).state).toBe("executing");
      expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "pending", inverse: null });
      expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
      moved = true;
      return { completed: true, destinationUidValidity: "1", destinationUids: new Map(messages.uids.map((uid) => [uid, destinationUid])) };
    });
    try {
      await runMailboxCommandsJob({ input: { mailboxId }, heartbeat: async () => {}, resubmit: () => {} });
      expect(move).toHaveBeenCalledTimes(1);
      expect((await snapshot(row.commandId)).state).toBe("confirmed");
      const inverses = await inverseCommands(row);
      expect(inverses).toHaveLength(1);
      const [copy] = await sql<{ id: string }[]>`
        SELECT id FROM mail.remote_message_refs WHERE connector_ref ->> 'commandId' = ${row.commandId}
      `;
      expect(copy).toBeDefined();
      expect(await snapshot(inverses[0]!.id)).toMatchObject({ state: "queued", target: { remoteMessageRefId: copy!.id } });
      expect(await undoRecords(row)).toEqual([{ outcome: "reversed", inverse_command_id: inverses[0]!.id }]);
    } finally {
      move.mockRestore();
      states.mockRestore();
      status.mockRestore();
      session.mockRestore();
      await sql`UPDATE mail.provider_bindings SET capabilities = '{}'::jsonb WHERE id = ${bindingId}::uuid`;
    }
  });

  test("finishes a recorded executing Undo without another client request and pins the command-created copy", async () => {
    const row = await fixture("executing");
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "pending", inverse: null });
    expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
    const refId = await destinationCopy(row);
    await sql`UPDATE mail.remote_message_refs SET connector_ref = ${{ source: "command", commandId: row.commandId }}::jsonb WHERE id = ${refId}::uuid`;
    await sql`UPDATE mail.message_placements SET updated_at = now() - interval '1 hour' WHERE remote_message_ref_id = ${refId}::uuid`;
    await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] });
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now(), updated_at = now() WHERE id = ${row.commandId}::uuid`;
    await finishUndoRequests({ mailboxId });
    const inverses = await inverseCommands(row);
    expect(inverses).toHaveLength(1);
    expect(await snapshot(inverses[0]!.id)).toMatchObject({ state: "queued", target: { remoteMessageRefId: refId } });
    expect(await outcome(row)).toEqual({
      id: row.commandId,
      outcome: "reversed",
      inverse: { id: inverses[0]!.id, state: "queued", code: null },
    });
    expect(await inverseCommands(row)).toEqual(inverses);
  });

  test("a recorded Undo resolves not_applied when the executing original fails or is cancelled", async () => {
    for (const state of ["failed", "cancelled"]) {
      const row = await fixture("executing");
      expect((await outcome(row)).outcome).toBe("pending");
      await sql`UPDATE mail.commands SET state = ${state}, finished_at = now() WHERE id = ${row.commandId}::uuid`;
      await finishUndoRequests({ mailboxId });
      expect(await undoRecords(row)).toEqual([{ outcome: "not_applied", inverse_command_id: null }]);
      expect(await inverseCommands(row)).toEqual([]);
      expect((await outcome(row)).outcome).toBe("not_applied");
    }
  });

  test("concurrent Undo clients and a resolver create one record and one inverse", async () => {
    const row = await fixture("confirmed");
    await destinationCopy(row);
    await sql.begin((tx) => recordUndoRequests(tx, [row.commandId]));
    const [first, second] = await Promise.all([outcome(row), outcome(row), finishUndoRequests({ mailboxId })]);
    expect(first).toEqual(second);
    expect(first.outcome).toBe("reversed");
    expect(await undoRecords(row)).toEqual([{ outcome: "reversed", inverse_command_id: first.inverse!.id }]);
    expect(await inverseCommands(row)).toEqual([{ id: first.inverse!.id }]);
  });

  test("the sweep recovers a recorded Undo after the original already settled", async () => {
    const row = await fixture("confirmed");
    await destinationCopy(row);
    await sql.begin((tx) => recordUndoRequests(tx, [row.commandId]));
    await finishUndoRequests({});
    const inverses = await inverseCommands(row);
    expect(inverses).toHaveLength(1);
    expect(await undoRecords(row)).toEqual([{ outcome: "reversed", inverse_command_id: inverses[0]!.id }]);
  });

  test("the sweep waits for a synced destination copy and resolves it after the copy appears", async () => {
    const row = await fixture("confirmed");
    expect((await outcome(row)).outcome).toBe("pending");
    await finishUndoRequests({});
    expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
    expect(await inverseCommands(row)).toEqual([]);
    await destinationCopy(row);
    await finishUndoRequests({});
    expect(await undoRecords(row)).toEqual([{ outcome: "reversed", inverse_command_id: (await inverseCommands(row))[0]!.id }]);
  });

  test("the sweep stops waiting for a copy 15 minutes after settlement, not after the Undo request", async () => {
    const row = await fixture("executing");
    expect((await outcome(row)).outcome).toBe("pending");
    await sql`UPDATE mail.command_undo_requests SET requested_at = now() - interval '1 hour' WHERE command_id = ${row.commandId}::uuid`;
    await finishUndoRequests({});
    expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now(), updated_at = now() WHERE id = ${row.commandId}::uuid`;
    await finishUndoRequests({});
    expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
    await sql`UPDATE mail.commands SET finished_at = now() - make_interval(secs => ${(MAIL_ACTION_OUTCOME_TTL_MS + 1_000) / 1_000})
      WHERE id = ${row.commandId}::uuid`;
    await finishUndoRequests({});
    expect(await undoRecords(row)).toEqual([{ outcome: "unavailable", inverse_command_id: null }]);
    expect(await inverseCommands(row)).toEqual([]);
    expect((await outcome(row)).outcome).toBe("unavailable");
  });

  test("refuses a recorded inverse when write access was revoked before settlement", async () => {
    const row = await fixture("executing");
    expect((await outcome(row)).outcome).toBe("pending");
    await destinationCopy(row);
    await sql`UPDATE mail.commands SET state = 'confirmed', finished_at = now() WHERE id = ${row.commandId}::uuid`;
    const grants = await sql<{ id: string; permission: string }[]>`
      SELECT a.id, a.permission FROM auth.access a JOIN mail.mailbox_access ma ON ma.access_id = a.id
      WHERE ma.mailbox_id = ${mailboxId}::uuid AND a.user_id = ${userId}::uuid
    `;
    expect(grants.length).toBeGreaterThan(0);
    try {
      for (const grant of grants) await sql`UPDATE auth.access SET permission = 'read' WHERE id = ${grant.id}::uuid`;
      await finishUndoRequests({ mailboxId });
      expect(await undoRecords(row)).toEqual([{ outcome: "unavailable", inverse_command_id: null }]);
      expect(await inverseCommands(row)).toEqual([]);
    } finally {
      for (const grant of grants) await sql`UPDATE auth.access SET permission = ${grant.permission} WHERE id = ${grant.id}::uuid`;
    }
  });

  test("cancels a queued move without changing its placement and prevents a later runtime claim", async () => {
    const row = await fixture();
    const placement = (await sql`SELECT * FROM mail.message_placements WHERE remote_message_ref_id = ${row.refId}::uuid`)[0];
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "cancelled", inverse: null });
    expect(await snapshot(row.commandId)).toMatchObject({
      state: "cancelled",
      last_error_code: "UNDONE",
      last_error_message: "The action was undone before it ran",
      attempt: 0,
    });
    expect((await snapshot(row.commandId)).finished_at).not.toBeNull();
    expect((await sql`SELECT * FROM mail.message_placements WHERE remote_message_ref_id = ${row.refId}::uuid`)[0]).toEqual(placement);
    expect(await executeMutationCommand(row.commandId)).toBeNull();
    expect((await snapshot(row.commandId)).attempt).toBe(0);
    expect(
      await sql<
        { action: string; outcome: string; metadata: Record<string, unknown> }[]
      >`SELECT action, outcome, metadata FROM mail.activity_events
      WHERE command_id = ${row.commandId}::uuid AND action = 'command.execute'`,
    ).toEqual([{ action: "command.execute", outcome: "failed", metadata: { state: "cancelled", code: "UNDONE" } }]);
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "not_applied", inverse: null });
  });

  test("reverses a confirmed move on the moved copy and replays the same inverse command", async () => {
    const row = await fixture("confirmed");
    const olderRefId = await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] });
    await sql`UPDATE mail.message_placements SET updated_at = now() - interval '1 hour'
      WHERE remote_message_ref_id = ${olderRefId}::uuid`;
    const refId = await destinationCopy(row);
    const first = await outcome(row);
    expect(first.outcome).toBe("reversed");
    expect(first.inverse).toMatchObject({ state: "queued", code: null });
    expect(await snapshot(first.inverse!.id)).toMatchObject({
      kind: "move",
      idempotency_key: `undo:${row.commandId}`,
      correlation_id: row.correlationId,
      target: { remoteMessageRefId: refId, sourceFolderId: archiveId, destinationFolderId: inboxId },
    });
    expect(await outcome(row)).toEqual(first);
    expect(
      await sql<{ id: string }[]>`SELECT id FROM mail.commands WHERE mailbox_id = ${mailboxId}::uuid
      AND idempotency_key = ${`undo:${row.commandId}`}`,
    ).toEqual([{ id: first.inverse!.id }]);
  });

  test("a server-created inverse replays through the public actor command path", async () => {
    const row = await fixture("confirmed");
    const refId = await destinationCopy(row);
    const first = await outcome(row);
    expect(first.outcome).toBe("reversed");
    const replay = await createActorCommands({
      context,
      mailboxId,
      inputs: [
        {
          kind: "move",
          messageId: row.messageId,
          remoteMessageRefId: refId,
          sourceFolderId: archiveId,
          destinationFolderId: inboxId,
          idempotencyKey: `undo:${row.commandId}`,
        },
      ],
    });
    if (!replay.ok) throw new Error(replay.error.message);
    expect(replay.data.map((command) => command.id)).toEqual([first.inverse!.id]);
    expect(await inverseCommands(row)).toEqual([{ id: first.inverse!.id }]);
    const events = await sql<{ metadata: { undoOf: string; correlationId: string } }[]>`
      SELECT metadata FROM mail.activity_events WHERE command_id = ${first.inverse!.id}::uuid AND action = 'command.move'
    `;
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ undoOf: row.commandId, correlationId: row.correlationId });
  });

  test("pins two inverses of one message to distinct moved copies, including separate Undo requests", async () => {
    for (const separateRequests of [false, true]) {
      const row = await fixture("confirmed", inboxId, 2);
      expect(row.commandIds).toHaveLength(2);
      for (const id of row.commandIds) {
        const [original] = await sql<{ target: { remoteMessageRefId: string } }[]>`SELECT target FROM mail.commands WHERE id = ${id}::uuid`;
        await sql`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${original!.target.remoteMessageRefId}::uuid`;
        await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${original!.target.remoteMessageRefId}::uuid`;
      }
      const refs = [
        await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] }),
        await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] }),
      ];
      const batches = separateRequests ? row.commandIds.map((id) => [id]) : [row.commandIds];
      const inverseRefs: string[] = [];
      for (const commandIds of batches) {
        const result = await undo(row, commandIds);
        if (!result.ok) throw new Error(result.error.message);
        expect(result.data.commands.every((command) => command.outcome === "reversed")).toBe(true);
        for (const command of result.data.commands) {
          const [inverse] = await sql<
            { target: { remoteMessageRefId: string } }[]
          >`SELECT target FROM mail.commands WHERE id = ${command.inverse!.id}::uuid`;
          inverseRefs.push(inverse!.target.remoteMessageRefId);
        }
      }
      expect(new Set(inverseRefs).size).toBe(2);
      expect(inverseRefs.sort()).toEqual(refs.sort());
    }
  });

  test("prefers the command-created moved copy over a newer unrelated destination copy", async () => {
    const row = await fixture("confirmed");
    const refId = await destinationCopy(row);
    await sql`UPDATE mail.remote_message_refs SET connector_ref = ${{ source: "command", commandId: row.commandId }}::jsonb WHERE id = ${refId}::uuid`;
    await sql`UPDATE mail.message_placements SET updated_at = now() - interval '1 hour' WHERE remote_message_ref_id = ${refId}::uuid`;
    await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] });
    const result = await outcome(row);
    expect(result.outcome).toBe("reversed");
    expect(await snapshot(result.inverse!.id)).toMatchObject({ target: { remoteMessageRefId: refId } });
  });

  test("does not take a destination ref already targeted by another unfinished move", async () => {
    const row = await fixture("confirmed");
    const refId = await destinationCopy(row);
    const laterMove = await createActorCommands({
      context,
      mailboxId,
      inputs: [
        {
          kind: "move",
          messageId: row.messageId,
          remoteMessageRefId: refId,
          sourceFolderId: archiveId,
          destinationFolderId: trashId,
          idempotencyKey: crypto.randomUUID(),
        },
      ],
    });
    if (!laterMove.ok) throw new Error(laterMove.error.message);
    expect(await outcome(row)).toMatchObject({ outcome: "pending", inverse: null });
    const fallback = await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] });
    const result = await outcome(row);
    expect(result.outcome).toBe("reversed");
    expect(await snapshot(result.inverse!.id)).toMatchObject({ target: { remoteMessageRefId: fallback } });
  });

  test("reserves command-created refs before assigning fallback refs to other original moves", async () => {
    const row = await fixture("confirmed", inboxId, 2);
    const refId = await destinationCopy(row);
    // The command ordered last owns the only projected copy; the first must fall back to the unrelated one.
    const lastCommandId = [...row.commandIds].sort().at(-1)!;
    await sql`UPDATE mail.remote_message_refs SET connector_ref = ${{ source: "command", commandId: lastCommandId }}::jsonb WHERE id = ${refId}::uuid`;
    const fallback = await addCopy({ messageId: row.messageId, folderId: archiveId, uid: nextUid++, flags: [] });
    await sql`UPDATE mail.message_placements SET updated_at = now() - interval '1 hour' WHERE remote_message_ref_id = ${fallback}::uuid`;
    const result = await undo(row, row.commandIds);
    if (!result.ok) throw new Error(result.error.message);
    for (const command of result.data.commands) {
      expect(command.outcome).toBe("reversed");
      expect(await snapshot(command.inverse!.id)).toMatchObject({
        target: { remoteMessageRefId: command.id === lastCommandId ? refId : fallback },
      });
    }
  });

  test("answers pending for an extra original move when all destination copies are already assigned", async () => {
    const row = await fixture("confirmed", inboxId, 2);
    await destinationCopy(row);
    const result = await undo(row, row.commandIds);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.commands.map((command) => command.outcome).sort()).toEqual(["pending", "reversed"]);
    const pending = result.data.commands.find((command) => command.outcome === "pending")!;
    const retry = await undo(row, [pending.id]);
    if (!retry.ok) throw new Error(retry.error.message);
    expect(retry.data.commands[0]?.outcome).toBe("pending");
  });

  test("replays a completed inverse even after its source placement disappeared", async () => {
    const row = await fixture("confirmed");
    const refId = await destinationCopy(row);
    const first = await outcome(row);
    await sql`UPDATE mail.commands SET state = 'confirmed' WHERE id = ${first.inverse!.id}::uuid`;
    await sql`UPDATE mail.remote_message_refs SET stale_at = now() WHERE id = ${refId}::uuid`;
    await sql`UPDATE mail.message_placements SET deleted_at = now() WHERE remote_message_ref_id = ${refId}::uuid`;
    expect(await outcome(row)).toEqual({
      id: row.commandId,
      outcome: "reversed",
      inverse: { id: first.inverse!.id, state: "confirmed", code: null },
    });
  });

  test("records Undo for an executing move without changing the original", async () => {
    const row = await fixture("executing");
    const before = await snapshot(row.commandId);
    const events = await sql`SELECT * FROM mail.activity_events WHERE command_id = ${row.commandId}::uuid`;
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "pending", inverse: null });
    expect(await snapshot(row.commandId)).toEqual(before);
    expect(await sql`SELECT * FROM mail.activity_events WHERE command_id = ${row.commandId}::uuid`).toEqual(events);
    expect(await undoRecords(row)).toEqual([{ outcome: null, inverse_command_id: null }]);
  });

  test("answers pending for an ambiguous move without changing it", async () => {
    const row = await fixture("ambiguous");
    const before = await snapshot(row.commandId);
    expect((await outcome(row)).outcome).toBe("pending");
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("does not cancel a queued move whose provider effect already started", async () => {
    const row = await fixture();
    await sql`UPDATE mail.commands SET provider_effect_started_at = now(), provider_effect_attempt = 1, attempt = 1 WHERE id = ${row.commandId}::uuid`;
    const before = await snapshot(row.commandId);
    expect((await outcome(row)).outcome).toBe("pending");
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("waits for the confirmed move's destination copy before queuing its inverse", async () => {
    const row = await fixture("confirmed");
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "pending", inverse: null });
    await destinationCopy(row);
    expect((await outcome(row)).outcome).toBe("reversed");
  });

  test("reverses a reconciled move through the same actor command path", async () => {
    const row = await fixture("reconciled");
    await destinationCopy(row);
    expect((await outcome(row)).outcome).toBe("reversed");
  });

  test("answers not_applied for a failed move", async () => {
    const row = await fixture("failed");
    const before = await snapshot(row.commandId);
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "not_applied", inverse: null });
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("answers unavailable for a move that needs attention", async () => {
    const row = await fixture("needs_attention");
    const before = await snapshot(row.commandId);
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "unavailable", inverse: null });
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("answers unavailable when keeping the conversation refuses an inverse back into Trash", async () => {
    const row = await fixture("confirmed", trashId);
    await destinationCopy(row);
    const kept = await keepConversation({ context, mailboxId, conversationId: row.conversationId });
    if (!kept.ok) throw new Error(kept.error.message);
    expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "unavailable", inverse: null });
    expect(await sql<{ id: string }[]>`SELECT id FROM mail.commands WHERE idempotency_key = ${`undo:${row.commandId}`}`).toEqual([]);
  });

  test("answers unavailable when provider folder rights no longer allow the inverse", async () => {
    const row = await fixture("confirmed");
    await destinationCopy(row);
    const [rights] = await sql<{ effective_rights: string[] }[]>`
      SELECT effective_rights FROM mail.binding_folder_refs WHERE binding_id = ${bindingId}::uuid AND folder_id = ${archiveId}::uuid
    `;
    try {
      await sql`UPDATE mail.binding_folder_refs SET effective_rights = ARRAY['read']::text[]
        WHERE binding_id = ${bindingId}::uuid AND folder_id = ${archiveId}::uuid`;
      expect(await outcome(row)).toEqual({ id: row.commandId, outcome: "unavailable", inverse: null });
      expect(await sql<{ id: string }[]>`SELECT id FROM mail.commands WHERE idempotency_key = ${`undo:${row.commandId}`}`).toEqual([]);
    } finally {
      await sql`UPDATE mail.binding_folder_refs SET effective_rights = ${toPgTextArray(rights!.effective_rights)}::text[]
        WHERE binding_id = ${bindingId}::uuid AND folder_id = ${archiveId}::uuid`;
    }
  });

  test("keeps successful inverses when another move in the request cannot be reversed", async () => {
    const refused = await fixture("confirmed", trashId);
    const reversible = await fixture("confirmed");
    const conversationId = await addConversation("Independent inverses", []);
    for (const row of [refused, reversible]) {
      await sql`UPDATE mail.conversation_messages SET conversation_id = ${conversationId}::uuid WHERE message_id = ${row.messageId}::uuid`;
      await destinationCopy(row);
    }
    const kept = await keepConversation({ context, mailboxId, conversationId });
    if (!kept.ok) throw new Error(kept.error.message);
    const result = await undo({ ...refused, conversationId }, [refused.commandId, reversible.commandId]);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.commands.map((command) => command.outcome)).toEqual(["unavailable", "reversed"]);
    expect(await snapshot(result.data.commands[1]!.inverse!.id)).toMatchObject({ kind: "move", state: "queued" });
    expect(await sql<{ id: string }[]>`SELECT id FROM mail.commands WHERE idempotency_key = ${`undo:${refused.commandId}`}`).toEqual([]);
  });

  test("refuses a command from another conversation before cancelling any command", async () => {
    const row = await fixture();
    const other = await fixture();
    const before = await snapshot(row.commandId);
    const otherBefore = await snapshot(other.commandId);
    expect(await undo(row, [row.commandId, other.commandId])).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Mail command not found" },
    });
    expect(await snapshot(row.commandId)).toEqual(before);
    expect(await snapshot(other.commandId)).toEqual(otherBefore);
  });

  test("refuses a command of another mailbox without changing it", async () => {
    const row = await fixture();
    const other = await createMailbox(context, { name: `Other undo mailbox ${suffix}` });
    if (!other.ok) throw new Error(other.error.message);
    try {
      await sql`UPDATE mail.commands SET mailbox_id = ${other.data.id}::uuid WHERE id = ${row.commandId}::uuid`;
      const before = await snapshot(row.commandId);
      expect(await undo(row)).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "Mail command not found" } });
      expect(await snapshot(row.commandId)).toEqual(before);
    } finally {
      await sql`UPDATE mail.commands SET mailbox_id = ${mailboxId}::uuid WHERE id = ${row.commandId}::uuid`;
      const grants = await sql<
        { access_id: string }[]
      >`SELECT access_id FROM mail.mailbox_access WHERE mailbox_id = ${other.data.id}::uuid`;
      await sql`DELETE FROM mail.mailboxes WHERE id = ${other.data.id}::uuid`;
      for (const grant of grants) await sql`DELETE FROM auth.access WHERE id = ${grant.access_id}::uuid`;
    }
  });

  test("refuses a command created by another actor without changing it", async () => {
    const row = await fixture();
    await sql`UPDATE mail.commands SET actor_id = ${readerId}::uuid WHERE id = ${row.commandId}::uuid`;
    const before = await snapshot(row.commandId);
    expect(await undo(row)).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "Mail command not found" } });
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("refuses mark-read commands without changing their local projection", async () => {
    const row = await fixture();
    const read = await createConversationTriageCommands({
      context,
      mailboxId,
      conversationId: row.conversationId,
      input: {
        kind: "change_state",
        sourceFolderId: inboxId,
        idempotencyKey: crypto.randomUUID(),
        change: { addFlags: ["seen"], removeFlags: [], addKeywords: [], removeKeywords: [] },
      },
    });
    if (!read.ok) throw new Error(read.error.message);
    const commandId = read.data.commands[0]!.id;
    const before = await snapshot(commandId);
    const placement = (await sql`SELECT * FROM mail.message_placements WHERE remote_message_ref_id = ${row.refId}::uuid`)[0];
    expect(await undo(row, [commandId])).toMatchObject({ ok: false, error: { code: "NOT_FOUND", message: "Mail command not found" } });
    expect(await snapshot(commandId)).toEqual(before);
    expect((await sql`SELECT * FROM mail.message_placements WHERE remote_message_ref_id = ${row.refId}::uuid`)[0]).toEqual(placement);
  });

  test("refuses a read-only member without changing the command", async () => {
    const row = await fixture();
    const before = await snapshot(row.commandId);
    expect(await undo(row, [row.commandId], reader)).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("refuses unknown command IDs before cancelling a known command", async () => {
    const row = await fixture();
    const before = await snapshot(row.commandId);
    expect(await undo(row, [row.commandId, crypto.randomUUID()])).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND", message: "Mail command not found" },
    });
    expect(await snapshot(row.commandId)).toEqual(before);
  });

  test("preserves request order for mixed outcomes including repeated command IDs", async () => {
    const rows = await Promise.all([fixture("failed"), fixture("confirmed"), fixture(), fixture("executing")]);
    const conversationId = await addConversation("Mixed undo", []);
    for (const row of rows) {
      await sql`UPDATE mail.conversation_messages SET conversation_id = ${conversationId}::uuid
        WHERE message_id = ${row.messageId}::uuid`;
    }
    await destinationCopy(rows[1]!);
    const ids = [rows[3]!.commandId, rows[1]!.commandId, rows[2]!.commandId, rows[0]!.commandId, rows[2]!.commandId];
    const result = await undo({ ...rows[0]!, conversationId }, ids);
    if (!result.ok) throw new Error(result.error.message);
    expect(result.data.commands.map((command) => command.id)).toEqual(ids);
    expect(result.data.commands.map((command) => command.outcome)).toEqual([
      "pending",
      "reversed",
      "cancelled",
      "not_applied",
      "cancelled",
    ]);
  });
});
