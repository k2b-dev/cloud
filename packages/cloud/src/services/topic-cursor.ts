import type { Sync, Topic } from "@k2b/sync";
import { getProcessSync } from "../_internal/process-sync";

/**
 * Capture a replay baseline before loading an authoritative snapshot. An empty
 * tenant still needs the shared topic's current head: sequence zero may already
 * be outside retention, and omitting `after` loses the snapshot-to-stream race.
 */
export const latestTopicCursor = async (
  input: {
    topic: Pick<Topic<unknown>, "latestCursor" | "cursorAt">;
    resourceId: string;
    tenantId?: string;
  },
  sync: Pick<Sync, "resources"> = getProcessSync(),
): Promise<string> => {
  const cursor = await input.topic.latestCursor({ tenantId: input.tenantId });
  if (cursor !== null) return cursor;
  const resource = (await sync.resources()).find((entry) => entry.kind === "topic" && entry.id === input.resourceId);
  const sequence = resource?.detail?.lastSequence;
  if (resource?.state !== "ready" || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(`Cannot capture the current cursor of topic "${input.resourceId}"`);
  }
  return input.topic.cursorAt(sequence);
};
