import { sql } from "@k2b/cloud";
import { type AiWakeupBudgetCheck, AiWakeupBudgetError } from "@k2b/cloud/ai";
import { type AiChatTurnAdmission, AiTurnFailure, markAiWakeupMissed } from "@k2b/cloud/ai/runtime";
import { accounts, coreSettings, isAccountAllowed, logger } from "@k2b/cloud/services";
import { isAccountExpired } from "@k2b/cloud/services/account-model";
import { aiWakeupMessages } from "./ai-wakeup-messages";
import { codeChatBudgetMessages } from "./code/chat-budget-messages";
import {
  CodeChatBudgetError,
  checkAutomationChatBudget,
  reserveCodeChatTurnBudget,
  settleCodeChatTurnBudget,
} from "./code/chat-turn-budget";
import { codeChatModelPolicyRow } from "./code/policy-contracts";
import { codeSettings } from "./code/settings";
import { findCode } from "./code/store";
import { CodeVersionError, requireCodeVersionApproval } from "./code/versions";

/** Code owns its day allowance and policy. The platform supplies the actual
 * worker profile; it neither imports Core nor infers authority from attribution. */
export const admitCodeChatTurn: AiChatTurnAdmission = async (input) => {
  const origin = input.runConfig.codeOrigin;
  if (!origin) {
    if (input.runConfig.wakeup) await admitWakeupChatTurn(input);
    return;
  }
  try {
    await sql.begin(async (db) => {
      // Match the policy -> Code -> run order used by Code's bridge. The turn
      // fence prevents a stale worker from creating or reusing a reservation.
      await db`SELECT revision FROM code.policy WHERE singleton FOR SHARE`;
      await db`SELECT id FROM code.codes WHERE id=${origin.codeId} FOR SHARE`;
      const code = await findCode(origin.codeId, db);
      const [run] = await db<{ version_id: string }[]>`SELECT version_id FROM code.runs
        WHERE id=${origin.runId}::uuid AND code_id=${origin.codeId}`;
      if (
        !code ||
        !run ||
        code.state !== "active" ||
        code.activeVersionId !== run.version_id ||
        code.owner.kind !== "person" ||
        input.runConfig.actor?.kind !== "user" ||
        input.runConfig.actor.user.id !== code.owner.userId ||
        input.runConfig.turnTrigger?.kind !== "automation" ||
        input.runConfig.turnTrigger.id !== code.id
      )
        throw new AiTurnFailure("not_allowed", "Code chat authority is no longer available.");
      const fence = await db`SELECT id FROM ai.turns WHERE id=${input.turnId}::uuid AND conversation_id=${input.conversationId}::uuid
        AND status='running' AND lease_owner=${input.leaseOwner} AND lease_expires_at>clock_timestamp() FOR UPDATE`;
      if (!fence.length) throw new AiTurnFailure("not_allowed", "Code chat worker lease was lost.");
      await requireCodeVersionApproval(code, run.version_id, db, [codeChatModelPolicyRow(input.profile)]);
      await reserveCodeChatTurnBudget(
        { turnId: input.turnId, codeId: code.id, ownerUserId: code.owner.userId, profile: input.profile },
        db,
        {
          code: await codeSettings.get("core.code.ai_daily_budget_usd", db),
          owner: await codeSettings.get("core.code.ai_owner_daily_budget_usd", db),
          timeZone: (await coreSettings.get<string>("app.timezone", db)) || "UTC",
        },
      );
    });
  } catch (error) {
    if (error instanceof CodeChatBudgetError) {
      const code =
        error.code === "code_ai_budget_unknown"
          ? "host_budget_unknown"
          : error.code === "code_ai_budget_changed"
            ? "host_budget_changed"
            : error.code === "code_ai_budget_settled"
              ? "host_budget_settled"
              : "host_budget_limit";
      throw new AiTurnFailure(
        code,
        error.code,
        codeChatBudgetMessages(input.runConfig.locale ?? (await coreSettings.get<string>("app.locale")) ?? "en").reason(error.code),
      );
    }
    if (error instanceof CodeVersionError) throw new AiTurnFailure("not_allowed", error.code);
    throw error;
  }
};

export async function settleCodeChatTurn(turnId: string): Promise<void> {
  await sql.begin((db) => settleCodeChatTurnBudget(turnId, db));
}

/** A missed finalized callback must not keep a successful turn's remainder
 * forever. Round-robin candidates include failed, deleted and aborted turns. */
