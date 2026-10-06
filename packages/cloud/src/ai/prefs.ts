import { sql } from "bun";
import type { RequestActor } from "../server";

/**
 * Learning from private chats applies to everyone who has not chosen.
 * A stored `NULL` means "never chose"; only an explicit save stores a boolean.
 */
export const AI_MEMORY_LEARNING_DEFAULT_ENABLED = true;

export type AiUserPrefs = {
  userId: string;
  memoryEnabled: boolean;
  /** Effective setting: the user's explicit choice, otherwise the default. */
  memoryLearningEnabled: boolean;
  /** Model profile id of the user's most recent chat turn — preselected for new chats. */
  lastModelId: string;
  updatedAt: string;
};

type PrefsRow = {
  user_id: string;
  memory_enabled: boolean;
  memory_learning_enabled: boolean | null;
  last_model_id: string | null;
  updated_at: string | Date;
};

const toPrefs = (row: PrefsRow): AiUserPrefs => ({
  userId: row.user_id,
  memoryEnabled: row.memory_enabled,
  memoryLearningEnabled: row.memory_learning_enabled ?? AI_MEMORY_LEARNING_DEFAULT_ENABLED,
  lastModelId: row.last_model_id ?? "",
  updatedAt: new Date(row.updated_at).toISOString(),
});

const emptyPrefs = (userId: string): AiUserPrefs => ({
  userId,
  memoryEnabled: true,
  memoryLearningEnabled: AI_MEMORY_LEARNING_DEFAULT_ENABLED,
  lastModelId: "",
  updatedAt: new Date(0).toISOString(),
});

/** The user a chat turn runs for — direct users and delegated service-account users. */
export const aiActorUser = (actor: RequestActor | undefined) => {
  if (!actor) return undefined;
  if (actor.kind === "user") return actor.user;
  return actor.delegatedUser ?? undefined;
};

/** The user whose preferences and personal memories apply to a turn. */
export const aiPrefsUserId = (actor: RequestActor | undefined): string | null => aiActorUser(actor)?.id ?? null;

export const aiUserPrefs = {
  async get(userId: string): Promise<AiUserPrefs> {
    const rows = (await sql`SELECT * FROM ai.user_prefs WHERE user_id = ${userId}`) as PrefsRow[];
    return rows[0] ? toPrefs(rows[0]) : emptyPrefs(userId);
  },

  async update(
    userId: string,
    patch: { memoryEnabled?: boolean; memoryLearningEnabled?: boolean; lastModelId?: string },
  ): Promise<AiUserPrefs> {
    const memoryEnabled = patch.memoryEnabled ?? null;
    const memoryLearningEnabled = patch.memoryLearningEnabled ?? null;
    const lastModelId = patch.lastModelId?.trim().slice(0, 200) ?? null;
    const rows = (await sql`
      INSERT INTO ai.user_prefs (user_id, memory_enabled, memory_learning_enabled, last_model_id, updated_at)
      VALUES (${userId}, ${memoryEnabled ?? true}, ${memoryLearningEnabled}, ${lastModelId ?? ""}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        memory_enabled = COALESCE(${memoryEnabled}, ai.user_prefs.memory_enabled),
        memory_learning_enabled = COALESCE(${memoryLearningEnabled}, ai.user_prefs.memory_learning_enabled),
        last_model_id = COALESCE(${lastModelId}, ai.user_prefs.last_model_id),
        updated_at = now()
      RETURNING *
    `) as PrefsRow[];
    return toPrefs(rows[0]!);
  },
};
