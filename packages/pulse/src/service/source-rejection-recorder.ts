import { createRedis } from "@k2b/cloud";
import type { RequestActor, ServiceAccount } from "@k2b/cloud/contracts";
import type { RedisClient } from "bun";
import { PULSE_APP_ID, PULSE_SOURCE_RESOURCE_TYPE } from "./source-management";
import { REJECTION_REASON_MAX_LENGTH } from "./source-rejection-reason";
import { REJECTION_BUCKET_TTL_MS, REJECTION_NAMESPACE, rejectionBucketKey, rejectionIndexKey } from "./source-rejections";

// Ingest refusals are counted in Valkey per source and minute (DATA-13: this module never touches SQL).

// One round trip: count, last reason, and the index the flush reads instead of scanning keys.
// Index entries older than the bucket lifetime are trimmed here, so the index stays bounded without a flush.
const RECORD = `
redis.call('HINCRBY',KEYS[1],'count',1)
redis.call('HSET',KEYS[1],'reason',ARGV[1],'at',ARGV[2])
redis.call('PEXPIRE',KEYS[1],ARGV[5])
redis.call('ZADD',KEYS[2],ARGV[3],ARGV[4])
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf','('..ARGV[6])
redis.call('PEXPIRE',KEYS[2],ARGV[5])
return 1`;

/**
 * The Pulse source a refused request belongs to, or null. Only a key bound to one Pulse
 * ingest source is attributable, and only refusals of the sent batch count: authentication,
 * permission, and unknown-source answers have no source, and 5xx answers are Pulse's own outages.
 */
export const rejectionSourceShortId = (
  serviceAccount: Pick<ServiceAccount, "kind" | "appId" | "resourceType" | "resourceId">,
  status: number,
): string | null => {
  if (status < 400 || status >= 500 || status === 401 || status === 403 || status === 404) return null;
  if (
    serviceAccount.kind !== "resource_bound" ||
    serviceAccount.appId !== PULSE_APP_ID ||
    serviceAccount.resourceType !== PULSE_SOURCE_RESOURCE_TYPE
  )
    return null;
  return serviceAccount.resourceId && /^[0-9A-Za-z]{6}$/.test(serviceAccount.resourceId) ? serviceAccount.resourceId : null;
};

export type RejectionRecorder = {
  /** Best effort: resolves within one second and never rejects, whether Valkey answers or not. */
  record: (sourceShortId: string, reason: string) => Promise<void>;
  close: () => void;
};

/** A dedicated connection like the ingest quota: never queue while disconnected, and never delay an ingest answer. */
/** How long recording pauses after Valkey failed once. */
const RECORDER_PAUSE_MS = 5_000;
export const createRejectionRecorder = ({
  createClient = () => createRedis({ enableOfflineQueue: false, connectionTimeout: 1000 }),
  clock = () => new Date(),
  namespace = REJECTION_NAMESPACE,
}: {
  createClient?: () => RedisClient;
  clock?: () => Date;
  namespace?: string;
} = {}): RejectionRecorder => {
  let client: RedisClient | undefined;
  let connecting: Promise<void> | undefined;
  // After a failure, recording pauses briefly: a flood of refused requests never opens a connection each.
  let pausedUntil = 0;
  const close = () => {
    client?.close();
    client = undefined;
    connecting = undefined;
  };
  /** Drops only the failed client; a request that failed late never closes a newer, healthy one. */
  const drop = (failed: RedisClient | undefined) => {
    if (!failed || failed !== client) return;
    close();
  };
  return {
    close,
    record: async (sourceShortId, reason) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let current: RedisClient | undefined;
      try {
        const now = clock();
        if (now.getTime() < pausedUntil) return;
        const minute = Math.floor(now.getTime() / 60_000) * 60_000;
        const member = `${sourceShortId}:${minute}`;
        client ??= createClient();
        current = client;
        const used = current;
        const operation = async () => {
          if (!used.connected) {
            connecting ??= used.connect().finally(() => {
              connecting = undefined;
            });
            await connecting;
          }
          await used.send("EVAL", [
            RECORD,
            "2",
            rejectionBucketKey(namespace, member),
            rejectionIndexKey(namespace),
            reason.slice(0, REJECTION_REASON_MAX_LENGTH),
            now.toISOString(),
            String(minute),
            member,
            String(REJECTION_BUCKET_TTL_MS),
            String(now.getTime() - REJECTION_BUCKET_TTL_MS),
          ]);
        };
        await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Rejection recorder timeout")), 1000);
          }),
        ]);
      } catch {
        // A lost count is acceptable; closing cancels a timed-out command.
        pausedUntil = clock().getTime() + RECORDER_PAUSE_MS;
        drop(current);
      } finally {
        clearTimeout(timer);
      }
    },
  };
};
export const rejectionRecorder = createRejectionRecorder();

/**
 * Records a refused ingest request for its source without waiting. Requests that cannot be
 * attributed to one Pulse source record nothing. The reason is built only when it is recorded.
 */
export const recordIngestRejection = (
  actor: RequestActor,
  status: number,
  reason: () => string,
  recorder: Pick<RejectionRecorder, "record"> = rejectionRecorder,
): void => {
  if (actor.kind !== "service_account") return;
  const sourceShortId = rejectionSourceShortId(actor.serviceAccount, status);
  if (sourceShortId) void recorder.record(sourceShortId, reason());
};
