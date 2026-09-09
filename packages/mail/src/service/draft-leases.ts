import { err, fail, ok, type Result } from "@k2b/stdlib";
import type { Lock } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { sql } from "bun";
import type { AcquiredDraftLease, DraftLease, DraftLeaseHolder } from "../contracts";
import { requireMailboxPermission } from "./access";
import type { MailRequestContext } from "./auth";
import { hasCurrentMailboxUserPermission } from "./collaborators";
import { notifyMailInvalidations } from "./events";

const DRAFT_LEASE_TTL_MS = 30_000;
const DRAFT_LEASE_STATE_TTL_MS = 30_000;
export const DRAFT_LEASE_HEARTBEAT_INTERVAL_MS = 10_000;

type DraftLeaseEntry = {
  holder: DraftLeaseHolder;
  token: string;
  lock: { resource: string; ownerToken: string; fence: string; expiresAt: string };
  acquiredAt: number;
};

const leaseStore = lazySync((sync) =>
  sync.ephemeral<DraftLeaseEntry>({
    id: "mail.draft-leases",
    ttlMs: DRAFT_LEASE_TTL_MS,
    maxEntries: 1,
    maxValueBytes: 4_000,
  }),
);

const leaseMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:draft-leases",
    ttlMs: DRAFT_LEASE_TTL_MS,
    retry: { maxAttempts: 1 },
  }),
);

const stateMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:draft-lease-state",
    ttlMs: DRAFT_LEASE_STATE_TTL_MS,
    retry: { maxAttempts: 4, delayMs: 25 },
  }),
);

const conflict = (message: string): Result<never> => fail({ code: "CONFLICT", message, status: 409 });

const withLeaseState = async <T>(draftId: string, operation: () => Promise<Result<T>>): Promise<Result<T>> => {
  const result = await stateMutex().withLock({ resource: draftId, ttlMs: DRAFT_LEASE_STATE_TTL_MS }, operation);
  return result ?? conflict("Draft lease state is being updated; retry the request");
};

const holderFromContext = (context: MailRequestContext): DraftLeaseHolder => {
  if (context.actor.kind === "user") {
    return {
      kind: "user",
      id: context.actor.user.id,
      displayName: context.actor.user.displayName,
      avatarHash: context.actor.user.avatarHash,
    };
  }
  return {
    kind: "service_account",
    id: context.actor.serviceAccount.id,
    displayName: context.actor.serviceAccount.name,
    avatarHash: context.actor.delegatedUser?.avatarHash ?? null,
  };
};

const sameHolder = (left: DraftLeaseHolder, right: DraftLeaseHolder): boolean => left.kind === right.kind && left.id === right.id;

const resolveAuthorizedDraft = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  permission: "read" | "write";
}): Promise<Result<string>> => {
  const allowed = await requireMailboxPermission(params.context, params.mailboxId, params.permission);
  if (!allowed.ok) return allowed;
  const [draft] = await sql<{ id: string }[]>`
    SELECT id FROM mail.drafts
    WHERE id = ${params.draftId}::uuid AND mailbox_id = ${params.mailboxId}::uuid AND origin = 'user' AND state = 'draft'
  `;
  return draft ? ok(draft.id) : fail(err.notFound("Editable draft"));
};

const restoreLock = (lock: DraftLeaseEntry["lock"]): Lock => ({
  ...lock,
  fence: BigInt(lock.fence),
  expiresAt: new Date(lock.expiresAt),
});

const storeLock = (lock: Lock): DraftLeaseEntry["lock"] => ({
  ...lock,
  fence: lock.fence.toString(),
  expiresAt: lock.expiresAt.toISOString(),
});

const currentEntry = async (draftId: string): Promise<{ value: DraftLeaseEntry; updatedAt: Date } | null> =>
  (await leaseStore().snapshot({ tenantId: draftId, prefix: "lease" })).entries.find((entry) => entry.key === "lease") ?? null;

const removeEntry = async (draftId: string, entry: DraftLeaseEntry): Promise<void> => {
  await leaseStore().delete({ tenantId: draftId, key: "lease" });
  await leaseMutex()
    .release(restoreLock(entry.lock))
    .catch(() => false);
};

export const invalidateDraftLeaseAfterSend = async (draftId: string): Promise<Result<void>> => {
  try {
    return await withLeaseState(draftId, async () => {
      const [draft] = await sql<{ state: string }[]>`
        SELECT state FROM mail.drafts WHERE id = ${draftId}::uuid
      `;
      if (!draft || draft.state === "draft") return ok();
      const entry = await currentEntry(draftId);
      if (entry) await removeEntry(draftId, entry.value);
      return ok();
    });
  } catch {
    return fail(err.internal("Failed to invalidate draft lease after send"));
  }
};

const currentValidEntry = async (mailboxId: string, draftId: string) => {
  const entry = await currentEntry(draftId);
  if (!entry || entry.value.holder.kind !== "user") return entry;
  const active = await hasCurrentMailboxUserPermission({
    mailboxId,
    userId: entry.value.holder.id,
    minimumPermission: "write",
  });
  if (active) return entry;
  await removeEntry(draftId, entry.value);
  return null;
};

