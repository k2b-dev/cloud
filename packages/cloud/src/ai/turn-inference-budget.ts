import { sql } from "../runtime/clients";
import { AUTOMATION_TURN_BUDGET } from "./code-authoring-turn";
import { AiTurnFailure } from "./turn-failure";

/** Generic non-person turns share their allocation with attributed tool
 * inference. A host's stricter admission snapshot is retained unchanged.
 * Code turns install theirs atomically with the host's monetary reservation. */
export async function installAiTurnInferenceAllocation(input: { turnId: string; conversationId: string; leaseOwner: string }) {
  const rows = await sql`UPDATE ai.turns SET run_config=jsonb_set(run_config,'{inferenceBudget}',
    COALESCE(run_config->'inferenceBudget',(${JSON.stringify({
      inputTokens: AUTOMATION_TURN_BUDGET.inputTokens,
      modelCalls: AUTOMATION_TURN_BUDGET.modelCalls,
      unknownInputTokens: AUTOMATION_TURN_BUDGET.unknownInputTokens,
    })}::text)::jsonb))
    WHERE id=${input.turnId}::uuid AND conversation_id=${input.conversationId}::uuid AND status='running'
      AND lease_owner=${input.leaseOwner} AND lease_expires_at>clock_timestamp() AND NOT (run_config ? 'codeOrigin') RETURNING id`;
  if (!rows.length) throw new AiTurnFailure("not_allowed", "Turn inference admission lease was lost.");
}
