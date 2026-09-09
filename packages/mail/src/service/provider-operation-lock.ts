import type { Lock } from "@k2b/sync";
import { lazySync } from "@k2b/cloud";
import { withLeaseHeartbeat } from "./lease-heartbeat";

export const MAIL_PROVIDER_OPERATION_LEASE_MS = 5 * 60_000;

/**
 * Delay before a job retries after finding the remote resource locked by a
 * sibling job (hydration, rediscovery, commands). Contention is routine, so
 * callers resubmit with this delay instead of consuming a delivery attempt.
 */
export const providerBusyRetryDelayMs = (): number => 5_000 + Math.floor(Math.random() * 25_000);

export const mailProviderOperationMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:remote-resource-sync",
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    retry: { maxAttempts: 1 },
  }),
);

const lifecycleBarrierMutex = lazySync((sync) =>
  sync.mutex({
    id: "mail:remote-resource-sync",
    ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS,
    retry: { maxAttempts: 41, delayMs: 250 },
  }),
);

const acquireMailboxProviderBarrier = async (remoteResourceIds: readonly string[]): Promise<Lock[] | null> => {
  const locks: Lock[] = [];
  try {
    for (const remoteResourceId of [...new Set(remoteResourceIds)].sort()) {
      const lock = await lifecycleBarrierMutex().acquire({ resource: remoteResourceId, ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS });
      if (!lock) {
        await Promise.all(
          locks.map((held) =>
            lifecycleBarrierMutex()
              .release(held)
              .catch(() => undefined),
          ),
        );
        return null;
      }
      locks.push(lock);
    }
    return locks;
  } catch (error) {
    await Promise.all(
      locks.map((held) =>
        lifecycleBarrierMutex()
          .release(held)
          .catch(() => undefined),
      ),
    );
    throw error;
  }
};

const releaseMailboxProviderBarrier = async (locks: readonly Lock[]): Promise<void> => {
  await Promise.all(
    locks.map((lock) =>
      lifecycleBarrierMutex()
        .release(lock)
        .catch(() => undefined),
    ),
  );
};

type ProviderOperationBarrierResult<T> = { acquired: false } | { acquired: true; value: T };

const mailboxProviderOperationKey = (mailboxId: string): string => `mailbox:${mailboxId}`;

export const withProviderOperationBarrier = async <T>(
  remoteResourceIds: readonly string[],
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationBarrierResult<T>> => {
  const locks = await acquireMailboxProviderBarrier(remoteResourceIds);
  if (!locks) return { acquired: false };
  try {
    const value = await withLeaseHeartbeat({
      intervalMs: Math.floor(MAIL_PROVIDER_OPERATION_LEASE_MS / 3),
      heartbeat: async () => {
        const extended = await Promise.all(
          locks.map((lock) =>
            lifecycleBarrierMutex()
              .extend(lock, { ttlMs: MAIL_PROVIDER_OPERATION_LEASE_MS })
              .catch(() => false),
          ),
        );
        if (extended.some((active) => !active)) {
          throw Object.assign(new Error("Mailbox provider operation barrier was lost"), {
            code: "MAIL_PROVIDER_OPERATION_LEASE_LOST",
          });
        }
      },
      work,
    });
    return { acquired: true, value };
  } finally {
    await releaseMailboxProviderBarrier(locks);
  }
};

export const withMailboxProviderOperationBarrier = async <T>(
  mailboxId: string,
  remoteResourceIds: readonly string[],
  work: (assertLeaseActive: () => Promise<void>) => Promise<T>,
): Promise<ProviderOperationBarrierResult<T>> =>
  withProviderOperationBarrier([mailboxProviderOperationKey(mailboxId), ...remoteResourceIds], work);
