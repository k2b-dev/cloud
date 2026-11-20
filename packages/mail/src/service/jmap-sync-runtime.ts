import { sql } from "@k2b/cloud";
import { toPgTextArray, toPgUuidArray } from "@k2b/cloud/services/postgres";
import { notifyWorkflowWorker } from "@k2b/cloud/workflows/store";
import { MAIL_WORKFLOW_APP_ID } from "../workflows/events";
import { projectJmapFolders } from "./bindings";
import { ENVELOPE_BATCH_SIZE } from "./connectors/contract";
import { jmapMailboxBudget } from "./connectors/jmap";
import { JmapError, type JmapSession } from "./connectors/jmap-client";
import {
  type JmapEmailDelta,
  type JmapMailboxDelta,
  JmapReconciliationRequiredError,
  readJmapEmailDelta,
  readJmapMailboxDelta,
} from "./connectors/jmap-delta";
import { mapJmapEmailSnapshot } from "./connectors/jmap-email";
import { type JmapSyncState, readJmapSyncState, serializeJmapSyncState } from "./connectors/jmap-sync-state";
import { type JmapTransportDependencies, JmapTransportError } from "./connectors/jmap-transport";
import { keepLastKeptPlacements } from "./conversation-keep-rules";
import { isTrashOrJunkFolder } from "./follow-up-scope";
import { enqueueMailInvalidation, mailLive } from "./live";
import { type JmapScopeEvidence, jmapScopeFingerprint } from "./provider-identity";
import { claimFence, ingestEnvelope } from "./sync-runtime";

type Account = {
  db?: typeof sql;
  remoteResourceId: string;
  bindingId: string;
  secretRevision: number;
  session: JmapSession;
  accountId: string;
  signal: AbortSignal;
  captureWorkflowTriggers: boolean;
};
type Batch =
  | { kind: "mailbox"; delta: JmapMailboxDelta }
  | { kind: "email"; delta: JmapEmailDelta; mailboxState: Pick<JmapMailboxDelta, "oldState" | "newState"> };
type Stats = { imported: number; memberships: number; flagsUpdated: number; removed: number; folders: number; skippedDrafts: number };
export type JmapAccountCommitResult =
  | { status: "committed"; hasMore: boolean; stats: Stats }
  | { status: "superseded"; cause: "account_changed" | "folders_required" };
export type JmapAccountSyncResult =
  | JmapAccountCommitResult
  | { status: "reconciliation_required"; cause: JmapReconciliationRequiredError["cause"] };

export class JmapInitialSyncRequiredError extends Error {
  readonly code = "JMAP_INITIAL_SYNC_REQUIRED";
  constructor() {
    super("JMAP_INITIAL_SYNC_REQUIRED");
    this.name = "JmapInitialSyncRequiredError";
  }
}
class Superseded extends Error {
  constructor(readonly reason: "account_changed" | "folders_required") {
    super("JMAP_SYNC_SUPERSEDED");
  }
}
const assertActive = (signal: AbortSignal) => {
  if (signal.aborted) throw new JmapTransportError("JMAP_ABORTED");
};
const evidenceOf = (account: Account): JmapScopeEvidence => ({
  version: 1,
  kind: "jmap",
  origin: account.session.origin,
  accountId: account.accountId,
});

/** Inbox first, then opaque mailbox IDs in text order, independent of locale. */
export function orderJmapMemberships<T extends { mailboxId: string; role: string }>(folders: readonly T[]): T[] {
  return [...folders].sort(
    (a, b) =>
      Number(b.role === "inbox") - Number(a.role === "inbox") || (a.mailboxId < b.mailboxId ? -1 : a.mailboxId > b.mailboxId ? 1 : 0),
  );
}
export function diffJmapMemberships(desired: readonly string[], active: readonly string[]) {
  const wanted = new Set(desired);
  const present = new Set(active);
  return { add: [...wanted].filter((id) => !present.has(id)), remove: [...present].filter((id) => !wanted.has(id)) };
}

