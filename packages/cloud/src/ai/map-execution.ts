import type { AiMapCommand } from "./map-contracts";
import { type AiMapContext, applyAiMap } from "./map-service";
import { type AiMapStored, aiMaps } from "./map-store";

/** Lock and check the revision before provider work; a concurrent or stale click cannot spend against this map. */
export async function executeStoredAiMap(
  conversationId: string,
  ownerUserId: string,
  before: AiMapStored,
  command: AiMapCommand,
  context: AiMapContext,
) {
  return aiMaps.mutate(conversationId, ownerUserId, before.map.revision, before.map.id, (current) => applyAiMap(current, command, context));
}
