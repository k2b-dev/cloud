import { sql } from "bun";
import type { AiToolApprovalPolicy, AiTurnRunConfig } from "./types";

/** Background authority never inherits a user's interactive Always Allow preference. */
export const aiTurnAllowsRememberedApprovals = (config: AiTurnRunConfig | null | undefined): boolean =>
  config == null || config.kind === "compact" || config.mandate === undefined;

export type AiToolApprovalContext = {
  actorUserId: string;
};

export type AiToolApprovalPreference = {
  id: string;
  toolName: string;
  approvalScope: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

type AiToolApprovalPreferenceRow = {
  id: string;
  tool_name: string;
  approval_scope: string;
  created_at: Date | string;
  last_used_at: Date | string | null;
  expires_at: Date | string | null;
};

export const aiToolApprovalScope = (toolName: string, policy: AiToolApprovalPolicy | undefined): string => {
  if (policy && typeof policy === "object") return policy.scope ?? toolName;
  return toolName;
};

export const aiToolNeedsApproval = (policy: AiToolApprovalPolicy | undefined): boolean => policy !== "never";

export const aiToolAllowsAlways = (policy: AiToolApprovalPolicy | undefined): boolean =>
  policy === "always" || (typeof policy === "object" && policy.kind === "user-configurable");

export const hasRememberedAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string },
): Promise<boolean> => {
  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${context.actorUserId}
      AND tool_name = ${input.toolName}
      AND approval_scope = ${input.approvalScope}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `;

  const id = rows[0]?.id;
  if (!id) return false;
  await sql`UPDATE ai.tool_approval_preferences SET last_used_at = now() WHERE id = ${id}`;
  return true;
};

export const rememberAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string; expiresAt?: Date | null },
): Promise<void> => {
  await sql.begin(async () => {
    await sql`
      DELETE FROM ai.tool_approval_preferences
      WHERE actor_user_id = ${context.actorUserId}
        AND tool_name = ${input.toolName}
        AND approval_scope = ${input.approvalScope}
    `;

    await sql`
      INSERT INTO ai.tool_approval_preferences (
        actor_user_id,
        tool_name,
        approval_scope,
        last_used_at,
        expires_at
      )
      VALUES (
        ${context.actorUserId},
        ${input.toolName},
        ${input.approvalScope},
        now(),
        ${input.expiresAt ?? null}
      )
    `;
  });
};

export const forgetAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string },
): Promise<void> => {
  await sql`
    DELETE FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${context.actorUserId}
      AND tool_name = ${input.toolName}
      AND approval_scope = ${input.approvalScope}
  `;
};

const toIsoString = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const approvalPreferenceFromRow = (row: AiToolApprovalPreferenceRow): AiToolApprovalPreference => ({
  id: row.id,
  toolName: row.tool_name,
  approvalScope: row.approval_scope,
  createdAt: toIsoString(row.created_at),
  lastUsedAt: row.last_used_at ? toIsoString(row.last_used_at) : null,
  expiresAt: row.expires_at ? toIsoString(row.expires_at) : null,
});

export const listAiToolApprovalPreferences = async (actorUserId: string): Promise<AiToolApprovalPreference[]> => {
  const rows = await sql<AiToolApprovalPreferenceRow[]>`
    SELECT
      id,
      tool_name,
      approval_scope,
      created_at,
      last_used_at,
      expires_at
    FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${actorUserId}
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY last_used_at DESC NULLS LAST, created_at DESC, id
  `;
  return rows.map(approvalPreferenceFromRow);
};

export const revokeAiToolApprovalPreference = async (actorUserId: string, preferenceId: string): Promise<boolean> => {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM ai.tool_approval_preferences
    WHERE id = ${preferenceId}
      AND actor_user_id = ${actorUserId}
    RETURNING id
  `;
  return rows.length > 0;
};