function validateBatch(params: Account & { beforeState: JmapSyncState; batch: Batch }) {
  const { batch, beforeState } = params;
  serializeJmapSyncState(beforeState);
  const delta = batch.delta;
  const ids =
    batch.kind === "email"
      ? [...batch.delta.createdIds, ...batch.delta.updatedIds, ...batch.delta.destroyedIds]
      : [
          ...batch.delta.created.map((folder) => folder.mailboxId),
          ...batch.delta.updated.map((folder) => folder.mailboxId),
          ...batch.delta.destroyedIds,
          ...batch.delta.notFoundIds,
        ];
  const limit =
    batch.kind === "email"
      ? Math.min(ENVELOPE_BATCH_SIZE, params.session.core.maxObjectsInGet)
      : jmapMailboxBudget(params.session, params.accountId).batchSize;
  if (
    ids.length > limit ||
    new Set(ids).size !== ids.length ||
    delta.oldState !== (batch.kind === "email" ? beforeState.emailState : beforeState.mailboxState) ||
    (delta.hasMoreChanges && delta.oldState === delta.newState)
  ) {
    throw new JmapError("JMAP_INVALID_RESPONSE");
  }
  if (batch.kind === "email") {
    if (batch.mailboxState.oldState !== beforeState.mailboxState) throw new JmapError("JMAP_INVALID_RESPONSE");
    const expected = new Set([...batch.delta.createdIds, ...batch.delta.updatedIds]);
    for (const id of [...batch.delta.objects.map((email) => email.id), ...batch.delta.notFoundIds]) {
      if (!expected.delete(id)) throw new JmapError("JMAP_INVALID_RESPONSE");
    }
    if (expected.size) throw new JmapError("JMAP_INVALID_RESPONSE");
  }
}

