import type { StoreEntry } from "@k2b/nessi";
import type { SQL } from "bun";
import { NormalizedCapabilityCallSchema } from "../contracts/capabilities";
import { legacyTargetOperation, migratedCapabilityToolArgs } from "../services/mandates/target-migration";
import { parsePgJsonValue } from "../services/postgres";
import type { AiStoredMessage } from "./types";

export type CapabilityMigrationHistoryRow = {
  migrated_turn_id: string | null;
  migrated_last_assistant_id: string | null;
};

/** Join recovery data into the existing history read, including when its last assistant is outside the page. */
export const capabilityMigrationHistoryJoin = (db: SQL) => db`LEFT JOIN LATERAL (
  SELECT turn.id AS migrated_turn_id,
    (SELECT message.id FROM ai.messages message WHERE message.conversation_id = turn.conversation_id
      AND message.loop_id = turn.id::text AND message.role = 'assistant' AND message.kind = 'message'
      AND message.compacted_at IS NULL ORDER BY message.seq DESC LIMIT 1) AS migrated_last_assistant_id
  FROM ai.turns turn WHERE turn.conversation_id = ai.messages.conversation_id AND turn.id::text = ai.messages.loop_id
    AND turn.status = 'aborted' AND turn.error = 'Bitte neu anfragen'
) migration ON true`;

/** History is display data. Add a recovery notice on reads without rewriting the stored messages. */
export const projectCapabilityMigrationError = (message: AiStoredMessage, row: CapabilityMigrationHistoryRow): AiStoredMessage =>
  row.migrated_turn_id
    ? {
        ...message,
        ...(row.migrated_last_assistant_id === message.id && !message.loopDoneReason ? { loopDoneReason: "aborted" as const } : {}),
        meta: { ...message.meta, turnError: { code: "capability_changed" } },
      }
    : message;

/** Only the active open call is adapted in memory. Completed history never sees today's input schema. */
export const projectMigratedCapabilityCalls = async (
  db: SQL,
  conversationId: string,
  turnId: string,
  entries: StoreEntry[],
): Promise<StoreEntry[]> => {
  const rows = await db<{ call_id: string; kind: string; tool_name: string; args: unknown }[]>`
    SELECT call_id, kind, tool_name, args FROM ai.pending_actions
    WHERE conversation_id = ${conversationId}::uuid AND turn_id = ${turnId}::uuid
      AND capability_target_version = 1 AND status IN ('pending', 'resolved')
    ORDER BY created_at, id`;
  const calls = new Map(
    rows.flatMap((row) => {
      const call = NormalizedCapabilityCallSchema.safeParse(parsePgJsonValue(row.args));
      const operation = legacyTargetOperation(row.tool_name);
      if (!call.success || !operation || call.data.capability !== `${operation.appId}.${operation.capabilityId}`) return [];
      const callId = row.kind === "custom_approval" ? /^(.*)-approval-\d+$/.exec(row.call_id)?.[1] : row.call_id;
      return callId ? [[callId, { operation, args: migratedCapabilityToolArgs(call.data) }] as const] : [];
    }),
  );
  return entries.map((entry) =>
    entry.message.role !== "assistant"
      ? entry
      : {
          ...entry,
          message: {
            ...entry.message,
            content: entry.message.content.map((part) => {
              if (part.type !== "tool_call") return part;
              const call = calls.get(part.id);
              if (
                !call ||
                (part.name !== call.operation.providerName && part.name !== `${call.operation.appId}.${call.operation.capabilityId}`)
              )
                return part;
              return { ...part, args: call.args };
            }),
          },
        },
  );
};
