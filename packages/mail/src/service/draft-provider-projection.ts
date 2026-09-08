import { type Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Lock, Worker } from "@k2b/sync";
import { lazySync } from "@valentinkolb/cloud";
import { createRuntimeTaskTracker, logger, stopRuntimeJobs, toPgTextArray } from "@valentinkolb/cloud/services";
import { Splitter, Streamer } from "@zone-eu/mailsplit";
import { sql } from "bun";
import { type AddressObject, type AttachmentStream, type Headers, MailParser, type MessageText } from "mailparser";
import { withShortIdDb } from "../lib/short-id";
import type { ConnectorEnvelope } from "./connectors";
import { imapSmtpConnector } from "./connectors";
import {
  buildDraftProviderMimeStream,
  type DraftProviderContent,
  draftProviderContentSchema,
  draftProviderFingerprint,
  draftProviderMessageId,
} from "./draft-provider-mime";
import { resolveMailExecution } from "./execution";
import { resolveRoleFolder } from "./folders";
import { withLeaseHeartbeat } from "./lease-heartbeat";
import { assertMailboxTransportFence, loadMailboxTransportFence, type MailboxTransportFence } from "./mailbox-transport-fence";
import { createBlobReadable, getStoredBlob, storeReadableBlob } from "./message-blobs";
import { loadProviderConnectionRuntimeSnapshot } from "./provider-connections";
import { providerErrorCode, providerErrorMessage } from "./provider-errors";
import { MAIL_PROVIDER_OPERATION_LEASE_MS, mailProviderOperationMutex, providerBusyRetryDelayMs } from "./provider-operation-lock";

type SqlClient = typeof sql;
type ProjectionState =
  | "prepared"
  | "appending"
  | "active"
  | "retiring"
  | "retired"
  | "external"
  | "importing"
  | "conflict"
  | "ambiguous"
  | "needs_attention";

type DbProjection = {
  id: string;
  mailbox_id: string;
  draft_id: string | null;
  cloud_revision: string | number | null;
  direction: "export" | "import";
  state: ProjectionState;
  stable_message_id: string;
  content_fingerprint: string | null;
  content_snapshot: DraftProviderContent | Record<string, unknown> | string;
  mime_blob_id: string | null;
  remote_resource_id: string | null;
  binding_id: string | null;
  folder_id: string | null;
  uid_validity: string | number | null;
  uid: string | number | null;
  modseq: string | number | null;
  transport_generation: string | number | null;
  secret_revision: number | null;
  attempt: number;
  provider_effect_started_at: Date | string | null;
};

type ReconcileWindow = { low: number; high: number; uids: number[] };

const log = logger("mail:draft-projection");
const tasks = createRuntimeTaskTracker();
const JOB_LEASE_MS = 5 * 60_000;
const JOB_HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_IMPORT_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MIME_HEADER_BYTES = 2 * 1024 * 1024;
const MAX_MIME_CHILD_NODES = 5_000;

const parseJson = <T>(value: T | string): T => (typeof value === "string" ? (JSON.parse(value) as T) : value);
const normalizeMessageId = (value: string): string => value.trim().toLowerCase();
const failureCode = (error: unknown, fallback: string): string => providerErrorCode(error, fallback).slice(0, 80);
const failureMessage = (error: unknown, fallback: string): string => providerErrorMessage(error, fallback).slice(0, 1_000);
export const remoteAppendEffectPossible = (error: unknown): boolean =>
  !(error && typeof error === "object" && "effectPossible" in error && error.effectPossible === false);

const withDraftProjectionLeases = async <T>(params: {
  lock: Lock;
  jobHeartbeat: () => Promise<void>;
  work: (assertLeaseActive: () => Promise<void>, signal: AbortSignal) => Promise<T>;
}): Promise<T> =>
  withLeaseHeartbeat({
    intervalMs: JOB_HEARTBEAT_INTERVAL_MS,
    heartbeat: async () => {
      try {
        await params.jobHeartbeat();
      } catch (cause) {
        throw Object.assign(new Error("Draft projection job lease was lost"), {
          code: "DRAFT_PROJECTION_JOB_LEASE_LOST",
          cause,
        });
      }
      if (!(await mailProviderOperationMutex().extend(params.lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS }))) {
        throw Object.assign(new Error("Draft projection provider lease was lost"), {
          code: "DRAFT_PROJECTION_PROVIDER_LEASE_LOST",
        });
      }
    },
    work: params.work,
  });

const loadDraftContent = async (
  draftId: string,
  db: SqlClient = sql,
): Promise<{
  mailboxId: string;
  revision: number;
  state: string;
  content: DraftProviderContent;
} | null> => {
  const [row] = await db<
    {
      mailbox_id: string;
      revision: string | number;
      state: string;
      sender_identity_id: string;
      display_name: string;
      from_address: string;
      reply_to: string | null;
      to_addresses: DraftProviderContent["to"] | string;
      cc_addresses: DraftProviderContent["cc"] | string;
      bcc_addresses: DraftProviderContent["bcc"] | string;
      subject: string;
      body_markdown: string;
      body_format: DraftProviderContent["format"];
      parent_message_id: string | null;
      reference_ids: string[] | null;
      attachments: DraftProviderContent["attachments"] | string;
    }[]
  >`
    SELECT
      draft.mailbox_id,
      draft.revision,
      draft.state,
      draft.sender_identity_id,
      identity.display_name,
      identity.from_address,
      identity.reply_to,
      draft.to_addresses,
      draft.cc_addresses,
      draft.bcc_addresses,
      draft.subject,
      draft.body_markdown,
      draft.body_format,
      CASE WHEN draft.intent IN ('reply', 'reply_all') THEN source.message_id ELSE NULL END AS parent_message_id,
      CASE WHEN draft.intent IN ('reply', 'reply_all') THEN source.reference_ids ELSE ARRAY[]::text[] END AS reference_ids,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'id', attachment.id,
              'blobId', attachment.blob_id,
              'filename', attachment.filename,
              'contentType', attachment.content_type,
              'byteLength', attachment.byte_length,
              'contentHash', attachment.content_hash
            ) ORDER BY attachment.position, attachment.id
          )
          FROM mail.draft_attachments attachment
          WHERE attachment.draft_id = draft.id AND attachment.removed_at IS NULL
        ),
        '[]'::jsonb
      ) AS attachments
    FROM mail.drafts draft
    JOIN mail.sender_identities identity ON identity.id = draft.sender_identity_id
    LEFT JOIN mail.message_contents source ON source.id = draft.source_message_id
    WHERE draft.id = ${draftId}::uuid
      AND draft.origin = 'user'
  `;
  if (!row) return null;
  const revision = Number(row.revision);
  const parentMessageId = row.parent_message_id;
  const content = draftProviderContentSchema.parse({
    revision,
    senderIdentityId: row.sender_identity_id,
    from: { name: row.display_name, address: row.from_address },
    replyTo: row.reply_to,
    to: parseJson(row.to_addresses),
    cc: parseJson(row.cc_addresses),
    bcc: parseJson(row.bcc_addresses),
    subject: row.subject,
    body: row.body_markdown,
    format: row.body_format,
    inReplyTo: parentMessageId,
    references: [...new Set([...(row.reference_ids ?? []), ...(parentMessageId ? [parentMessageId] : [])])],
    attachments: parseJson(row.attachments),
  });
  return { mailboxId: row.mailbox_id, revision, state: row.state, content };
};

export const queueDraftProjectionInTransaction = async (params: { db: SqlClient; draftId: string }): Promise<string | null> => {
  const draft = await loadDraftContent(params.draftId, params.db);
  if (!draft) return null;
  if (draft.state !== "draft") {
    const [retiring] = await params.db<{ id: string }[]>`
      UPDATE mail.draft_provider_snapshots
      SET state = 'retiring', completed_at = NULL
      WHERE draft_id = ${params.draftId}::uuid
        AND direction = 'export'
        AND state = 'active'
      RETURNING id
    `;
    return retiring?.id ?? null;
  }
  const fingerprint = draftProviderFingerprint(draft.content);
  const snapshotId = crypto.randomUUID();
  const stableMessageId = draftProviderMessageId(snapshotId);
  const [created] = await params.db<{ id: string }[]>`
    INSERT INTO mail.draft_provider_snapshots (
      id, mailbox_id, draft_id, cloud_revision, direction, state,
      stable_message_id, content_fingerprint, content_snapshot
    ) VALUES (
      ${snapshotId}::uuid,
      ${draft.mailboxId}::uuid,
      ${params.draftId}::uuid,
      ${draft.revision},
      'export',
      'prepared',
      ${stableMessageId},
      ${fingerprint},
      ${draft.content}::jsonb
    )
    ON CONFLICT (draft_id, cloud_revision) WHERE direction = 'export' DO NOTHING
    RETURNING id
  `;
  if (created) return created.id;
  const [existing] = await params.db<{ id: string }[]>`
    SELECT id
    FROM mail.draft_provider_snapshots
    WHERE draft_id = ${params.draftId}::uuid
      AND cloud_revision = ${draft.revision}
      AND direction = 'export'
  `;
  return existing?.id ?? null;
};