/** One reader page, no network and no hydration. The resource serializes all account writes. */
export async function commitJmapAccountBatch(
  params: Account & {
    fence: Awaited<ReturnType<typeof claimFence>>;
    beforeState: JmapSyncState;
    batch: Batch;
  },
): Promise<JmapAccountCommitResult> {
  assertActive(params.signal);
  validateBatch(params);
  const { batch, beforeState, fence } = params;
  const nextState = serializeJmapSyncState({
    ...beforeState,
    ...(batch.kind === "mailbox"
      ? { mailboxState: batch.delta.newState }
      : { emailState: batch.delta.newState, mailboxState: batch.mailboxState.newState }),
  });
  const evidence = evidenceOf(params);
  const fingerprint = jmapScopeFingerprint(evidence);
  try {
    const result = await (params.db ?? sql).begin(async (tx) => {
      const [resource] = await tx<{ mailbox_id: string; discovery_generation: string | number; recovering: boolean }[]>`
        SELECT resource.mailbox_id, resource.discovery_generation,
          (resource.status = 'degraded' OR resource.last_error_code IS NOT NULL OR resource.last_error_message IS NOT NULL
            OR mailbox.health <> 'active' OR mailbox.health_reason IS NOT NULL OR COALESCE((
              SELECT terminal.state = 'failed' FROM mail.sync_runs terminal
              WHERE terminal.remote_resource_id = resource.id AND terminal.state <> 'running'
                AND NOT (terminal.stats ? 'folderId')
              ORDER BY terminal.started_at DESC, terminal.id DESC LIMIT 1
            ), false)) AS recovering
        FROM mail.remote_resources resource JOIN mail.mailboxes mailbox ON mailbox.id = resource.mailbox_id
        JOIN mail.sync_runs run ON run.remote_resource_id = resource.id AND run.id = ${fence.runId}::uuid
        WHERE resource.id = ${params.remoteResourceId}::uuid AND resource.connector_kind = 'jmap'
          AND resource.current_fence_token = ${fence.token} AND resource.sync_generation = ${fence.generation}
          AND resource.status IN ('active', 'degraded') AND resource.scope_fingerprint = ${fingerprint}
          AND resource.sync_state = ${beforeState}::jsonb AND mailbox.sync_enabled AND mailbox.deleted_at IS NULL
          AND run.state = 'running' AND run.binding_id = ${params.bindingId}::uuid
          AND run.fence_token = ${fence.token} AND run.generation = ${fence.generation}
        FOR UPDATE OF resource
      `;
      if (!resource) throw new Superseded("account_changed");
      const stats: Stats = { imported: 0, memberships: 0, flagsUpdated: 0, removed: 0, folders: 0, skippedDrafts: 0 };
      const missingMailboxIds = batch.kind === "mailbox" ? [...batch.delta.destroyedIds, ...batch.delta.notFoundIds] : [];
      if (batch.kind === "mailbox") {
        const folders = [...batch.delta.created, ...batch.delta.updated];
        stats.folders = folders.length + missingMailboxIds.length;
        if (stats.folders)
          await projectJmapFolders(tx, {
            remoteResourceId: params.remoteResourceId,
            bindingId: params.bindingId,
            discoveryGeneration: Number(resource.discovery_generation),
            evidence,
            folders,
            inventory: { kind: "delta", missingMailboxIds },
          });
      }
      const emails = batch.kind === "email" ? batch.delta.objects.map(mapJmapEmailSnapshot) : [];
      const emailIds = batch.kind === "email" ? [...batch.delta.createdIds, ...batch.delta.updatedIds, ...batch.delta.destroyedIds] : [];
      const refs = emailIds.length
        ? await tx<{ id: string; remote_id: string; message_id: string; folder_id: string; active: boolean }[]>`
        SELECT ref.id, ref.remote_id, ref.message_id, ref.folder_id,
          (ref.stale_at IS NULL AND placement.remote_message_ref_id IS NOT NULL AND placement.deleted_at IS NULL) AS active
        FROM mail.remote_message_refs ref JOIN mail.folders folder ON folder.id = ref.folder_id
        LEFT JOIN mail.message_placements placement ON placement.remote_message_ref_id = ref.id
        WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
          AND ref.remote_id = ANY(${toPgTextArray(emailIds)}::text[])
      `
        : [];
      const mailboxIds = [...new Set(emails.flatMap((email) => email.mailboxIds))];
      const refFolderIds = [...new Set(refs.map((ref) => ref.folder_id))];
      // Match commitSyncBatch: resource first, affected folders by ID, then binding/connection.
      // In particular, do not hold a mailbox UPDATE lock while setFolderRole holds a folder.
      const folders =
        mailboxIds.length || refFolderIds.length
          ? await tx<
              {
                id: string;
                stable_key: string;
                mailbox_id: string | null;
                role: string;
                active: boolean;
                excluded: boolean;
                drafts: boolean;
              }[]
            >`
        SELECT folder.id, folder.stable_key, ref.remote_folder_id AS mailbox_id,
          COALESCE(role_override.role, folder.role) AS role,
          (ref.missing_since IS NULL AND ref.remote_folder_id IS NOT NULL AND folder.discovery_state = 'active') AS active,
          ${isTrashOrJunkFolder(sql`folder.id`)} AS excluded,
          (EXISTS (SELECT 1 FROM mail.folder_role_overrides override
            WHERE override.mailbox_id = ${resource.mailbox_id}::uuid AND override.role = 'drafts' AND override.folder_id = folder.id)
            OR (folder.role = 'drafts' AND NOT EXISTS (SELECT 1 FROM mail.folder_role_overrides override
              WHERE override.mailbox_id = ${resource.mailbox_id}::uuid AND override.role = 'drafts'))) AS drafts
        FROM mail.folders folder
        LEFT JOIN mail.binding_folder_refs ref ON ref.folder_id = folder.id AND ref.binding_id = ${params.bindingId}::uuid
        LEFT JOIN mail.folder_role_overrides role_override
          ON role_override.folder_id = folder.id AND role_override.mailbox_id = ${resource.mailbox_id}::uuid
        WHERE folder.remote_resource_id = ${params.remoteResourceId}::uuid
          AND (ref.remote_folder_id = ANY(${toPgTextArray(mailboxIds)}::text[])
            OR folder.id = ANY(${toPgUuidArray(refFolderIds)}::uuid[]))
        ORDER BY folder.id FOR UPDATE OF folder
      `
          : [];
      const byMailbox = new Map(folders.filter((folder) => folder.mailbox_id !== null).map((folder) => [folder.mailbox_id, folder]));
      // Validate every membership before filtering drafts: never silently lose an unknown mailbox.
      for (const email of emails)
        for (const id of email.mailboxIds) {
          // Schnitt 5's account job must escalate repeated folders_required to reconciliation.
          if (!byMailbox.get(id)?.active) throw new Superseded("folders_required");
        }
      const [binding] = await tx<{ connection_id: string; recovering: boolean }[]>`
        SELECT binding.connection_id,
          (binding.last_error_code IS NOT NULL OR binding.last_error_message IS NOT NULL) AS recovering
        FROM mail.provider_bindings binding
        WHERE binding.id = ${params.bindingId}::uuid AND binding.remote_resource_id = ${params.remoteResourceId}::uuid
          AND binding.state = 'active' AND binding.verified_scope_fingerprint = ${fingerprint}
          AND binding.verified_secret_revision = ${params.secretRevision}
        FOR NO KEY UPDATE OF binding
      `;
      if (!binding) throw new Superseded("account_changed");
      const [connection] = await tx<{ recovering: boolean }[]>`
        SELECT (last_error_code IS NOT NULL OR last_error_message IS NOT NULL) AS recovering
        FROM mail.provider_connections
        WHERE id = ${binding.connection_id}::uuid AND secret_revision = ${params.secretRevision}
          AND connector_kind = 'jmap' AND status = 'active' AND encrypted_secret IS NOT NULL
        FOR NO KEY UPDATE
      `;
      if (!connection) throw new Superseded("account_changed");
      const byEmail = new Map<string, (typeof refs)[number][]>();
      for (const ref of refs) {
        const entries = byEmail.get(ref.remote_id) ?? [];
        entries.push(ref);
        byEmail.set(ref.remote_id, entries);
      }
      const deletedIds = new Set(batch.kind === "email" ? [...batch.delta.destroyedIds, ...batch.delta.notFoundIds] : []);
      const removeRefIds = refs.filter((ref) => deletedIds.has(ref.remote_id)).map((ref) => ref.id);
      const created = new Set(batch.kind === "email" ? batch.delta.createdIds : []);
      let wakeWorkflow = false;
      for (const email of emails) {
        assertActive(params.signal);
        const existing = byEmail.get(email.emailId) ?? [];
        if (new Set(existing.map((ref) => ref.message_id)).size > 1)
          throw Object.assign(new Error("JMAP_MESSAGE_IDENTITY_CONFLICT"), { code: "JMAP_MESSAGE_IDENTITY_CONFLICT" });
        const memberships = email.mailboxIds.flatMap((id) => {
          const folder = byMailbox.get(id);
          return folder ? [{ ...folder, mailboxId: id }] : [];
        });
        const draft = email.envelope.flags.includes("\\Draft");
        const desired = orderJmapMemberships(memberships.filter((folder) => !draft && !folder.drafts));
        stats.skippedDrafts += Number(draft || memberships.some((folder) => folder.drafts));
        const diff = diffJmapMemberships(
          desired.map((folder) => folder.id),
          existing.filter((ref) => ref.active).map((ref) => ref.folder_id),
        );
        const unwanted = new Set(diff.remove);
        removeRefIds.push(...existing.filter((ref) => unwanted.has(ref.folder_id)).map((ref) => ref.id));
        const receive =
          params.captureWorkflowTriggers &&
          existing.length === 0 &&
          created.has(email.emailId) &&
          !memberships.some((folder) => folder.excluded);
        for (const [index, folder] of desired.entries()) {
          if (!diff.add.includes(folder.id)) continue;
          await ingestEnvelope({
            db: tx,
            mailboxId: resource.mailbox_id,
            remoteResourceId: params.remoteResourceId,
            folderId: folder.id,
            message: { ...email.envelope, remoteRef: { kind: "jmap", emailId: email.emailId, folderStableKey: folder.stable_key } },
            captureWorkflowTriggers: receive && index === 0,
          });
          stats.memberships++;
          if (index === 0 && existing.length === 0) stats.imported++;
          if (receive && index === 0) wakeWorkflow = true;
        }
      }
      // New memberships already retired stale kept copies through ingestEnvelope. Remove old ones afterwards.
      const removed = removeRefIds.length
        ? await tx<{ remote_message_ref_id: string }[]>`
        WITH stale AS (
          UPDATE mail.remote_message_refs ref SET stale_at = now()
          FROM mail.folders folder
          WHERE ref.folder_id = folder.id AND folder.remote_resource_id = ${params.remoteResourceId}::uuid
            AND ref.stale_at IS NULL AND ref.remote_id IS NOT NULL
            AND ref.id = ANY(${toPgUuidArray(removeRefIds)}::uuid[])
          RETURNING ref.id
        )
        UPDATE mail.message_placements placement SET deleted_at = now(), updated_at = now()
        FROM stale WHERE placement.remote_message_ref_id = stale.id AND placement.deleted_at IS NULL
        RETURNING placement.remote_message_ref_id
      `
        : [];
      stats.removed = removed.length;
      if (removed.length)
        await keepLastKeptPlacements(
          tx,
          removed.map((row) => row.remote_message_ref_id),
        );
      const [flags] = emails.length
        ? await tx<{ count: number }[]>`
        WITH incoming AS (
          SELECT entry ->> 'emailId' AS email_id,
            ARRAY(SELECT jsonb_array_elements_text(entry -> 'flags')) AS flags,
            ARRAY(SELECT jsonb_array_elements_text(entry -> 'labels')) AS labels
          FROM jsonb_array_elements(${emails.map((email) => ({ emailId: email.emailId, flags: email.envelope.flags, labels: email.envelope.labels }))}::jsonb) entry
        ), changed AS (
          UPDATE mail.message_placements placement SET flags = incoming.flags, keywords = incoming.labels, updated_at = now()
          FROM incoming, mail.remote_message_refs ref, mail.folders folder
          WHERE ref.remote_id = incoming.email_id AND ref.folder_id = folder.id
            AND folder.remote_resource_id = ${params.remoteResourceId}::uuid AND ref.stale_at IS NULL
            AND placement.remote_message_ref_id = ref.id AND placement.deleted_at IS NULL
            AND (placement.flags, placement.keywords) IS DISTINCT FROM (incoming.flags, incoming.labels)
          RETURNING placement.remote_message_ref_id
        ) SELECT count(*)::int AS count FROM changed
      `
        : [];
      stats.flagsUpdated = flags?.count ?? 0;
      const changed = stats.memberships > 0 || stats.flagsUpdated > 0 || stats.removed > 0 || stats.folders > 0;
      const recovering = resource.recovering || binding.recovering || connection.recovering;
      // Like confirmUnchangedFolder, quiet polls leave binding usage alone and refresh sync time at most once a minute.
      if (changed || recovering)
        await tx`UPDATE mail.provider_bindings SET last_used_at = now(), last_error_code = NULL, last_error_message = NULL
          WHERE id = ${params.bindingId}::uuid`;
      if (connection.recovering)
        await tx`UPDATE mail.provider_connections SET last_error_code = NULL, last_error_message = NULL
          WHERE id = ${binding.connection_id}::uuid`;
      await tx`UPDATE mail.remote_resources SET sync_state = ${nextState}::jsonb,
        last_sync_at = CASE WHEN ${changed || recovering} OR last_sync_at IS NULL OR last_sync_at < now() - interval '1 minute'
          THEN now() ELSE last_sync_at END, status = 'active', last_error_code = NULL, last_error_message = NULL
        WHERE id = ${params.remoteResourceId}::uuid AND (${changed || recovering} OR sync_state IS DISTINCT FROM ${nextState}::jsonb
          OR last_sync_at IS NULL OR last_sync_at < now() - interval '1 minute')`;
      // Same late NO KEY UPDATE mailbox lock as commitSyncBatch; recheck pause/delete after acquiring it.
      const [mailbox] = await tx<{ id: string }[]>`
        WITH eligible AS MATERIALIZED (
          SELECT id FROM mail.mailboxes WHERE id = ${resource.mailbox_id}::uuid AND sync_enabled AND deleted_at IS NULL
          FOR NO KEY UPDATE
        ), cleared AS (
          UPDATE mail.mailboxes mailbox SET health = 'active', health_reason = NULL FROM eligible
          WHERE mailbox.id = eligible.id AND (mailbox.health, mailbox.health_reason) IS DISTINCT FROM ('active', NULL)
        ) SELECT id FROM eligible
      `;
      if (!mailbox) throw new Superseded("account_changed");
      // The resource lock serializes replay checks; the run needs only its final UPDATE/DELETE lock.
      const [finished] =
        !changed && !recovering
          ? await tx<{ id: string }[]>`DELETE FROM mail.sync_runs WHERE id = ${fence.runId}::uuid AND state = 'running' RETURNING id`
          : await tx<{ id: string }[]>`UPDATE mail.sync_runs SET state = 'completed', cursor_before = ${beforeState}::jsonb,
        cursor_after = ${nextState}::jsonb, stats = ${stats}::jsonb, finished_at = now()
        WHERE id = ${fence.runId}::uuid AND state = 'running' RETURNING id`;
      if (!finished) throw new Superseded("account_changed");
      if (changed) await enqueueMailInvalidation(tx, { mailboxId: resource.mailbox_id });
      assertActive(params.signal);
      return { stats, changed, wakeWorkflow };
    });
    // Durable rows above are sufficient if the process exits before either advisory wake.
    if (result.changed) mailLive.wake();
    // Like IMAP, the wake is advisory: shared ingest may have suppressed an outbound receipt.
    if (result.wakeWorkflow) notifyWorkflowWorker(MAIL_WORKFLOW_APP_ID);
    return { status: "committed", hasMore: batch.delta.hasMoreChanges, stats: result.stats };
  } catch (error) {
    if (error instanceof Superseded) return { status: "superseded", cause: error.reason };
    throw error;
  }
}