const mapLease = (entry: { value: DraftLeaseEntry; updatedAt: Date }): DraftLease => ({
  holder: entry.value.holder,
  acquiredAt: new Date(entry.value.acquiredAt).toISOString(),
  expiresAt: new Date(Math.min(entry.updatedAt.getTime() + DRAFT_LEASE_TTL_MS, Date.parse(entry.value.lock.expiresAt))).toISOString(),
});

export const getDraftLease = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
}): Promise<Result<DraftLease | null>> => {
  const draft = await resolveAuthorizedDraft({ ...params, permission: "read" });
  if (!draft.ok) return draft;
  return withLeaseState(draft.data, async () => {
    const entry = await currentValidEntry(params.mailboxId, draft.data);
    return ok(entry ? mapLease(entry) : null);
  });
};

export const acquireDraftLease = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  takeover?: boolean;
}): Promise<Result<AcquiredDraftLease>> => {
  const holder = holderFromContext(params.context);
  const draft = await resolveAuthorizedDraft({ ...params, permission: "write" });
  if (!draft.ok) return draft;
  return withLeaseState(draft.data, async () => {
    const current = await currentValidEntry(params.mailboxId, draft.data);
    if (current) {
      if (!params.takeover) {
        return conflict(
          sameHolder(current.value.holder, holder)
            ? "This draft is already being edited in another session"
            : `This draft is being edited by ${current.value.holder.displayName}`,
        );
      }
      await removeEntry(draft.data, current.value);
    }

    const lock = await leaseMutex().acquire({ resource: draft.data, ttlMs: DRAFT_LEASE_TTL_MS });
    if (!lock) return conflict("Another collaborator acquired the draft lease");
    const token = crypto.randomUUID();
    const acquiredAt = Date.now();
    let stored = false;
    try {
      const entry = await leaseStore().upsert({
        tenantId: draft.data,
        key: "lease",
        value: { holder, token, lock: storeLock(lock), acquiredAt },
      });
      stored = true;
      if (current) {
        await sql`
          INSERT INTO mail.activity_events (
            mailbox_id, actor_kind, actor_id, action, outcome, target_type, target_id, metadata
          ) VALUES (
            ${params.mailboxId}::uuid,
            ${holder.kind},
            ${holder.id}::uuid,
            'draft.lease_taken_over',
            'confirmed',
            'draft',
            ${draft.data}::uuid,
            ${{ previousHolder: current.value.holder }}::jsonb
          )
        `;
        await notifyMailInvalidations();
      }
      return ok({ ...mapLease(entry), token });
    } catch (error) {
      if (stored)
        await leaseStore()
          .delete({ tenantId: draft.data, key: "lease" })
          .catch(() => false);
      await leaseMutex()
        .release(lock)
        .catch(() => false);
      throw error;
    }
  });
};

const ownedEntry = async (draftId: string, holder: DraftLeaseHolder, token: string): Promise<DraftLeaseEntry | null> => {
  const entry = await currentEntry(draftId);
  return entry && sameHolder(entry.value.holder, holder) && entry.value.token === token ? entry.value : null;
};

export const withOwnedDraftLease = async <T>(params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  token: string;
  operation: () => Promise<Result<T>>;
}): Promise<Result<T>> => {
  const draft = await resolveAuthorizedDraft({ ...params, permission: "write" });
  if (!draft.ok) return draft;
  const holder = holderFromContext(params.context);
  return withLeaseState(draft.data, async () => {
    const lease = await ownedEntry(draft.data, holder, params.token);
    if (!lease) return conflict("Draft lease is no longer owned by this session");
    return params.operation();
  });
};

export const heartbeatDraftLease = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  token: string;
}): Promise<Result<AcquiredDraftLease>> => {
  const draft = await resolveAuthorizedDraft({ ...params, permission: "write" });
  if (!draft.ok) return draft;
  const holder = holderFromContext(params.context);
  return withLeaseState(draft.data, async () => {
    const lease = await ownedEntry(draft.data, holder, params.token);
    if (!lease) return conflict("Draft lease is no longer owned by this session");
    const lock = restoreLock(lease.lock);
    if (!(await leaseMutex().extend(lock, { ttlMs: DRAFT_LEASE_TTL_MS }))) {
      await leaseStore().delete({ tenantId: draft.data, key: "lease" });
      return conflict("Draft lease expired");
    }
    lease.lock = storeLock(lock);
    const entry = await leaseStore().upsert({ tenantId: draft.data, key: "lease", value: lease });
    return ok({ ...mapLease(entry), token: lease.token });
  });
};

export const releaseDraftLease = async (params: {
  context: MailRequestContext;
  mailboxId: string;
  draftId: string;
  token: string;
}): Promise<Result<void>> => {
  const draft = await resolveAuthorizedDraft({ ...params, permission: "write" });
  if (!draft.ok) return draft;
  const holder = holderFromContext(params.context);
  return withLeaseState(draft.data, async () => {
    const lease = await ownedEntry(draft.data, holder, params.token);
    if (!lease) return conflict("Draft lease is no longer owned by this session");
    await removeEntry(draft.data, lease);
    return ok();
  });
};