const markProjectionFailure = async (snapshotId: string, state: "ambiguous" | "needs_attention", error: unknown): Promise<void> => {
  await sql`
    UPDATE mail.draft_provider_snapshots
    SET
      state = ${state},
      last_error_code = ${failureCode(error, "DRAFT_PROJECTION_FAILED")},
      last_error_message = ${failureMessage(error, "Draft projection failed")},
      completed_at = now()
    WHERE id = ${snapshotId}::uuid
  `;
};

const loadCurrentExecution = async (params: { mailboxId: string; folderId: string; rights: string[] }) => {
  const execution = await resolveMailExecution({
    mailboxId: params.mailboxId,
    operation: "backgroundSync",
    folderRequirements: [{ folderId: params.folderId, rights: params.rights }],
  });
  if (
    !execution.ok ||
    !execution.data.bindingId ||
    !execution.data.connectionId ||
    execution.data.secretRevision == null ||
    !execution.data.remoteResourceId
  ) {
    throw Object.assign(new Error("No current provider binding has the required Drafts-folder rights"), {
      code: "NO_DRAFT_PROJECTION_BINDING",
    });
  }
  const folder = execution.data.folders[params.folderId];
  if (!folder) throw Object.assign(new Error("Drafts folder locator is unavailable"), { code: "NO_DRAFT_FOLDER_LOCATOR" });
  const runtimeSnapshot = await loadProviderConnectionRuntimeSnapshot(execution.data.connectionId);
  if (runtimeSnapshot.secretRevision !== execution.data.secretRevision) {
    throw Object.assign(new Error("Provider credentials changed before draft projection"), {
      code: "CREDENTIAL_REVISION_CHANGED",
    });
  }
  return { execution: execution.data, folder, runtime: runtimeSnapshot.runtime };
};

const claimExportSnapshot = async (snapshotId: string): Promise<DbProjection | null> =>
  sql.begin(async (tx) => {
    const [candidate] = await tx<DbProjection[]>`
      SELECT *
      FROM mail.draft_provider_snapshots
      WHERE id = ${snapshotId}::uuid
        AND direction = 'export'
        AND state IN ('prepared', 'appending', 'retiring')
      FOR UPDATE
    `;
    if (!candidate) return null;
    if (!candidate.draft_id || candidate.cloud_revision == null) {
      throw Object.assign(new Error("Export snapshot is missing its Cloud identity"), { code: "INVALID_DRAFT_SNAPSHOT" });
    }
    if (candidate.state === "retiring") return candidate;
    const draft = await loadDraftContent(candidate.draft_id, tx);
    if (!draft) {
      await tx`
        UPDATE mail.draft_provider_snapshots
        SET state = 'retired', completed_at = now(), last_error_code = 'DRAFT_REMOVED',
            last_error_message = 'The Cloud draft no longer exists'
        WHERE id = ${candidate.id}::uuid
      `;
      return null;
    }
    if (draft.revision !== Number(candidate.cloud_revision)) {
      await queueDraftProjectionInTransaction({ db: tx, draftId: candidate.draft_id });
      if (candidate.provider_effect_started_at) return candidate;
      await tx`
        UPDATE mail.draft_provider_snapshots
        SET state = 'retired', completed_at = now(), last_error_code = 'DRAFT_REVISION_SUPERSEDED',
            last_error_message = 'A newer Cloud revision superseded this snapshot'
        WHERE id = ${candidate.id}::uuid
      `;
      return null;
    }
    return candidate;
  });

const ensureSnapshotMimeBlob = async (snapshot: DbProjection): Promise<{ blobId: string; byteLength: number }> => {
  if (snapshot.mime_blob_id) {
    const blob = await getStoredBlob(snapshot.mime_blob_id);
    return { blobId: blob.id, byteLength: blob.byteLength };
  }
  if (!snapshot.draft_id || !snapshot.content_fingerprint) {
    throw Object.assign(new Error("Draft export snapshot is incomplete"), { code: "INVALID_DRAFT_SNAPSHOT" });
  }
  const content = draftProviderContentSchema.parse(parseJson(snapshot.content_snapshot));
  const blob = await storeReadableBlob(
    buildDraftProviderMimeStream({
      snapshotId: snapshot.id,
      draftId: snapshot.draft_id,
      content,
      fingerprint: snapshot.content_fingerprint,
      messageId: snapshot.stable_message_id,
      date: new Date(),
      openAttachment: createBlobReadable,
    }),
  );
  const [updated] = await sql<{ mime_blob_id: string }[]>`
    UPDATE mail.draft_provider_snapshots
    SET mime_blob_id = COALESCE(mime_blob_id, ${blob.id}::uuid)
    WHERE id = ${snapshot.id}::uuid
      AND direction = 'export'
      AND state IN ('prepared', 'appending')
    RETURNING mime_blob_id
  `;
  if (!updated) throw Object.assign(new Error("Draft export snapshot changed while MIME was built"), { code: "STALE_DRAFT_SNAPSHOT" });
  const selected = updated.mime_blob_id === blob.id ? blob : await getStoredBlob(updated.mime_blob_id);
  return { blobId: selected.id, byteLength: selected.byteLength };
};

const resolveAppendedUid = async (params: {
  snapshot: DbProjection;
  runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntimeSnapshot>>["runtime"];
  folderPath: string;
  append?: { uidValidity: string | null; uid: number | null };
}): Promise<{ uidValidity: string; uid: number }> => {
  if (params.append?.uidValidity && params.append.uid) {
    return { uidValidity: params.append.uidValidity, uid: params.append.uid };
  }
  const status = await imapSmtpConnector.getFolderStatus(params.runtime, params.folderPath);
  const matches = await imapSmtpConnector.findMessageById(params.runtime, params.folderPath, params.snapshot.stable_message_id);
  if (matches.length === 1) return { uidValidity: status.uidValidity, uid: matches[0]! };
  throw Object.assign(
    new Error(
      matches.length === 0
        ? "Provider accepted state is unknown and the draft Message-ID was not found"
        : "Provider returned more than one draft with the stable Message-ID",
    ),
    { code: matches.length === 0 ? "DRAFT_APPEND_UNCONFIRMED" : "DRAFT_APPEND_DUPLICATE" },
  );
};

const activateExportSnapshot = async (params: {
  snapshot: DbProjection;
  remoteResourceId: string;
  bindingId: string;
  folderId: string;
  uidValidity: string;
  uid: number;
  transportGeneration: number;
  secretRevision: number;
}): Promise<DbProjection[]> =>
  sql.begin(async (tx) => {
    const [current] = await tx<{ revision: string | number; state: string }[]>`
      SELECT revision, state
      FROM mail.drafts
      WHERE id = ${params.snapshot.draft_id}::uuid AND origin = 'user'
      FOR SHARE
    `;
    if (!current || Number(current.revision) !== Number(params.snapshot.cloud_revision) || current.state !== "draft") {
      const [superseded] = await tx<DbProjection[]>`
        UPDATE mail.draft_provider_snapshots
        SET
          state = 'retiring',
          remote_resource_id = ${params.remoteResourceId}::uuid,
          binding_id = ${params.bindingId}::uuid,
          folder_id = ${params.folderId}::uuid,
          uid_validity = ${params.uidValidity}::numeric,
          uid = ${params.uid}::numeric,
          transport_generation = ${params.transportGeneration},
          secret_revision = ${params.secretRevision},
          last_error_code = 'DRAFT_CHANGED_AFTER_APPEND',
          last_error_message = 'The Cloud draft changed after the remote snapshot was appended',
          completed_at = now()
        WHERE id = ${params.snapshot.id}::uuid
        RETURNING *
      `;
      if (current?.state === "draft" && params.snapshot.draft_id) {
        await queueDraftProjectionInTransaction({ db: tx, draftId: params.snapshot.draft_id });
      }
      return superseded ? [superseded] : [];
    }
    const [previous] = await tx<DbProjection[]>`
      SELECT *
      FROM mail.draft_provider_snapshots
      WHERE draft_id = ${params.snapshot.draft_id}::uuid
        AND direction = 'export'
        AND state = 'active'
        AND id <> ${params.snapshot.id}::uuid
      FOR UPDATE
    `;
    if (previous) {
      await tx`
        UPDATE mail.draft_provider_snapshots
        SET state = 'retiring'
        WHERE id = ${previous.id}::uuid
      `;
    }
    await tx`
      UPDATE mail.draft_provider_snapshots
      SET
        state = 'active',
        remote_resource_id = ${params.remoteResourceId}::uuid,
        binding_id = ${params.bindingId}::uuid,
        folder_id = ${params.folderId}::uuid,
        uid_validity = ${params.uidValidity}::numeric,
        uid = ${params.uid}::numeric,
        transport_generation = ${params.transportGeneration},
        secret_revision = ${params.secretRevision},
        last_seen_at = now(),
        last_error_code = NULL,
        last_error_message = NULL,
        completed_at = now()
      WHERE id = ${params.snapshot.id}::uuid
    `;
    return previous ? [previous] : [];
  });