export async function sweepCodeChatTurnBudgets(): Promise<void> {
  const rows = await sql<{ turn_id: string }[]>`SELECT b.turn_id FROM code.chat_turn_budgets b LEFT JOIN ai.turns t ON t.id=b.turn_id
    WHERE b.settled_at IS NULL AND (t.id IS NULL OR t.status IN ('completed','failed','aborted')) ORDER BY b.created_at,b.turn_id LIMIT 100`;
  for (const row of rows) {
    try {
      await settleCodeChatTurn(row.turn_id);
    } catch (error) {
      logger("core:code-chat-budget").warn("Code chat budget settlement failed", {
        turnId: row.turn_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

const wakeupBudgetLimits = async (db: import("bun").SQL) => ({
  code: await codeSettings.get("core.code.ai_daily_budget_usd", db),
  owner: await codeSettings.get("core.code.ai_owner_daily_budget_usd", db),
  timeZone: (await coreSettings.get<string>("app.timezone", db)) || "UTC",
});

export const checkWakeupChatBudget: AiWakeupBudgetCheck = async ({ owner, wakeupId, profile, db }) => {
  try {
    await checkAutomationChatBudget(
      { turnId: wakeupId, codeId: `wakeup:${wakeupId}`, ownerUserId: owner, profile },
      db,
      await wakeupBudgetLimits(db),
    );
  } catch (error) {
    if (error instanceof CodeChatBudgetError) throw new AiWakeupBudgetError(error.code);
    throw error;
  }
};

class AiWakeupAccessError extends AiTurnFailure {
  constructor(message: string) {
    super("not_allowed", message);
  }
}

async function admitWakeupChatTurn(input: Parameters<AiChatTurnAdmission>[0]) {
  const { wakeup, actor, send, writerOrigin, turnTrigger } = input.runConfig;
  if (
    !wakeup ||
    actor?.kind !== "user" ||
    actor.delegation ||
    actor.sessionKind === "app" ||
    !send ||
    send.accountId !== actor.user.id ||
    writerOrigin?.kind !== "wakeup" ||
    writerOrigin.id !== wakeup.id ||
    writerOrigin.scheduledAt !== wakeup.scheduledAt ||
    turnTrigger?.kind !== "wakeup" ||
    turnTrigger.id !== wakeup.id
  )
    throw new AiTurnFailure("not_allowed", "Alarm authority is unavailable.");
  try {
    await sql.begin(async (db) => {
      const fence = await db`SELECT id FROM ai.turns WHERE id=${input.turnId}::uuid AND conversation_id=${input.conversationId}::uuid
        AND status='running' AND lease_owner=${input.leaseOwner} AND lease_expires_at>clock_timestamp() FOR UPDATE`;
      if (!fence.length) throw new AiTurnFailure("not_allowed", "Alarm chat worker lease was lost.");
      const user = await accounts.users.get({ id: actor.user.id }, { db });
      if (!user || isAccountExpired(user.accountExpires) || !(await isAccountAllowed(user, db)))
        throw new AiWakeupAccessError("Alarm owner is inactive.");
      // The queue refreshes the owner; recheck the durable receipt and worker fence on every resumption.
      const [valid] = await db`SELECT 1 FROM ai.chat_send_receipts r JOIN ai.conversations c ON c.id=r.conversation_id
        JOIN ai.wakeups w ON w.id=${wakeup.id}::uuid
        WHERE r.id=${send.id}::uuid AND r.account_id=${actor.user.id}::uuid AND r.conversation_id=${input.conversationId}::uuid
          AND c.created_by_user_id=r.account_id AND c.archived_at IS NULL
          AND w.conversation_id=c.id AND w.created_by=r.account_id AND w.status<>'deleted'
          AND r.queued_message_id=${send.id}::uuid AND r.key_hash=${send.keyHash} AND r.input_hash=${send.requestHash}
          AND r.origin=(${JSON.stringify(writerOrigin)}::text)::jsonb AND r.turn_trigger=(${JSON.stringify(turnTrigger)}::text)::jsonb`;
      if (!valid) throw new AiWakeupAccessError("Alarm authority is unavailable.");
      await reserveCodeChatTurnBudget(
        { turnId: input.turnId, codeId: `wakeup:${wakeup.id}`, ownerUserId: actor.user.id, profile: input.profile },
        db,
        await wakeupBudgetLimits(db),
      );
    });
  } catch (error) {
    if (error instanceof CodeChatBudgetError || error instanceof AiWakeupAccessError) {
      await sql.begin(async (db) => {
        await db`SELECT id FROM ai.conversations WHERE id=${input.conversationId}::uuid FOR UPDATE`;
        const fence = await db`SELECT id FROM ai.turns WHERE id=${input.turnId}::uuid AND conversation_id=${input.conversationId}::uuid
          AND status='running' AND lease_owner=${input.leaseOwner} AND lease_expires_at>clock_timestamp() FOR UPDATE`;
        if (!fence.length) return;
        await markAiWakeupMissed(
          input.conversationId,
          send.id,
          error instanceof CodeChatBudgetError ? "budget" : "access",
          input.runConfig.locale ?? "en",
          db,
        );
      });
    }
    if (error instanceof CodeChatBudgetError)
      throw new AiTurnFailure("host_budget_limit", error.code, aiWakeupMessages(input.runConfig.locale ?? "en").budget(error.code));
    throw error;
  }
}
