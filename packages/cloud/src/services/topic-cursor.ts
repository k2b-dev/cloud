import type { Topic } from "@k2b/sync";

/**
 * Capture a replay baseline before loading an authoritative snapshot. An empty
 * tenant still needs the shared topic's current head: sequence zero may already
 * be outside retention, and omitting `after` loses the snapshot-to-stream race.
 * `head()` is one broker lookup across all tenants (`cursorAt(0)` when empty).
 */
export const latestTopicCursor = async (input: {
  topic: Pick<Topic<unknown>, "latestCursor" | "head">;
  /** Declared topic id, kept for call-site readability and error context. */
  resourceId: string;
  tenantId?: string;
}): Promise<string> => {
  const cursor = await input.topic.latestCursor({ tenantId: input.tenantId });
  if (cursor !== null) return cursor;
  try {
    return await input.topic.head();
  } catch (error) {
    throw new Error(`Cannot capture the current cursor of topic "${input.resourceId}"`, { cause: error });
  }
};