const retireRemoteSnapshot = async (params: {
  snapshot: DbProjection;
  runtime: Awaited<ReturnType<typeof loadProviderConnectionRuntimeSnapshot>>["runtime"];
  folderPath: string;
  rights: string[];
  uidValidity: string;
  uidplus: boolean;
}): Promise<void> => {
  if (!params.snapshot.uid || !params.snapshot.uid_validity) {
    await markProjectionFailure(
      params.snapshot.id,
      "needs_attention",
      Object.assign(new Error("Previous remote draft identity is incomplete"), { code: "DRAFT_REMOTE_IDENTITY_MISSING" }),
    );
    return;
  }
  if (String(params.snapshot.uid_validity) !== params.uidValidity || !params.uidplus || !params.rights.includes("delete_messages")) {
    await markProjectionFailure(
      params.snapshot.id,
      "needs_attention",
      Object.assign(new Error("Previous remote draft cannot be deleted safely with current provider capabilities and rights"), {
        code: "SAFE_DRAFT_DELETE_UNAVAILABLE",
      }),
    );
    return;
  }
  const target = {
    folderPath: params.folderPath,
    uidValidity: String(params.snapshot.uid_validity),
    uid: Number(params.snapshot.uid),
  };
  const state = await imapSmtpConnector.getMessageState(params.runtime, target);
  if (!state.exists) {
    await sql`
      UPDATE mail.draft_provider_snapshots
      SET state = 'retired', completed_at = now(), last_error_code = NULL, last_error_message = NULL
      WHERE id = ${params.snapshot.id}::uuid
    `;
    return;
  }
  if (normalizeMessageId(state.messageId ?? "") !== normalizeMessageId(params.snapshot.stable_message_id)) {
    await markProjectionFailure(
      params.snapshot.id,
      "needs_attention",
      Object.assign(new Error("Remote UID no longer identifies the projected draft"), { code: "DRAFT_REMOTE_IDENTITY_CHANGED" }),
    );
    return;
  }
  await imapSmtpConnector.delete(params.runtime, target);
  await sql`
    UPDATE mail.draft_provider_snapshots
    SET state = 'retired', completed_at = now(), last_error_code = NULL, last_error_message = NULL
    WHERE id = ${params.snapshot.id}::uuid
  `;
};

const processExportSnapshot = async (snapshotId: string, jobHeartbeat: () => Promise<void>): Promise<void> => {
  const snapshot = await claimExportSnapshot(snapshotId);
  if (!snapshot || !snapshot.draft_id) return;
  const roleFolder = await resolveRoleFolder(snapshot.mailbox_id, "drafts");
  if (!roleFolder.ok) throw Object.assign(new Error(roleFolder.error.message), { code: roleFolder.error.code });
  const initial = await loadCurrentExecution({
    mailboxId: snapshot.mailbox_id,
    folderId: roleFolder.data.id,
    rights: snapshot.state === "retiring" ? ["read", "delete_messages"] : ["read", "insert"],
  });
  const lock = await mailProviderOperationMutex().acquire({
    resource: initial.execution.remoteResourceId!,
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
  });
  if (!lock) throw Object.assign(new Error("Mail provider resource is busy"), { code: "SYNC_BUSY" });
  try {
    await withDraftProjectionLeases({
      lock,
      jobHeartbeat,
      work: async (assertLeaseActive, signal) => {
        await assertLeaseActive();
        const current = await loadCurrentExecution({
          mailboxId: snapshot.mailbox_id,
          folderId: roleFolder.data.id,
          rights: snapshot.state === "retiring" ? ["read", "delete_messages"] : ["read", "insert"],
        });
        const fence = await loadMailboxTransportFence(current.execution.remoteResourceId!);
        if (!fence)
          throw Object.assign(new Error("Mailbox transport changed before draft projection"), { code: "MAILBOX_TRANSPORT_CHANGED" });
        await assertMailboxTransportFence(fence);
        if (snapshot.state === "retiring") {
          const [capability] = await sql<{ uidplus: boolean }[]>`
        SELECT COALESCE((binding.capabilities ->> 'uidplus')::boolean, false) AS uidplus
        FROM mail.provider_bindings binding
        WHERE binding.id = ${current.execution.bindingId}::uuid
          AND binding.verified_secret_revision = ${current.execution.secretRevision}
      `;
          await assertLeaseActive();
          const status = await imapSmtpConnector.getFolderStatus(current.runtime, current.folder.path);
          await assertLeaseActive();
          await retireRemoteSnapshot({
            snapshot,
            runtime: current.runtime,
            folderPath: current.folder.path,
            rights: current.folder.rights,
            uidValidity: status.uidValidity,
            uidplus: capability?.uidplus === true,
          });
          return;
        }
        const capabilities = await sql<{ uidplus: boolean }[]>`
      SELECT COALESCE((binding.capabilities ->> 'uidplus')::boolean, false) AS uidplus
      FROM mail.provider_bindings binding
      WHERE binding.id = ${current.execution.bindingId}::uuid
        AND binding.verified_secret_revision = ${current.execution.secretRevision}
    `;
        await assertLeaseActive();
        const folderStatus = await imapSmtpConnector.getFolderStatus(current.runtime, current.folder.path);
        const latestDraft = await loadDraftContent(snapshot.draft_id!);
        if (!latestDraft || latestDraft.revision !== Number(snapshot.cloud_revision)) {
          if (snapshot.provider_effect_started_at) {
            await assertLeaseActive();
            const remoteIdentity = await resolveAppendedUid({
              snapshot,
              runtime: current.runtime,
              folderPath: current.folder.path,
            });
            await sql`
          UPDATE mail.draft_provider_snapshots
          SET
            remote_resource_id = ${current.execution.remoteResourceId}::uuid,
            binding_id = ${current.execution.bindingId}::uuid,
            folder_id = ${roleFolder.data.id}::uuid,
            uid_validity = ${remoteIdentity.uidValidity}::numeric,
            uid = ${remoteIdentity.uid}::numeric,
            transport_generation = ${fence.generation},
            secret_revision = ${current.execution.secretRevision}
          WHERE id = ${snapshot.id}::uuid
        `;
            await assertLeaseActive();
            await retireRemoteSnapshot({
              snapshot: { ...snapshot, uid_validity: remoteIdentity.uidValidity, uid: remoteIdentity.uid },
              runtime: current.runtime,
              folderPath: current.folder.path,
              rights: current.folder.rights,
              uidValidity: folderStatus.uidValidity,
              uidplus: capabilities[0]?.uidplus === true,
            });
          } else {
            await sql`
          UPDATE mail.draft_provider_snapshots
          SET state = 'retired', completed_at = now(), last_error_code = 'DRAFT_REVISION_SUPERSEDED',
              last_error_message = 'A newer Cloud revision superseded this snapshot'
          WHERE id = ${snapshot.id}::uuid
        `;
          }
          if (latestDraft) await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId: snapshot.draft_id! }));
          return;
        }
        if (latestDraft.state !== "draft") {
          const active = await sql<DbProjection[]>`
        SELECT *
        FROM mail.draft_provider_snapshots
        WHERE draft_id = ${snapshot.draft_id}::uuid AND direction = 'export' AND state IN ('active', 'retiring')
        ORDER BY created_at DESC
      `;
          for (const remote of active) {
            await assertLeaseActive();
            await retireRemoteSnapshot({
              snapshot: remote,
              runtime: current.runtime,
              folderPath: current.folder.path,
              rights: current.folder.rights,
              uidValidity: folderStatus.uidValidity,
              uidplus: capabilities[0]?.uidplus === true,
            });
          }
          await sql`
        UPDATE mail.draft_provider_snapshots
        SET state = 'retired', completed_at = now()
        WHERE id = ${snapshot.id}::uuid AND state = 'prepared'
      `;
          return;
        }

        let remoteIdentity: { uidValidity: string; uid: number } | null = null;
        if (snapshot.provider_effect_started_at) {
          await assertLeaseActive();
          remoteIdentity = await resolveAppendedUid({
            snapshot,
            runtime: current.runtime,
            folderPath: current.folder.path,
          });
        } else {
          const mime = await ensureSnapshotMimeBlob(snapshot);
          const [claimed] = await sql<{ attempt: number }[]>`
        UPDATE mail.draft_provider_snapshots
        SET
          state = 'appending',
          attempt = attempt + 1,
          provider_effect_started_at = now(),
          remote_resource_id = ${current.execution.remoteResourceId}::uuid,
          binding_id = ${current.execution.bindingId}::uuid,
          folder_id = ${roleFolder.data.id}::uuid,
          transport_generation = ${fence.generation},
          secret_revision = ${current.execution.secretRevision}
        WHERE id = ${snapshot.id}::uuid
          AND state = 'prepared'
          AND provider_effect_started_at IS NULL
        RETURNING attempt
      `;
          if (!claimed) return;
          await assertLeaseActive();
          await assertMailboxTransportFence(fence);
          let appended: { uidValidity: string | null; uid: number | null };
          try {
            appended = await imapSmtpConnector.appendSource(
              current.runtime,
              current.folder.path,
              createBlobReadable(mime.blobId),
              mime.byteLength,
              ["\\Draft"],
              new Date(),
              signal,
            );
          } catch (error) {
            if (!remoteAppendEffectPossible(error)) {
              await sql`
                UPDATE mail.draft_provider_snapshots
                SET state = 'prepared', provider_effect_started_at = NULL
                WHERE id = ${snapshot.id}::uuid
                  AND state = 'appending'
                  AND uid IS NULL
              `;
            }
            throw error;
          }
          await assertLeaseActive();
          await assertMailboxTransportFence(fence);
          remoteIdentity = await resolveAppendedUid({
            snapshot,
            runtime: current.runtime,
            folderPath: current.folder.path,
            append: appended,
          });
        }

        const snapshotsToRetire = await activateExportSnapshot({
          snapshot,
          remoteResourceId: current.execution.remoteResourceId!,
          bindingId: current.execution.bindingId!,
          folderId: roleFolder.data.id,
          uidValidity: remoteIdentity.uidValidity,
          uid: remoteIdentity.uid,
          transportGeneration: fence.generation,
          secretRevision: current.execution.secretRevision!,
        });
        for (const previous of snapshotsToRetire) {
          await assertLeaseActive();
          await assertMailboxTransportFence(fence);
          await retireRemoteSnapshot({
            snapshot: previous,
            runtime: current.runtime,
            folderPath: current.folder.path,
            rights: current.folder.rights,
            uidValidity: folderStatus.uidValidity,
            uidplus: capabilities[0]?.uidplus === true,
          });
        }
      },
    });
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

