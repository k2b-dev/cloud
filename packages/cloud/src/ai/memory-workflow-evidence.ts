import { sql } from "bun";
import { type CloudResourceRef, CloudResourceRefSchema } from "../contracts/capabilities";
import { AI_MEMORY_LEARNING_DEFAULT_ENABLED } from "./prefs";

const MAX_RECEIPT_RESOURCES = 20;
const MAX_CAPABILITY_ID_CHARS = 180;
const MAX_RESOURCE_TITLE_CHARS = 500;

export type AiMemoryWorkflowEvidence = {
  turnId: string;
  conversationId: string;
  capabilityId: string;
  resourceRef: CloudResourceRef;
  resourceTitle: string | null;
};

export type AiMemoryWorkflowPattern = {
  userId: string;
  capabilityId: string;
  resourceRef: CloudResourceRef;
  resourceTitle: string | null;
  observationCount: number;
  turnIds: string[];
};

/**
 * Persist only successful, schema-valid capability/resource receipts, and only
 * while learning is on for the user and the chat is active: receipts from a
 * time it was off or the chat was archived never count toward a pattern.
 */
export const recordAiMemoryWorkflowEvidence = async (input: {
  userId: string;
  conversationId: string;
  turnId: string;
  capabilityId: string;
  resources: { ref: CloudResourceRef; title?: string }[];
}): Promise<void> => {
  const capabilityId = input.capabilityId.trim().slice(0, MAX_CAPABILITY_ID_CHARS);
  if (capabilityId.length < 3) return;
  const resources = [
    ...new Map(
      input.resources.flatMap((resource) => {
        const parsed = CloudResourceRefSchema.safeParse(resource.ref);
        if (!parsed.success) return [];
        return [
          [
            `${parsed.data.type}\0${parsed.data.id}`,
            {
              ref: parsed.data,
              ...(resource.title ? { title: resource.title.trim().slice(0, MAX_RESOURCE_TITLE_CHARS) } : {}),
            },
          ] as const,
        ];
      }),
    ).values(),
  ].slice(0, MAX_RECEIPT_RESOURCES);
  if (resources.length === 0) return;
  await sql.begin(async (tx) => {
    for (const resource of resources) {
      await tx`
        INSERT INTO ai.memory_workflow_evidence (
          user_id, turn_id, conversation_id, capability_id, resource_type, resource_id, resource_title
        )
        SELECT
          ${input.userId}::uuid, turn.id, conversation.id, ${capabilityId},
          ${resource.ref.type}, ${resource.ref.id}, ${resource.title ?? null}
        FROM ai.turns turn
        JOIN ai.conversations conversation ON conversation.id = turn.conversation_id
        LEFT JOIN ai.user_prefs prefs ON prefs.user_id = conversation.created_by_user_id
        WHERE turn.id = ${input.turnId}::uuid
          AND conversation.id = ${input.conversationId}::uuid
          AND conversation.created_by_user_id = ${input.userId}::uuid
          AND conversation.archived_at IS NULL
          AND COALESCE(prefs.memory_learning_enabled, ${AI_MEMORY_LEARNING_DEFAULT_ENABLED})
        ON CONFLICT (turn_id, capability_id, resource_type, resource_id)
        DO UPDATE SET resource_title = COALESCE(EXCLUDED.resource_title, ai.memory_workflow_evidence.resource_title)
      `;
    }
  });
};

export const listAiTurnWorkflowEvidence = async (userId: string, turnId: string): Promise<AiMemoryWorkflowEvidence[]> => {
  const rows = await sql<
    {
      turn_id: string;
      conversation_id: string;
      capability_id: string;
      resource_type: string;
      resource_id: string;
      resource_title: string | null;
    }[]
  >`
    SELECT evidence.turn_id, evidence.conversation_id, evidence.capability_id,
           evidence.resource_type, evidence.resource_id, evidence.resource_title
    FROM ai.memory_workflow_evidence evidence
    JOIN ai.conversations conversation ON conversation.id = evidence.conversation_id
    WHERE evidence.user_id = ${userId}::uuid
      AND evidence.turn_id = ${turnId}::uuid
      AND conversation.created_by_user_id = evidence.user_id
      AND conversation.archived_at IS NULL
    ORDER BY evidence.capability_id, evidence.resource_type, evidence.resource_id
  `;
  return rows.map((row) => ({
    turnId: row.turn_id,
    conversationId: row.conversation_id,
    capabilityId: row.capability_id,
    resourceRef: { type: row.resource_type, id: row.resource_id },
    resourceTitle: row.resource_title,
  }));
};

