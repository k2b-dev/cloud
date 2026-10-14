import { audit, logger, toPgTextArray, toPgUuidArray } from "@k2b/cloud/services";
import { sql } from "bun";
import { MAIL_ACTION_OUTCOME_TTL_MS, MAX_CONVERSATION_ACTION_MESSAGES } from "../command-outcomes";
import type { CommandState } from "../contracts";
import { sha256Json } from "./canonical";
import { commandStillAuthorized, type StoredCommandAuthorization } from "./command-authorization";
import { checkCommandKeepProtection } from "./conversation-keep-rules";
import { resolveMailExecution } from "./execution";

type UndoOriginal = StoredCommandAuthorization & {
  state: CommandState;
  delegated_user_id: string | null;
  correlation_id: string | null;
  message_id: string | null;
  source_folder_id: string;
  destination_folder_id: string;
  settled_at: Date | string;
  outcome: string | null;
};

type UndoFilter = { mailboxId?: string; commandIds?: string[] };

const log = logger("mail:commands");

export const recordUndoRequests = async (tx: typeof sql, commandIds: string[]): Promise<void> => {
  if (commandIds.length === 0) return;
  await tx`
    INSERT INTO mail.command_undo_requests (command_id)
    SELECT unnest(${toPgUuidArray(commandIds)}::uuid[])
    ON CONFLICT (command_id) DO NOTHING
  `;
};