const addressList = (value: unknown): Array<{ name: string | null; address: string }> => {
  const objects = Array.isArray(value) ? value : value ? [value] : [];
  return objects.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || !("value" in candidate)) return [];
    return (candidate as AddressObject).value.flatMap((address) => {
      const normalized = address.address?.trim().toLowerCase();
      return normalized ? [{ name: address.name?.trim() || null, address: normalized }] : [];
    });
  });
};

const stringHeader = (headers: Headers, name: string): string | null => {
  const value = headers.get(name);
  return typeof value === "string" ? value.trim() || null : null;
};

type ParsedRemoteDraft = {
  cloudDraftId: string | null;
  cloudRevision: number | null;
  cloudFingerprint: string | null;
  format: "plain" | "markdown";
  from: string | null;
  fromName: string;
  replyTo: string | null;
  to: Array<{ name: string | null; address: string }>;
  cc: Array<{ name: string | null; address: string }>;
  bcc: Array<{ name: string | null; address: string }>;
  subject: string;
  body: string;
  inReplyTo: string | null;
  references: string[];
  attachments: Array<{
    blobId: string;
    filename: string;
    contentType: string;
    byteLength: number;
    contentHash: string;
  }>;
};

export const removeMimeTransportLineEnding = (body: string): string => body.replace(/\r?\n$/, "");

const remoteDraftBodyLimitError = (): Error =>
  Object.assign(new Error("Remote draft body exceeds the Cloud draft limit"), {
    code: "REMOTE_DRAFT_BODY_TOO_LARGE",
  });

export const assertRemoteDraftBodyWithinLimit = async (source: Readable): Promise<void> => {
  const splitter = new Splitter({
    maxHeadSize: MAX_MIME_HEADER_BYTES,
    maxChildNodes: MAX_MIME_CHILD_NODES,
  });
  const streamer = new Streamer(
    (node) =>
      node.multipart === false &&
      node.disposition !== "attachment" &&
      (node.contentType === "text/plain" || node.contentType === "text/html"),
  );
  let decodedBytes = 0;
  let limitError: Error | null = null;
  streamer.on("node", ({ decoder, done }) => {
    decoder.on("data", (value: Buffer | string) => {
      decodedBytes += Buffer.byteLength(value);
      if (decodedBytes <= MAX_BODY_BYTES || limitError) return;
      limitError = remoteDraftBodyLimitError();
      decoder.destroy(limitError);
      streamer.destroy(limitError);
    });
    decoder.once("end", done);
    decoder.once("error", (error) => {
      done();
      if (!streamer.destroyed) streamer.destroy(error);
    });
    decoder.resume();
  });
  await pipeline(
    source,
    splitter,
    streamer,
    new Writable({
      objectMode: true,
      write(_chunk, _encoding, callback) {
        callback();
      },
    }),
  );
  if (limitError) throw limitError;
};

const parseRemoteDraft = async (openSource: () => Readable): Promise<ParsedRemoteDraft> => {
  await assertRemoteDraftBodyWithinLimit(openSource());
  const parser = new MailParser({
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
    keepCidLinks: true,
    maxHtmlLengthToParse: MAX_BODY_BYTES,
    checksumAlgo: "sha256",
  });
  let headers: Headers | null = null;
  parser.once("headers", (value) => {
    headers = value;
  });
  let body = "";
  const attachments: ParsedRemoteDraft["attachments"] = [];
  const parsing = openSource().pipe(parser);
  for await (const value of parsing as AsyncIterable<AttachmentStream | MessageText>) {
    if (value.type === "attachment") {
      try {
        const blob = await storeReadableBlob(value.content as Readable, value.size || null);
        attachments.push({
          blobId: blob.id,
          filename: (value.filename?.trim() || "attachment").slice(0, 255),
          contentType: (value.contentType || "application/octet-stream").slice(0, 255),
          byteLength: blob.byteLength,
          contentHash: blob.contentHash,
        });
      } finally {
        value.release();
      }
      continue;
    }
    body = removeMimeTransportLineEnding(value.text ?? "");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      throw remoteDraftBodyLimitError();
    }
  }
  const parsedHeaders = headers as Headers | null;
  if (!parsedHeaders) throw Object.assign(new Error("Remote draft has no parseable headers"), { code: "REMOTE_DRAFT_HEADERS_MISSING" });
  const cloudRevisionValue = Number(stringHeader(parsedHeaders, "x-cloud-draft-revision"));
  const referencesHeader = parsedHeaders.get("references");
  const references =
    typeof referencesHeader === "string"
      ? [referencesHeader]
      : Array.isArray(referencesHeader)
        ? referencesHeader.filter((value): value is string => typeof value === "string")
        : [];
  const formatHeader = stringHeader(parsedHeaders, "x-cloud-draft-format");
  const fromAddress = addressList(parsedHeaders.get("from"))[0] ?? null;
  const replyTo = addressList(parsedHeaders.get("reply-to"))[0]?.address ?? null;
  return {
    cloudDraftId: stringHeader(parsedHeaders, "x-cloud-draft-id"),
    cloudRevision: Number.isSafeInteger(cloudRevisionValue) && cloudRevisionValue > 0 ? cloudRevisionValue : null,
    cloudFingerprint: stringHeader(parsedHeaders, "x-cloud-draft-fingerprint"),
    format: formatHeader === "markdown" ? "markdown" : "plain",
    from: fromAddress?.address ?? null,
    fromName: fromAddress?.name ?? "",
    replyTo,
    to: addressList(parsedHeaders.get("to")),
    cc: addressList(parsedHeaders.get("cc")),
    bcc: addressList(parsedHeaders.get("bcc")),
    subject: stringHeader(parsedHeaders, "subject") ?? "",
    body,
    inReplyTo: stringHeader(parsedHeaders, "in-reply-to"),
    references,
    attachments,
  };
};

