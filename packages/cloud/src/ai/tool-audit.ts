import { sql } from "bun";

/**
 * AI-specific tool-call state only: approval, turn linkage, and the request id
 * that correlates a capability call with its `capabilities.executions` row.
 * Capability shape, outcome, and latency belong to the platform execution
 * record written by the capability dispatcher.
 */
export type AiToolCallLocation = "server" | "client" | "client_view" | "client_interaction";

export type AiToolApprovalState = "not_required" | "waiting" | "approved_once" | "approved_always" | "approved_by_preference" | "rejected";

export const aiToolAudit = {
  /** Resolve the current server-recorded invocation, never a model-supplied chat id. */
  capabilityConversation: async (requestId: string, userId: string): Promise<string | null> => {
    const [row] = await sql<{ conversation_id: string }[]>`SELECT call.conversation_id FROM ai.tool_calls call
      JOIN ai.conversations conversation ON conversation.id=call.conversation_id
      JOIN ai.turns turn ON turn.id=call.turn_id
      WHERE call.request_id=${requestId} AND call.location='server'
        AND conversation.created_by_user_id=${userId}::uuid AND conversation.archived_at IS NULL
        AND turn.status IN ('running','waiting_for_action')
      LIMIT 1`;
    return row?.conversation_id ?? null;
  },
  noteCapabilityDispatch: async (input: {
    conversationId: string;
    turnId: string;
    callId: string;
    toolName: string;
    /** Correlates this call with its capabilities.executions row. */
    requestId: string;
    idempotencyKey?: string | null;
  }): Promise<void> => {
    await sql`
      INSERT INTO ai.tool_calls (
        turn_id, conversation_id, call_id, tool_name, location, status, approval_state, request_id, idempotency_key, started_at
      ) VALUES (
        ${input.turnId}, ${input.conversationId}, ${input.callId}, ${input.toolName}, 'server', 'running', 'approved_once',
        ${input.requestId}, ${input.idempotencyKey ?? null}, now()
      )
      ON CONFLICT (turn_id, call_id)
      DO UPDATE SET
        request_id = EXCLUDED.request_id,
        idempotency_key = COALESCE(EXCLUDED.idempotency_key, ai.tool_calls.idempotency_key),
        started_at = COALESCE(ai.tool_calls.started_at, now())
    `;
  },

  noteToolCall: async (input: {
    conversationId: string;
    turnId: string;
    callId: string;
    toolName: string;
    location: AiToolCallLocation;
    approvalState?: AiToolApprovalState;
    status?: "pending" | "waiting_for_frontend";
  }): Promise<void> => {
    await sql`
      INSERT INTO ai.tool_calls (
        turn_id,
        conversation_id,
        call_id,
        tool_name,
        location,
        status,
        approval_state
      )
      VALUES (
        ${input.turnId},
        ${input.conversationId},
        ${input.callId},
        ${input.toolName},
        ${input.location},
        ${input.status ?? "pending"},
        ${input.approvalState ?? "not_required"}
      )
      ON CONFLICT (turn_id, call_id)
      DO UPDATE SET
        tool_name = EXCLUDED.tool_name,
        location = EXCLUDED.location,
        status = EXCLUDED.status,
        approval_state = EXCLUDED.approval_state
    `;
  },

  noteToolStarted: async (input: { conversationId: string; turnId: string; callId: string; toolName: string }): Promise<void> => {
    await sql`
      INSERT INTO ai.tool_calls (
        turn_id,
        conversation_id,
        call_id,
        tool_name,
        status,
        started_at
      )
      VALUES (${input.turnId}, ${input.conversationId}, ${input.callId}, ${input.toolName}, 'running', now())
      ON CONFLICT (turn_id, call_id)
      DO UPDATE SET status = 'running', started_at = COALESCE(ai.tool_calls.started_at, now())
    `;
  },

  noteApprovalRequested: async (input: {
    conversationId: string;
    turnId: string;
    callId: string;
    toolName: string;
    location: AiToolCallLocation;
  }): Promise<void> => {
    await sql`
      INSERT INTO ai.tool_calls (
        turn_id,
        conversation_id,
        call_id,
        tool_name,
        location,
        status,
        approval_state,
        approval_requested_at
      )
      VALUES (
        ${input.turnId},
        ${input.conversationId},
        ${input.callId},
        ${input.toolName},
        ${input.location},
        'waiting_for_approval',
        'waiting',
        now()
      )
      ON CONFLICT (turn_id, call_id)
      DO UPDATE SET
        location = EXCLUDED.location,
        status = 'waiting_for_approval',
        approval_state = 'waiting',
        approval_requested_at = now()
    `;
  },

  noteApprovalResolved: async (input: {
    turnId: string;
    callId: string;
    approvalState: Exclude<AiToolApprovalState, "not_required" | "waiting">;
  }): Promise<void> => {
    const approved = input.approvalState !== "rejected";
    await sql`
      UPDATE ai.tool_calls
      SET
        approval_state = ${input.approvalState},
        status = CASE WHEN ${approved} THEN status ELSE 'rejected' END,
        approved_at = CASE WHEN ${approved} THEN now() ELSE approved_at END,
        rejected_at = CASE WHEN ${approved} THEN rejected_at ELSE now() END
      WHERE turn_id = ${input.turnId}
        AND call_id = ${input.callId}
    `;
  },

  noteToolCompleted: async (input: { turnId: string; callId: string; isError?: boolean }): Promise<void> => {
    await sql`
      UPDATE ai.tool_calls
      SET
        status = ${input.isError ? "failed" : "completed"},
        completed_at = now()
      WHERE turn_id = ${input.turnId}
        AND call_id = ${input.callId}
    `;
  },
};