const resolveUndoRequest = async (commandId: string, mailboxId: string): Promise<string | null> =>
  sql.begin(async (tx) => {
    // Command creation takes this lock first; it also serializes destination-copy selection and queue positions.
    const [mailbox] = await tx<{ id: string }[]>`
      SELECT id FROM mail.mailboxes WHERE id = ${mailboxId}::uuid AND deleted_at IS NULL FOR UPDATE
    `;
    const [original] = await tx<UndoOriginal[]>`
      SELECT c.id, c.mailbox_id, c.kind, c.state, c.target, c.actor_kind, c.actor_id, c.delegated_user_id,
        c.initiator_actor_kind, c.initiator_actor_id, c.access_subject_kind, c.access_subject_id,
        c.credential_scopes, c.credential_id, c.credential_expires_at, c.correlation_id,
        request.outcome, ref.message_id,
        c.target ->> 'sourceFolderId' AS source_folder_id,
        c.target ->> 'destinationFolderId' AS destination_folder_id,
        COALESCE(c.finished_at, c.updated_at) AS settled_at
      FROM mail.command_undo_requests request
      JOIN mail.commands c ON c.id = request.command_id
      LEFT JOIN mail.remote_message_refs ref ON ref.id = (c.target ->> 'remoteMessageRefId')::uuid
      WHERE request.command_id = ${commandId}::uuid
      FOR UPDATE OF request
    `;
    if (!original || original.outcome !== null) return null;
    const finish = async (outcome: "reversed" | "not_applied" | "unavailable", inverseId: string | null = null) => {
      await tx`
        UPDATE mail.command_undo_requests SET outcome = ${outcome}, inverse_command_id = ${inverseId}::uuid
        WHERE command_id = ${commandId}::uuid
      `;
    };
    if (!mailbox) {
      await finish("unavailable");
      return null;
    }
    if (original.state === "failed" || original.state === "cancelled") {
      await finish("not_applied");
      return null;
    }
    if (original.state === "needs_attention") {
      await finish("unavailable");
      return null;
    }
    if (original.state !== "confirmed" && original.state !== "reconciled") return null;

    const idempotencyKey = `undo:${commandId}`;
    // Replays work even after a completed inverse removed its source placement.
    const replay = async (): Promise<boolean> => {
      const [inverse] = await tx<
        {
          id: string;
          actor_kind: string;
          actor_id: string | null;
          kind: string;
          message_id: string | null;
          source_folder_id: string | null;
          destination_folder_id: string | null;
        }[]
      >`
        SELECT c.id, c.actor_kind, c.actor_id, c.kind, ref.message_id,
          c.target ->> 'sourceFolderId' AS source_folder_id,
          c.target ->> 'destinationFolderId' AS destination_folder_id
        FROM mail.commands c
        LEFT JOIN mail.remote_message_refs ref ON ref.id = (c.target ->> 'remoteMessageRefId')::uuid
        WHERE c.mailbox_id = ${mailboxId}::uuid AND c.idempotency_key = ${idempotencyKey}
      `;
      if (!inverse) return false;
      const matches =
        inverse.actor_kind === original.actor_kind &&
        inverse.actor_id === original.actor_id &&
        inverse.kind === "move" &&
        original.message_id !== null &&
        inverse.message_id === original.message_id &&
        inverse.source_folder_id === original.destination_folder_id &&
        inverse.destination_folder_id === original.source_folder_id;
      await finish(matches ? "reversed" : "unavailable", matches ? inverse.id : null);
      return true;
    };
    if (await replay()) return null;

    const [copy] = await tx<{ id: string }[]>`
      SELECT ref.id
      FROM mail.remote_message_refs ref
      JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
      WHERE ref.message_id = ${original.message_id}::uuid AND ref.folder_id = ${original.destination_folder_id}::uuid
        AND ref.stale_at IS NULL AND placement.deleted_at IS NULL
        AND (ref.connector_ref ->> 'commandId' IS NULL OR ref.connector_ref ->> 'commandId' = ${commandId})
        AND NOT EXISTS (
          SELECT 1 FROM mail.commands other
          WHERE other.mailbox_id = ${mailboxId}::uuid AND other.kind = 'move' AND other.id <> ${commandId}::uuid
            AND other.target ->> 'remoteMessageRefId' = ref.id::text
            AND (other.state NOT IN ('confirmed', 'reconciled', 'failed', 'cancelled', 'needs_attention')
              OR other.idempotency_key LIKE 'undo:%')
        )
      ORDER BY (ref.connector_ref ->> 'source' = 'command' AND ref.connector_ref ->> 'commandId' = ${commandId}) IS TRUE DESC,
        placement.updated_at DESC, ref.id
      LIMIT 1
    `;
    if (!copy) {
      if (Date.now() - new Date(original.settled_at).getTime() > MAIL_ACTION_OUTCOME_TTL_MS) await finish("unavailable");
      return null;
    }
    const target = {
      remoteMessageRefId: copy.id,
      sourceFolderId: original.destination_folder_id,
      destinationFolderId: original.source_folder_id,
      // Command preparation hashes the absent precondition too; JSON storage omits it.
      expectedRemoteState: undefined,
    };
    if (!(await commandStillAuthorized({ ...original, kind: "move", target }, "write", tx))) {
      await finish("unavailable");
      return null;
    }
    const protection = await checkCommandKeepProtection(tx, { kind: "move", target, payload: {} });
    if (!protection.ok) {
      await finish("unavailable");
      return null;
    }
    // The stored identity was authorized above; automation selects the current transport and folder rights.
    const execution = await resolveMailExecution({
      mailboxId,
      operation: "automation",
      context: null,
      folderRequirements: [
        { folderId: original.destination_folder_id, rights: ["read", "move"] },
        { folderId: original.source_folder_id, rights: ["insert"] },
      ],
      db: tx,
    });
    if (!execution.ok || !execution.data.bindingId) {
      await finish("unavailable");
      return null;
    }
    const [inverse] = await tx<{ id: string }[]>`
      INSERT INTO mail.commands (
        mailbox_id, kind, actor_kind, actor_id, delegated_user_id, idempotency_key, request_hash, correlation_id,
        target, payload, selected_binding_id, selected_secret_revision, rights_snapshot, transport_metadata,
        initiator_actor_kind, initiator_actor_id, access_subject_kind, access_subject_id,
        credential_scopes, credential_id, credential_expires_at
      ) VALUES (
        ${mailboxId}::uuid, 'move', ${original.actor_kind}, ${original.actor_id}::uuid, ${original.delegated_user_id}::uuid,
        ${idempotencyKey}, ${sha256Json({ kind: "move", target, payload: {} })}, ${original.correlation_id},
        ${target}::jsonb, ${{}}::jsonb, ${execution.data.bindingId}::uuid, ${execution.data.secretRevision},
        ${execution.data.rightsSnapshot}::jsonb, ${{ sentDelivery: null }}::jsonb,
        ${original.initiator_actor_kind}, ${original.initiator_actor_id}::uuid,
        ${original.access_subject_kind}, ${original.access_subject_id}::uuid,
        ${original.credential_scopes === null ? null : toPgTextArray(original.credential_scopes)}::text[],
        ${original.credential_id}::uuid, ${original.credential_expires_at}::timestamptz
      )
      ON CONFLICT (mailbox_id, idempotency_key) DO NOTHING
      RETURNING id
    `;
    if (!inverse) {
      if (!(await replay())) throw new Error("Undo command conflict returned no replay");
      return null;
    }
    await tx`
      INSERT INTO mail.activity_events (
        mailbox_id, command_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
      ) VALUES (
        ${mailboxId}::uuid, ${inverse.id}::uuid, ${original.actor_kind}, ${original.actor_id}::uuid,
        'command.move', 'requested', 'command', ${inverse.id}::uuid,
        ${{ selectedBindingId: execution.data.bindingId, correlationId: original.correlation_id, scheduledAt: null, undoSeconds: null, undoOf: commandId }}::jsonb
      )
    `;
    await audit.record(
      {
        action: "mail.command.move.request",
        outcome: "allowed",
        actor: null,
        target: { type: "mailbox", id: mailboxId },
        requestId: `mail-undo:${commandId}`,
        metadata: {
          commandId: inverse.id,
          selectedBindingId: execution.data.bindingId,
          target,
          scheduledAt: null,
          undoSeconds: null,
          workflowVersionId: null,
          undoOf: commandId,
        },
      },
      tx,
    );
    await finish("reversed", inverse.id);
    return inverse.id;
  });

export const resolveUndoRequests = async (filter: UndoFilter): Promise<string[]> => {
  const pending = await sql<{ command_id: string; mailbox_id: string }[]>`
    SELECT request.command_id, c.mailbox_id
    FROM mail.command_undo_requests request JOIN mail.commands c ON c.id = request.command_id
    WHERE request.outcome IS NULL AND c.state IN ('confirmed', 'reconciled', 'failed', 'cancelled', 'needs_attention')
      AND (${filter.mailboxId ?? null}::uuid IS NULL OR c.mailbox_id = ${filter.mailboxId ?? null}::uuid)
      AND (${filter.commandIds ? toPgUuidArray(filter.commandIds) : null}::uuid[] IS NULL
        OR c.id = ANY(${filter.commandIds ? toPgUuidArray(filter.commandIds) : null}::uuid[]))
    ORDER BY request.requested_at, request.command_id
    LIMIT ${MAX_CONVERSATION_ACTION_MESSAGES}
  `;
  const created: string[] = [];
  for (const request of pending) {
    // A failing record stays pending for the next run and must not hold back the records after it.
    const inverseId = await resolveUndoRequest(request.command_id, request.mailbox_id).catch((error) => {
      log.warn("Recorded Undo waits for the next run", {
        commandId: request.command_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    });
    if (inverseId) created.push(inverseId);
  }
  return created;
};