const parsedFingerprint = (params: { parsed: ParsedRemoteDraft; senderIdentityId: string }): string =>
  draftProviderFingerprint({
    revision: params.parsed.cloudRevision ?? 1,
    senderIdentityId: params.senderIdentityId,
    from: { name: params.parsed.fromName, address: params.parsed.from ?? "unknown@example.invalid" },
    replyTo: params.parsed.replyTo,
    to: params.parsed.to,
    cc: params.parsed.cc,
    bcc: params.parsed.bcc,
    subject: params.parsed.subject,
    body: params.parsed.body,
    format: params.parsed.format,
    inReplyTo: params.parsed.inReplyTo,
    references: params.parsed.references,
    attachments: params.parsed.attachments.map((attachment, index) => ({
      id: crypto.randomUUID(),
      ...attachment,
      filename: attachment.filename || `attachment-${index + 1}`,
    })),
  });

const storeProviderRecovery = async (params: {
  db: SqlClient;
  draftId: string;
  baseRevision: number;
  parsed: ParsedRemoteDraft;
  senderIdentityId: string;
  fingerprint: string;
}): Promise<void> => {
  const content = {
    senderIdentityId: params.senderIdentityId,
    to: params.parsed.to,
    cc: params.parsed.cc,
    bcc: params.parsed.bcc,
    subject: params.parsed.subject,
    body: params.parsed.body,
    format: params.parsed.format,
  };
  const [recovery] = await params.db<{ id: string }[]>`
    WITH inserted AS (
      INSERT INTO mail.draft_recovery_copies (
        draft_id, base_revision, content, content_hash, creator_kind, creator_id,
        has_attachment_snapshot
      )
      SELECT
        ${params.draftId}::uuid,
        ${params.baseRevision},
        ${content}::jsonb,
        ${params.fingerprint},
        'system',
        NULL,
        true
      WHERE NOT EXISTS (
        SELECT 1
        FROM mail.draft_recovery_copies existing
        WHERE existing.draft_id = ${params.draftId}::uuid
          AND existing.base_revision = ${params.baseRevision}
          AND existing.creator_kind = 'system'
          AND existing.creator_id IS NULL
          AND existing.content_hash = ${params.fingerprint}
      )
      RETURNING id
    )
    SELECT id FROM inserted
    UNION ALL
    SELECT existing.id
    FROM mail.draft_recovery_copies existing
    WHERE existing.draft_id = ${params.draftId}::uuid
      AND existing.base_revision = ${params.baseRevision}
      AND existing.creator_kind = 'system'
      AND existing.creator_id IS NULL
      AND existing.content_hash = ${params.fingerprint}
    LIMIT 1
  `;
  if (!recovery) throw new Error("Provider draft recovery copy was not persisted");
  await params.db`
    UPDATE mail.draft_recovery_copies
    SET has_attachment_snapshot = true
    WHERE id = ${recovery.id}::uuid
  `;
  await params.db`
    DELETE FROM mail.draft_recovery_attachments
    WHERE recovery_copy_id = ${recovery.id}::uuid
  `;
  for (let position = 0; position < params.parsed.attachments.length; position += 1) {
    const attachment = params.parsed.attachments[position]!;
    await params.db`
      INSERT INTO mail.draft_recovery_attachments (
        recovery_copy_id, blob_id, filename, content_type, byte_length, content_hash, position
      ) VALUES (
        ${recovery.id}::uuid,
        ${attachment.blobId}::uuid,
        ${attachment.filename},
        ${attachment.contentType},
        ${attachment.byteLength},
        ${attachment.contentHash},
        ${position}
      )
    `;
  }
};

