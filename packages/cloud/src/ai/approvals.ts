import { sql } from "bun";
import type { AiToolApprovalPolicy, AiTurnRunConfig } from "./types";

/** Background authority never inherits a user's interactive Always Allow preference. */
export const aiTurnAllowsRememberedApprovals = (config: AiTurnRunConfig | null | undefined): boolean =>
  config == null || config.kind === "compact" || config.mandate === undefined;

/**
 * Reserved remembered-approval name for reading one website in one chat or one managed app. No capability or tool can
 * collide with it: tool names never contain a colon.
 */
export const AI_WEBSITE_APPROVAL_TOOL = "website:read";

/** The remembered scope of a website approval: one exact origin, in a chat or for one managed Studio app. */
export const aiWebsiteApprovalScope = (origin: string, resourceId?: string): string =>
  resourceId ? `${origin} resource:${resourceId}` : origin;

export const parseAiWebsiteApprovalScope = (scope: string): { origin: string; resourceId: string | null } => {
  const [origin = scope, resource] = scope.split(" ");
  return { origin, resourceId: resource?.startsWith("resource:") ? resource.slice("resource:".length) : null };
};

/**
 * Website approvals apply only to a turn a person started in a signed-in browser session: never to a scheduled task,
 * a mandate, `cld`, an API key, or another delegated credential.
 */
export const aiTurnAllowsWebsiteApprovals = (config: AiTurnRunConfig | null | undefined): boolean =>
  config != null && config.kind !== "compact" && config.signedInSession === true && aiTurnAllowsRememberedApprovals(config);

export type AiToolApprovalContext = {
  actorUserId: string;
};

/** Where a remembered approval applies: in one chat until it is deleted, or always. */
export type AiToolApprovalRemember = "chat" | "always";

export type AiToolApprovalPreference = {
  id: string;
  toolName: string;
  approvalScope: string;
  /** The chat this approval is limited to; null for an approval that applies everywhere. */
  conversationId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
};

type AiToolApprovalPreferenceRow = {
  id: string;
  tool_name: string;
  approval_scope: string;
  conversation_id: string | null;
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

/**
 * The remembered approval that covers this tool and scope: one that applies everywhere, or one limited to
 * `conversationId`; with `chatOnly`, only the latter. Returns its ID and marks it used.
 */
export const findRememberedAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string; conversationId?: string | null; chatOnly?: boolean },
): Promise<string | null> => {
  const conversationId = input.conversationId ?? null;
  if (input.chatOnly && !conversationId) return null;
  const rows = await sql<{ id: string }[]>`
    SELECT id
    FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${context.actorUserId}
      AND tool_name = ${input.toolName}
      AND approval_scope = ${input.approvalScope}
      AND (conversation_id = ${conversationId}::uuid OR (conversation_id IS NULL AND NOT ${input.chatOnly === true}))
      AND (expires_at IS NULL OR expires_at > now())
    ORDER BY conversation_id NULLS LAST
    LIMIT 1
  `;

  const id = rows[0]?.id;
  if (!id) return null;
  await sql`UPDATE ai.tool_approval_preferences SET last_used_at = now() WHERE id = ${id}`;
  return id;
};

export const hasRememberedAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string; conversationId?: string | null },
): Promise<boolean> => (await findRememberedAiToolApproval(context, input)) !== null;

/** Remembers an approval everywhere, or in one chat when `conversationId` is set; a chat approval ends with its chat. */
export const rememberAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string; conversationId?: string | null; expiresAt?: Date | null },
): Promise<void> => {
  const conversationId = input.conversationId ?? null;
  await sql.begin(async () => {
    await sql`
      DELETE FROM ai.tool_approval_preferences
      WHERE actor_user_id = ${context.actorUserId}
        AND tool_name = ${input.toolName}
        AND approval_scope = ${input.approvalScope}
        AND conversation_id IS NOT DISTINCT FROM ${conversationId}::uuid
    `;

    await sql`
      INSERT INTO ai.tool_approval_preferences (
        actor_user_id,
        tool_name,
        approval_scope,
        conversation_id,
        last_used_at,
        expires_at
      )
      VALUES (
        ${context.actorUserId},
        ${input.toolName},
        ${input.approvalScope},
        ${conversationId}::uuid,
        now(),
        ${input.expiresAt ?? null}
      )
    `;
  });
};

/** Forgets the approval with exactly this reach: everywhere, or in the one chat `conversationId` names. */
export const forgetAiToolApproval = async (
  context: AiToolApprovalContext,
  input: { toolName: string; approvalScope: string; conversationId?: string | null },
): Promise<boolean> => {
  const rows = await sql<{ id: string }[]>`
    DELETE FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${context.actorUserId}
      AND tool_name = ${input.toolName}
      AND approval_scope = ${input.approvalScope}
      AND conversation_id IS NOT DISTINCT FROM ${input.conversationId ?? null}::uuid
    RETURNING id
  `;
  return rows.length > 0;
};

const toIsoString = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

const approvalPreferenceFromRow = (row: AiToolApprovalPreferenceRow): AiToolApprovalPreference => ({
  id: row.id,
  toolName: row.tool_name,
  approvalScope: row.approval_scope,
  conversationId: row.conversation_id,
  createdAt: toIsoString(row.created_at),
  lastUsedAt: row.last_used_at ? toIsoString(row.last_used_at) : null,
  expiresAt: row.expires_at ? toIsoString(row.expires_at) : null,
});

/** Lists the approvals that apply everywhere, or only those of one chat when `conversationId` is set. */
export const listAiToolApprovalPreferences = async (
  actorUserId: string,
  options: { conversationId?: string } = {},
): Promise<AiToolApprovalPreference[]> => {
  const conversationId = options.conversationId ?? null;
  const rows = await sql<AiToolApprovalPreferenceRow[]>`
    SELECT
      id,
      tool_name,
      approval_scope,
      conversation_id,
      created_at,
      last_used_at,
      expires_at
    FROM ai.tool_approval_preferences
    WHERE actor_user_id = ${actorUserId}
      AND conversation_id IS NOT DISTINCT FROM ${conversationId}::uuid
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