/**
 * A single bounded page. Folders always catch up before any email page is read.
 *
 * The caller holds the mailbox's provider lease, as the IMAP sync does: the lease keeps credential,
 * binding and mailbox administration, which lock the mailbox first, away from this commit.
 */
export async function syncJmapAccountDelta(
  params: Account & { authorization: string; transport?: JmapTransportDependencies },
): Promise<JmapAccountSyncResult> {
  assertActive(params.signal);
  const db = params.db ?? sql;
  const [resource] = await db<{ sync_state: unknown; secret_revision: number }[]>`
    SELECT resource.sync_state, connection.secret_revision FROM mail.remote_resources resource
    JOIN mail.provider_bindings binding ON binding.remote_resource_id = resource.id
    JOIN mail.provider_connections connection ON connection.id = binding.connection_id
    WHERE resource.id = ${params.remoteResourceId}::uuid AND binding.id = ${params.bindingId}::uuid
      AND resource.connector_kind = 'jmap' AND resource.scope_fingerprint = ${jmapScopeFingerprint(evidenceOf(params))}
      AND binding.state = 'active' AND binding.verified_scope_fingerprint = resource.scope_fingerprint
      AND binding.verified_secret_revision = connection.secret_revision
  `;
  if (!resource || resource.secret_revision !== params.secretRevision) return { status: "superseded", cause: "account_changed" };
  const beforeState = readJmapSyncState(resource.sync_state);
  if (!beforeState || beforeState.mailboxState === null || beforeState.emailState === null) throw new JmapInitialSyncRequiredError();
  let fence: Awaited<ReturnType<typeof claimFence>>;
  try {
    fence = await claimFence(params.remoteResourceId, params.bindingId, "incremental", undefined, db);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "MAILBOX_TRANSPORT_CHANGED")
      return { status: "superseded", cause: "account_changed" };
    throw error;
  }
  const finish = async (code: string, state: "failed" | "stale_fence") => {
    await db`UPDATE mail.sync_runs run SET state = ${state}, error_code = ${code},
      error_message = 'JMAP synchronization did not commit', finished_at = now()
      FROM mail.remote_resources resource WHERE run.id = ${fence.runId}::uuid AND run.state = 'running'
        AND resource.id = run.remote_resource_id AND resource.current_fence_token = ${fence.token}`;
  };
  try {
    const folders = await readJmapMailboxDelta(
      params.session,
      params.authorization,
      params.accountId,
      beforeState.mailboxState,
      params.signal,
      params.transport,
    );
    const folderPending =
      folders.hasMoreChanges ||
      folders.created.length + folders.updated.length + folders.destroyedIds.length + folders.notFoundIds.length > 0;
    const batch: Batch = folderPending
      ? { kind: "mailbox", delta: folders }
      : {
          kind: "email",
          mailboxState: { oldState: folders.oldState, newState: folders.newState },
          delta: await readJmapEmailDelta(
            params.session,
            params.authorization,
            params.accountId,
            beforeState.emailState,
            params.signal,
            params.transport,
          ),
        };
    const result = await commitJmapAccountBatch({ ...params, fence, beforeState, batch });
    if (result.status === "superseded") await finish("JMAP_SYNC_SUPERSEDED", "stale_fence");
    // Even the final folder page leaves the email axis for the next call.
    return result.status === "committed" && folderPending ? { ...result, hasMore: true } : result;
  } catch (error) {
    await finish(error instanceof JmapReconciliationRequiredError ? error.code : "JMAP_SYNC_FAILED", "failed");
    if (error instanceof JmapReconciliationRequiredError) return { status: "reconciliation_required", cause: error.cause };
    throw error;
  }
}