export const resolveRemoteDraftBaseRevision = (params: {
  snapshotRevision: string | number | null;
  headerRevision: number | null;
}): number => {
  const value = Number(params.snapshotRevision ?? params.headerRevision ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : 1;
};

const applyImportedDraft = async (params: {
  snapshot: DbProjection;
  parsed: ParsedRemoteDraft;
  fingerprint: string;
  senderIdentityId: string;
  fence: MailboxTransportFence;
  bindingId: string;
  connectionId: string;
  secretRevision: number;
}): Promise<{ draftId: string; revision: number; state: "active" | "conflict" }> =>
  sql.begin(async (tx) => {
    await assertMailboxTransportFence(params.fence, tx);
    const authority = await resolveMailExecution({
      mailboxId: params.snapshot.mailbox_id,
      operation: "backgroundSync",
      folderRequirements: [{ folderId: params.snapshot.folder_id!, rights: ["read"] }],
      db: tx,
    });
    if (
      !authority.ok ||
      authority.data.remoteResourceId !== params.fence.remoteResourceId ||
      authority.data.bindingId !== params.bindingId ||
      authority.data.connectionId !== params.connectionId ||
      authority.data.secretRevision !== params.secretRevision
    ) {
      throw Object.assign(new Error("Draft import authority changed before commit"), {
        code: "DRAFT_IMPORT_AUTHORITY_CHANGED",
      });
    }
    const [currentIdentity] = await tx<{ id: string }[]>`
      SELECT id
      FROM mail.sender_identities
      WHERE id = ${params.senderIdentityId}::uuid
        AND mailbox_id = ${params.snapshot.mailbox_id}::uuid
        AND status = 'verified'
      FOR SHARE
    `;
    if (!currentIdentity) {
      throw Object.assign(new Error("Draft sender identity changed before import commit"), {
        code: "DRAFT_IMPORT_IDENTITY_CHANGED",
      });
    }
    let draftId = params.parsed.cloudDraftId;
    const [existing] = draftId
      ? await tx<{ id: string; revision: string | number; state: string }[]>`
          SELECT id, revision, state
          FROM mail.drafts
          WHERE id = ${draftId}::uuid
            AND mailbox_id = ${params.snapshot.mailbox_id}::uuid
            AND origin = 'user'
          FOR UPDATE
        `
      : [];
    if (existing) {
      const currentRevision = Number(existing.revision);
      const baseRevision = resolveRemoteDraftBaseRevision({
        snapshotRevision: params.snapshot.cloud_revision,
        headerRevision: params.parsed.cloudRevision,
      });
      if (existing.state !== "draft" || currentRevision !== baseRevision) {
        await storeProviderRecovery({
          db: tx,
          draftId: existing.id,
          baseRevision,
          parsed: params.parsed,
          senderIdentityId: params.senderIdentityId,
          fingerprint: params.fingerprint,
        });
        await tx`
          UPDATE mail.draft_provider_snapshots
          SET
            draft_id = ${existing.id}::uuid,
            cloud_revision = ${currentRevision},
            content_fingerprint = ${params.fingerprint},
            content_snapshot = ${params.parsed}::jsonb,
            state = 'conflict',
            last_error_code = 'DRAFT_CONCURRENT_EDIT',
            last_error_message = 'Cloud and provider draft revisions changed concurrently',
            completed_at = now()
          WHERE id = ${params.snapshot.id}::uuid
        `;
        return { draftId: existing.id, revision: currentRevision, state: "conflict" as const };
      }
      await tx`DELETE FROM mail.draft_attachments WHERE draft_id = ${existing.id}::uuid`;
      await tx`
        UPDATE mail.drafts
        SET
          sender_identity_id = ${params.senderIdentityId}::uuid,
          to_addresses = ${params.parsed.to}::jsonb,
          cc_addresses = ${params.parsed.cc}::jsonb,
          bcc_addresses = ${params.parsed.bcc}::jsonb,
          subject = ${params.parsed.subject},
          body_markdown = ${params.parsed.body},
          body_format = ${params.parsed.format},
          last_editor_kind = 'system',
          last_editor_id = NULL,
          revision = revision + 1
        WHERE id = ${existing.id}::uuid
      `;
      draftId = existing.id;
    } else {
      const [thread] = params.parsed.inReplyTo
        ? await tx<{ conversation_id: string; message_id: string }[]>`
            SELECT link.conversation_id, message.id AS message_id
            FROM mail.message_contents message
            JOIN mail.conversation_messages link ON link.message_id = message.id
            JOIN mail.conversations conversation ON conversation.id = link.conversation_id
            WHERE message.mailbox_id = ${params.snapshot.mailbox_id}::uuid
              AND lower(message.message_id) = lower(${params.parsed.inReplyTo})
              AND conversation.mailbox_id = ${params.snapshot.mailbox_id}::uuid
            ORDER BY message.internal_date DESC, message.id DESC
            LIMIT 1
          `
        : [];
      draftId = crypto.randomUUID();
      await withShortIdDb(
        tx,
        "draft",
        (db, shortId) => db`
        INSERT INTO mail.drafts (
          id, short_id, mailbox_id, conversation_id, intent, source_message_id, sender_identity_id,
          author_kind, author_id, last_editor_kind, last_editor_id, origin,
          to_addresses, cc_addresses, bcc_addresses, subject, body_markdown, body_format
        ) VALUES (
          ${draftId}::uuid,
          ${shortId},
          ${params.snapshot.mailbox_id}::uuid,
          ${thread?.conversation_id ?? null}::uuid,
          ${thread ? "reply" : "new"},
          ${thread?.message_id ?? null}::uuid,
          ${params.senderIdentityId}::uuid,
          'system',
          NULL,
          'system',
          NULL,
          'user',
          ${params.parsed.to}::jsonb,
          ${params.parsed.cc}::jsonb,
          ${params.parsed.bcc}::jsonb,
          ${params.parsed.subject},
          ${params.parsed.body},
          ${params.parsed.format}
        )
      `,
      );
    }
    for (let position = 0; position < params.parsed.attachments.length; position += 1) {
      const attachment = params.parsed.attachments[position]!;
      await withShortIdDb(
        tx,
        "draftAttachment",
        (db, shortId) => db`
        INSERT INTO mail.draft_attachments (
          short_id, draft_id, blob_id, filename, content_type, byte_length, content_hash, position
        ) VALUES (
          ${shortId},
          ${draftId}::uuid,
          ${attachment.blobId}::uuid,
          ${attachment.filename},
          ${attachment.contentType},
          ${attachment.byteLength},
          ${attachment.contentHash},
          ${position}
        )
      `,
      );
    }
    const [updated] = await tx<{ revision: string | number }[]>`
      SELECT revision FROM mail.drafts WHERE id = ${draftId}::uuid
    `;
    if (!updated) throw new Error("Imported draft disappeared before projection commit");
    await tx`
      UPDATE mail.draft_provider_snapshots
      SET
        draft_id = ${draftId}::uuid,
        cloud_revision = ${Number(updated.revision)},
        content_fingerprint = ${params.fingerprint},
        content_snapshot = ${params.parsed}::jsonb,
        state = 'retired',
        last_error_code = NULL,
        last_error_message = NULL,
        completed_at = now(),
        last_seen_at = now()
      WHERE id = ${params.snapshot.id}::uuid
    `;
    await tx`
      UPDATE mail.draft_provider_snapshots
      SET state = 'retired', completed_at = COALESCE(completed_at, now())
      WHERE draft_id = ${draftId}::uuid
        AND direction = 'import'
        AND state = 'active'
    `;
    await tx`
      UPDATE mail.draft_provider_snapshots
      SET state = 'retired', completed_at = COALESCE(completed_at, now())
      WHERE draft_id = ${draftId}::uuid
        AND direction = 'export'
        AND state = 'active'
    `;
    await tx`
      INSERT INTO mail.draft_provider_snapshots (
        mailbox_id, draft_id, cloud_revision, direction, state,
        stable_message_id, content_fingerprint, content_snapshot, mime_blob_id,
        remote_resource_id, binding_id, folder_id, uid_validity, uid, modseq,
        transport_generation, secret_revision, last_seen_at, completed_at
      )
      SELECT
        ${params.snapshot.mailbox_id}::uuid,
        ${draftId}::uuid,
        ${Number(updated.revision)},
        'export',
        'active',
        ${params.snapshot.stable_message_id},
        ${params.fingerprint},
        ${params.parsed}::jsonb,
        ${params.snapshot.mime_blob_id}::uuid,
        ${params.snapshot.remote_resource_id}::uuid,
        ${params.snapshot.binding_id}::uuid,
        ${params.snapshot.folder_id}::uuid,
        ${params.snapshot.uid_validity}::numeric,
        ${params.snapshot.uid}::numeric,
        ${params.snapshot.modseq}::numeric,
        ${params.snapshot.transport_generation},
        ${params.snapshot.secret_revision},
        now(),
        now()
      ON CONFLICT (draft_id, cloud_revision) WHERE direction = 'export' DO UPDATE SET
        state = 'active',
        stable_message_id = EXCLUDED.stable_message_id,
        content_fingerprint = EXCLUDED.content_fingerprint,
        content_snapshot = EXCLUDED.content_snapshot,
        mime_blob_id = EXCLUDED.mime_blob_id,
        remote_resource_id = EXCLUDED.remote_resource_id,
        binding_id = EXCLUDED.binding_id,
        folder_id = EXCLUDED.folder_id,
        uid_validity = EXCLUDED.uid_validity,
        uid = EXCLUDED.uid,
        modseq = EXCLUDED.modseq,
        transport_generation = EXCLUDED.transport_generation,
        secret_revision = EXCLUDED.secret_revision,
        last_seen_at = now(),
        completed_at = now(),
        last_error_code = NULL,
        last_error_message = NULL
    `;
    return { draftId, revision: Number(updated.revision), state: "active" as const };
  });

const processImportSnapshot = async (snapshotId: string, jobHeartbeat: () => Promise<void>): Promise<void> => {
  const [snapshot] = await sql<DbProjection[]>`
    UPDATE mail.draft_provider_snapshots
    SET state = 'importing', attempt = attempt + 1
    WHERE id = ${snapshotId}::uuid
      AND direction = 'import'
      AND state IN ('external', 'importing')
    RETURNING *
  `;
  if (!snapshot || !snapshot.folder_id || !snapshot.uid_validity || !snapshot.uid) return;
  const current = await loadCurrentExecution({
    mailboxId: snapshot.mailbox_id,
    folderId: snapshot.folder_id,
    rights: ["read"],
  });
  const lock = await mailProviderOperationMutex().acquire({
    resource: current.execution.remoteResourceId!,
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
  });
  if (!lock) throw Object.assign(new Error("Mail provider resource is busy"), { code: "SYNC_BUSY" });
  try {
    await withDraftProjectionLeases({
      lock,
      jobHeartbeat,
      work: async (assertLeaseActive, signal) => {
        await assertLeaseActive();
        const execution = await loadCurrentExecution({
          mailboxId: snapshot.mailbox_id,
          folderId: snapshot.folder_id!,
          rights: ["read"],
        });
        const fence = await loadMailboxTransportFence(execution.execution.remoteResourceId!);
        if (!fence) throw Object.assign(new Error("Mailbox transport changed before draft import"), { code: "MAILBOX_TRANSPORT_CHANGED" });
        await assertMailboxTransportFence(fence);
        let mimeBlobId = snapshot.mime_blob_id;
        if (!mimeBlobId) {
          await assertLeaseActive();
          await imapSmtpConnector.downloadSourceBatch(
            execution.runtime,
            execution.folder.path,
            [{ key: snapshot.id, uidValidity: String(snapshot.uid_validity), uid: Number(snapshot.uid) }],
            async (download) => {
              if (download.expectedSize > MAX_IMPORT_SOURCE_BYTES) {
                throw Object.assign(new Error("Remote draft source exceeds the import limit"), { code: "REMOTE_DRAFT_TOO_LARGE" });
              }
              const blob = await storeReadableBlob(download.stream, download.expectedSize);
              await assertLeaseActive();
              mimeBlobId = blob.id;
              await sql`
            UPDATE mail.draft_provider_snapshots
            SET
              mime_blob_id = ${blob.id}::uuid,
              remote_resource_id = ${execution.execution.remoteResourceId}::uuid,
              binding_id = ${execution.execution.bindingId}::uuid,
              transport_generation = ${fence.generation},
              secret_revision = ${execution.execution.secretRevision}
            WHERE id = ${snapshot.id}::uuid
              AND state = 'importing'
          `;
            },
            signal,
          );
        }
        if (!mimeBlobId) throw Object.assign(new Error("Remote draft source was not downloaded"), { code: "REMOTE_DRAFT_SOURCE_MISSING" });
        const parsedBlobId = mimeBlobId;
        await assertLeaseActive();
        await assertMailboxTransportFence(fence);
        const parsed = await parseRemoteDraft(() => createBlobReadable(parsedBlobId));
        await assertLeaseActive();
        if (
          parsed.cloudDraftId &&
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.cloudDraftId)
        ) {
          parsed.cloudDraftId = null;
          parsed.cloudRevision = null;
          parsed.cloudFingerprint = null;
        }
        const [identity] = await sql<{ id: string }[]>`
      SELECT id
      FROM mail.sender_identities
      WHERE mailbox_id = ${snapshot.mailbox_id}::uuid
        AND status = 'verified'
        AND (
          (${parsed.from}::text IS NOT NULL AND lower(from_address) = lower(${parsed.from}))
          OR (${parsed.from}::text IS NULL AND is_default)
        )
      ORDER BY (lower(from_address) = lower(${parsed.from ?? ""})) DESC, is_default DESC, id
      LIMIT 1
    `;
        if (!identity) {
          throw Object.assign(new Error("Remote draft sender does not match a verified sender identity"), {
            code: "REMOTE_DRAFT_SENDER_UNAVAILABLE",
          });
        }
        const fingerprint = parsedFingerprint({ parsed, senderIdentityId: identity.id });
        if (parsed.cloudFingerprint && parsed.cloudFingerprint === fingerprint && parsed.cloudDraftId && parsed.cloudRevision) {
          const [known] = await sql<{ current_revision: string | number }[]>`
        SELECT draft.revision AS current_revision
        FROM mail.drafts draft
        JOIN mail.draft_provider_snapshots projected
          ON projected.draft_id = draft.id
         AND projected.cloud_revision = ${parsed.cloudRevision}
         AND projected.content_fingerprint = ${parsed.cloudFingerprint}
        WHERE draft.id = ${parsed.cloudDraftId}::uuid
          AND draft.mailbox_id = ${snapshot.mailbox_id}::uuid
        LIMIT 1
      `;
          if (known && Number(known.current_revision) >= parsed.cloudRevision) {
            await assertLeaseActive();
            await sql`
          UPDATE mail.draft_provider_snapshots
          SET
            draft_id = ${parsed.cloudDraftId}::uuid,
            cloud_revision = ${parsed.cloudRevision},
            content_fingerprint = ${fingerprint},
            content_snapshot = ${parsed}::jsonb,
            state = 'retired',
            completed_at = now(),
            last_seen_at = now(),
            last_error_code = NULL,
            last_error_message = NULL
          WHERE id = ${snapshot.id}::uuid
        `;
            return;
          }
        }
        await assertLeaseActive();
        await applyImportedDraft({
          snapshot,
          parsed,
          fingerprint,
          senderIdentityId: identity.id,
          fence,
          bindingId: execution.execution.bindingId!,
          connectionId: execution.execution.connectionId!,
          secretRevision: execution.execution.secretRevision!,
        });
      },
    });
  } finally {
    await mailProviderOperationMutex()
      .release(lock)
      .catch(() => false);
  }
};