export const listAiPendingWorkflowPatterns = async (limit = 5): Promise<AiMemoryWorkflowPattern[]> => {
  const groups = await sql<
    {
      user_id: string;
      capability_id: string;
      resource_type: string;
      resource_id: string;
      resource_title: string | null;
      observation_count: number;
    }[]
  >`
    SELECT evidence.user_id, evidence.capability_id, evidence.resource_type, evidence.resource_id,
           (array_agg(evidence.resource_title ORDER BY evidence.observed_at DESC)
             FILTER (WHERE evidence.resource_title IS NOT NULL))[1] AS resource_title,
           count(*)::int AS observation_count
    FROM ai.memory_workflow_evidence evidence
    LEFT JOIN ai.user_prefs prefs ON prefs.user_id = evidence.user_id
    JOIN ai.conversations conversation
      ON conversation.id = evidence.conversation_id AND conversation.created_by_user_id = evidence.user_id
    WHERE evidence.reviewed_at IS NULL
      AND conversation.archived_at IS NULL
      AND COALESCE(prefs.memory_learning_enabled, ${AI_MEMORY_LEARNING_DEFAULT_ENABLED})
    GROUP BY evidence.user_id, evidence.capability_id, evidence.resource_type, evidence.resource_id
    HAVING count(*) >= 3
    ORDER BY min(evidence.observed_at), evidence.user_id, evidence.capability_id, evidence.resource_type, evidence.resource_id
    LIMIT ${Math.min(Math.max(limit, 1), 20)}
  `;
  return Promise.all(
    groups.map(async (group) => {
      const turns = await sql<{ turn_id: string }[]>`
        SELECT evidence.turn_id
        FROM ai.memory_workflow_evidence evidence
        JOIN ai.conversations conversation
          ON conversation.id = evidence.conversation_id AND conversation.created_by_user_id = evidence.user_id
        WHERE evidence.user_id = ${group.user_id}::uuid
          AND evidence.capability_id = ${group.capability_id}
          AND evidence.resource_type = ${group.resource_type}
          AND evidence.resource_id = ${group.resource_id}
          AND evidence.reviewed_at IS NULL
          AND conversation.archived_at IS NULL
        ORDER BY evidence.observed_at DESC, evidence.turn_id DESC
        LIMIT 3
      `;
      return {
        userId: group.user_id,
        capabilityId: group.capability_id,
        resourceRef: { type: group.resource_type, id: group.resource_id },
        resourceTitle: group.resource_title,
        observationCount: group.observation_count,
        turnIds: turns.map((turn) => turn.turn_id),
      };
    }),
  );
};

/** Every example used by the model must still belong to pending, active evidence. */
export const isAiWorkflowPatternEligible = async (pattern: AiMemoryWorkflowPattern): Promise<boolean> => {
  if (pattern.turnIds.length < 3) return false;
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM ai.memory_workflow_evidence evidence
    JOIN ai.conversations conversation
      ON conversation.id = evidence.conversation_id AND conversation.created_by_user_id = evidence.user_id
    WHERE evidence.user_id = ${pattern.userId}::uuid
      AND evidence.capability_id = ${pattern.capabilityId}
      AND evidence.resource_type = ${pattern.resourceRef.type}
      AND evidence.resource_id = ${pattern.resourceRef.id}
      AND evidence.turn_id IN ${sql(pattern.turnIds)}
      AND evidence.reviewed_at IS NULL
      AND conversation.archived_at IS NULL
  `;
  return row?.count === pattern.turnIds.length;
};

export const markAiWorkflowPatternReviewed = async (pattern: AiMemoryWorkflowPattern): Promise<void> => {
  await sql`
    UPDATE ai.memory_workflow_evidence
    SET reviewed_at = now()
    WHERE user_id = ${pattern.userId}::uuid
      AND capability_id = ${pattern.capabilityId}
      AND resource_type = ${pattern.resourceRef.type}
      AND resource_id = ${pattern.resourceRef.id}
      AND reviewed_at IS NULL
  `;
};