const PROJECTION_MAX_ATTEMPTS = 8;
const PROJECTION_BACKOFF_MS = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000];

const exportJob = lazySync((sync) =>
  sync.job<{ snapshotId: string }>({
    id: "mail:project-draft",
    delivery: { ackWaitMs: JOB_LEASE_MS, maxAttempts: PROJECTION_MAX_ATTEMPTS, backoffMs: PROJECTION_BACKOFF_MS },
  }),
);
let exportJobWorker: Worker | undefined;
const startExportJob = async (): Promise<void> => {
  exportJobWorker = await exportJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt >= PROJECTION_MAX_ATTEMPTS) {
          await markProjectionFailure(context.input.snapshotId, "needs_attention", error);
          log.error("Draft projection exhausted retries", { snapshotId: context.input.snapshotId, error: error.message });
        }
        return context.attempt >= PROJECTION_MAX_ATTEMPTS
          ? { action: "dead_letter", reason: error instanceof Error ? error.message : String(error) }
          : { action: "retry" };
      },
    },
    async (ctx) => {
      try {
        await processExportSnapshot(ctx.input.snapshotId, () => ctx.heartbeat());
      } catch (error) {
        const code = failureCode(error, "DRAFT_EXPORT_FAILED");
        if (code === "MAILBOX_TRANSPORT_CHANGED") return;
        // A sibling job holds the remote resource: routine contention, not a failed attempt.
        if (code === "SYNC_BUSY") {
          ctx.resubmit({ delayMs: providerBusyRetryDelayMs() });
          return;
        }
        throw error;
      }
    },
  );
};

const importJob = lazySync((sync) =>
  sync.job<{ snapshotId: string }>({
    id: "mail:import-draft",
    delivery: { ackWaitMs: JOB_LEASE_MS, maxAttempts: PROJECTION_MAX_ATTEMPTS, backoffMs: PROJECTION_BACKOFF_MS },
  }),
);
let importJobWorker: Worker | undefined;
const startImportJob = async (): Promise<void> => {
  importJobWorker = await importJob().process(
    {
      onError: async ({ context, error }) => {
        if (context.attempt >= PROJECTION_MAX_ATTEMPTS) {
          await markProjectionFailure(context.input.snapshotId, "needs_attention", error);
          log.error("Draft projection exhausted retries", { snapshotId: context.input.snapshotId, error: error.message });
        }
        return context.attempt >= PROJECTION_MAX_ATTEMPTS
          ? { action: "dead_letter", reason: error instanceof Error ? error.message : String(error) }
          : { action: "retry" };
      },
    },
    async (ctx) => {
      try {
        await processImportSnapshot(ctx.input.snapshotId, () => ctx.heartbeat());
      } catch (error) {
        const code = failureCode(error, "DRAFT_IMPORT_FAILED");
        if (code === "MAILBOX_TRANSPORT_CHANGED") return;
        // A sibling job holds the remote resource: routine contention, not a failed attempt.
        if (code === "SYNC_BUSY") {
          ctx.resubmit({ delayMs: providerBusyRetryDelayMs() });
          return;
        }
        throw error;
      }
    },
  );
};

export const draftExportJobKey = (snapshotId: string): string => `snapshot:${snapshotId}`;

const submitExport = async (snapshotId: string): Promise<void> => {
  await (tasks.run(() => exportJob().submit({ coalesce: true, key: draftExportJobKey(snapshotId), input: { snapshotId } })) ??
    Promise.resolve());
};

export const enqueueDraftProjectionSnapshot = submitExport;

const submitImport = async (snapshotId: string): Promise<void> => {
  await (tasks.run(() => importJob().submit({ coalesce: true, key: `snapshot:${snapshotId}`, input: { snapshotId } })) ??
    Promise.resolve());
};

export const enqueueDraftProjection = async (draftId: string): Promise<void> => {
  const snapshotId = await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId }));
  if (snapshotId) await submitExport(snapshotId);
};

export const remoteDraftNeedsImport = (params: {
  previousModseq: string | number | null;
  currentModseq: string | null;
  fullReconciliation: boolean;
}): boolean => {
  if (params.previousModseq != null || params.currentModseq != null) {
    return String(params.previousModseq ?? "") !== String(params.currentModseq ?? "");
  }
  return params.fullReconciliation;
};

export const recordDraftFolderSyncInTransaction = async (params: {
  db: SqlClient;
  mailboxId: string;
  remoteResourceId: string;
  bindingId: string;
  folderId: string;
  uidValidity: string;
  uidValidityChanged: boolean;
  envelopes: ConnectorEnvelope[];
  reconcileWindow: ReconcileWindow | null;
}): Promise<{ importSnapshotIds: string[]; exportSnapshotIds: string[]; removed: number }> => {
  if (params.uidValidityChanged) {
    await params.db`
      UPDATE mail.draft_provider_snapshots
      SET
        state = 'needs_attention',
        last_error_code = 'UIDVALIDITY_CHANGED',
        last_error_message = 'The provider reset the Drafts-folder UID namespace',
        completed_at = now()
      WHERE folder_id = ${params.folderId}::uuid
        AND uid_validity IS NOT NULL
        AND uid_validity <> ${params.uidValidity}::numeric
        AND state IN ('active', 'appending', 'external', 'importing', 'retiring')
    `;
  }
  const importSnapshotIds: string[] = [];
  const exportSnapshotIds: string[] = [];
  for (const envelope of params.envelopes) {
    const uid = Number(envelope.remoteRef.uid);
    const messageId =
      envelope.messageId?.trim().slice(0, 998) || `<remote-draft-${params.folderId}-${params.uidValidity}-${uid}@cloud.invalid>`;
    const [known] = await params.db<(DbProjection & { remote_identity_match: boolean })[]>`
      SELECT
        *,
        (
          folder_id = ${params.folderId}::uuid
          AND uid_validity = ${params.uidValidity}::numeric
          AND uid = ${uid}::numeric
        ) AS remote_identity_match
      FROM mail.draft_provider_snapshots
      WHERE mailbox_id = ${params.mailboxId}::uuid
        AND (
          (folder_id = ${params.folderId}::uuid
            AND uid_validity = ${params.uidValidity}::numeric
            AND uid = ${uid}::numeric)
          OR lower(stable_message_id) = lower(${messageId})
      )
      ORDER BY
        (
          folder_id = ${params.folderId}::uuid
          AND uid_validity = ${params.uidValidity}::numeric
          AND uid = ${uid}::numeric
        ) DESC,
        (direction = 'export' AND state IN ('active', 'appending', 'retiring')) DESC,
        created_at DESC,
        id DESC
      LIMIT 1
      FOR UPDATE
    `;
    if (known) {
      if (!known.remote_identity_match) {
        if (known.direction === "export" && known.draft_id && known.cloud_revision != null) {
          const [remapped] = await params.db<{ id: string; state: ProjectionState }[]>`
            UPDATE mail.draft_provider_snapshots projection
            SET
              state = CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM mail.drafts draft
                  WHERE draft.id = projection.draft_id
                    AND draft.state = 'draft'
                    AND draft.revision = projection.cloud_revision
                ) THEN 'active'
                ELSE 'retiring'
              END,
              remote_resource_id = ${params.remoteResourceId}::uuid,
              binding_id = ${params.bindingId}::uuid,
              folder_id = ${params.folderId}::uuid,
              uid_validity = ${params.uidValidity}::numeric,
              uid = ${uid}::numeric,
              modseq = ${envelope.remoteRef.modseq}::numeric,
              last_seen_at = now(),
              completed_at = CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM mail.drafts draft
                  WHERE draft.id = projection.draft_id
                    AND draft.state = 'draft'
                    AND draft.revision = projection.cloud_revision
                ) THEN now()
                ELSE NULL
              END,
              last_error_code = NULL,
              last_error_message = NULL
            WHERE projection.id = ${known.id}::uuid
              AND projection.state = 'needs_attention'
              AND projection.last_error_code = 'UIDVALIDITY_CHANGED'
            RETURNING projection.id, projection.state
          `;
          if (remapped) {
            if (remapped.state === "retiring") exportSnapshotIds.push(remapped.id);
            continue;
          }
        }
        const [observation] = await params.db<{ id: string }[]>`
          INSERT INTO mail.draft_provider_snapshots (
            mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id,
            remote_resource_id, binding_id, folder_id, uid_validity, uid, modseq, last_seen_at
          ) VALUES (
            ${params.mailboxId}::uuid,
            ${known.draft_id}::uuid,
            ${known.cloud_revision},
            'import',
            'external',
            ${messageId},
            ${params.remoteResourceId}::uuid,
            ${params.bindingId}::uuid,
            ${params.folderId}::uuid,
            ${params.uidValidity}::numeric,
            ${uid}::numeric,
            ${envelope.remoteRef.modseq}::numeric,
            now()
          )
          RETURNING id
        `;
        if (observation) importSnapshotIds.push(observation.id);
        continue;
      }
      const remoteChanged = remoteDraftNeedsImport({
        previousModseq: known.modseq,
        currentModseq: envelope.remoteRef.modseq,
        fullReconciliation: params.reconcileWindow != null,
      });
      await params.db`
        UPDATE mail.draft_provider_snapshots
        SET
          remote_resource_id = ${params.remoteResourceId}::uuid,
          binding_id = ${params.bindingId}::uuid,
          folder_id = ${params.folderId}::uuid,
          uid_validity = ${params.uidValidity}::numeric,
          uid = ${uid}::numeric,
          modseq = ${envelope.remoteRef.modseq}::numeric,
          mime_blob_id = CASE
            WHEN ${remoteChanged} AND direction = 'import' THEN NULL
            ELSE mime_blob_id
          END,
          last_seen_at = now()
        WHERE id = ${known.id}::uuid
      `;
      if (remoteChanged && (known.state === "active" || known.state === "retired") && known.direction === "export") {
        const [observation] = await params.db<{ id: string }[]>`
          INSERT INTO mail.draft_provider_snapshots (
            mailbox_id, draft_id, cloud_revision, direction, state, stable_message_id,
            remote_resource_id, binding_id, folder_id, uid_validity, uid, modseq, last_seen_at
          ) VALUES (
            ${params.mailboxId}::uuid,
            ${known.draft_id}::uuid,
            ${known.cloud_revision},
            'import',
            'external',
            ${messageId},
            ${params.remoteResourceId}::uuid,
            ${params.bindingId}::uuid,
            ${params.folderId}::uuid,
            ${params.uidValidity}::numeric,
            ${uid}::numeric,
            ${envelope.remoteRef.modseq}::numeric,
            now()
          )
          RETURNING id
        `;
        if (observation) importSnapshotIds.push(observation.id);
        continue;
      }
      if (known.direction === "import" && ["external", "importing"].includes(known.state)) importSnapshotIds.push(known.id);
      continue;
    }
    const [created] = await params.db<{ id: string }[]>`
      INSERT INTO mail.draft_provider_snapshots (
        mailbox_id, direction, state, stable_message_id,
        remote_resource_id, binding_id, folder_id, uid_validity, uid, modseq, last_seen_at
      ) VALUES (
        ${params.mailboxId}::uuid,
        'import',
        'external',
        ${messageId},
        ${params.remoteResourceId}::uuid,
        ${params.bindingId}::uuid,
        ${params.folderId}::uuid,
        ${params.uidValidity}::numeric,
        ${uid}::numeric,
        ${envelope.remoteRef.modseq}::numeric,
        now()
      )
      RETURNING id
    `;
    if (created) importSnapshotIds.push(created.id);
  }
  let removed = 0;
  if (params.reconcileWindow) {
    const existing = [...new Set(params.reconcileWindow.uids)];
    const result = await params.db`
      UPDATE mail.draft_provider_snapshots
      SET
        state = 'needs_attention',
        last_error_code = 'REMOTE_DRAFT_MISSING',
        last_error_message = 'The projected draft disappeared from the provider',
        completed_at = now()
      WHERE folder_id = ${params.folderId}::uuid
        AND uid_validity = ${params.uidValidity}::numeric
        AND uid BETWEEN ${params.reconcileWindow.low} AND ${params.reconcileWindow.high}
        AND NOT (uid = ANY(${toPgTextArray(existing.map(String))}::numeric[]))
        AND state IN ('active', 'appending', 'external', 'importing', 'retiring')
    `;
    removed = result.count;
  }
  return {
    importSnapshotIds: [...new Set(importSnapshotIds)],
    exportSnapshotIds: [...new Set(exportSnapshotIds)],
    removed,
  };
};

export const enqueueDraftImports = async (snapshotIds: readonly string[]): Promise<void> => {
  await Promise.all([...new Set(snapshotIds)].map((snapshotId) => submitImport(snapshotId)));
};

export const submitDueDraftProjectionWork = async (): Promise<{ exports: number; imports: number }> => {
  await sql`
    UPDATE mail.draft_provider_snapshots
    SET mime_blob_id = NULL
    WHERE state = 'retired'
      AND mime_blob_id IS NOT NULL
      AND completed_at < now() - interval '24 hours'
  `;
  const drafts = await sql<{ id: string }[]>`
    SELECT draft.id
    FROM mail.drafts draft
    JOIN mail.mailboxes mailbox ON mailbox.id = draft.mailbox_id
    WHERE draft.origin = 'user'
      AND mailbox.sync_enabled = true
      AND mailbox.deleted_at IS NULL
      AND (
        (
          draft.state = 'draft'
          AND NOT EXISTS (
            SELECT 1
            FROM mail.draft_provider_snapshots snapshot
            WHERE snapshot.draft_id = draft.id
              AND snapshot.cloud_revision = draft.revision
              AND snapshot.direction = 'export'
          )
        )
        OR (
          draft.state <> 'draft'
          AND EXISTS (
            SELECT 1
            FROM mail.draft_provider_snapshots snapshot
            WHERE snapshot.draft_id = draft.id
              AND snapshot.direction = 'export'
              AND snapshot.state = 'active'
          )
        )
      )
    ORDER BY draft.updated_at, draft.id
    LIMIT 500
  `;
  for (const draft of drafts) {
    await sql.begin((tx) => queueDraftProjectionInTransaction({ db: tx, draftId: draft.id }));
  }
  const exports = await sql<{ id: string; draft_id: string }[]>`
    SELECT DISTINCT ON (draft_id) id, draft_id
    FROM mail.draft_provider_snapshots
    WHERE direction = 'export'
      AND draft_id IS NOT NULL
      AND state IN ('prepared', 'appending', 'retiring')
    ORDER BY draft_id, cloud_revision DESC, created_at DESC
    LIMIT 500
  `;
  const imports = await sql<{ id: string }[]>`
    SELECT id
    FROM mail.draft_provider_snapshots
    WHERE direction = 'import' AND state IN ('external', 'importing')
    ORDER BY updated_at, id
    LIMIT 500
  `;
  await Promise.all(exports.map((snapshot) => submitExport(snapshot.id)));
  await Promise.all(imports.map((snapshot) => submitImport(snapshot.id)));
  return { exports: exports.length, imports: imports.length };
};

export const startDraftProjectionRuntime = async (): Promise<void> => {
  tasks.open();
  await startExportJob();
  await startImportJob();
  await submitDueDraftProjectionWork();
};

export const stopDraftProjectionRuntime = async (): Promise<void> => {
  tasks.close();
  await stopRuntimeJobs(
    tasks,
    [exportJobWorker, importJobWorker].filter((worker): worker is Worker => worker !== undefined),
  );
};
