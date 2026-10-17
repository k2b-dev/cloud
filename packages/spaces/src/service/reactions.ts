import { err, fail, ok, type Result } from "@k2b/stdlib";
import { sql } from "bun";
import { MAX_ITEM_REACTION_EMOJI, ReactionEmojiSchema, type SpaceItemReaction } from "../contracts";
import { publishSpaceChange, spacesLive } from "./live";

/** Identity behind the call, independent of the principal supplying access grants. */
export type ReactionActor = { kind: "user" | "service_account"; id: string };
/**
 * The account a summary is personalized for: `own` and the excluded reactor. Reads without a viewer carry no
 * summary at all, so a write response can never overwrite a person's summary with an impersonal one.
 */
export type ReactionViewer = ReactionActor;
type ReactionsResponse = { reactions: SpaceItemReaction[] };
/** `spaceId` is the Space whose write access the caller holds. */
type ReactionIntent = { itemId: string; spaceId: string; emoji: string; actor: ReactionActor };

/** One query for the whole page; only the first three other reactors enter the payload. */
export const getReactionsByItemIds = async (itemIds: string[], viewer: ReactionViewer): Promise<Map<string, SpaceItemReaction[]>> => {
  if (!itemIds.length) return new Map();
  const rows = await sql<{ item_id: string; emoji: string; count: number; own: boolean; people: SpaceItemReaction["people"] }[]>`
    WITH reactors AS (
      SELECT r.*, COALESCE(r.user_id, r.service_account_id) AS reactor_id,
        CASE WHEN r.user_id IS NOT NULL THEN 'user' ELSE 'service_account' END AS kind,
        COALESCE(u.display_name, sa.name) AS display_name,
        (CASE WHEN ${viewer.kind}::text = 'user' THEN r.user_id ELSE r.service_account_id END)
          IS NOT DISTINCT FROM ${viewer.id}::uuid AS own
      FROM spaces.item_reactions r
      LEFT JOIN auth.users u ON u.id = r.user_id
      LEFT JOIN auth.service_accounts sa ON sa.id = r.service_account_id
      WHERE r.item_id IN ${sql(itemIds)}
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY item_id, emoji, own ORDER BY created_at, id) AS position
      FROM reactors
    )
    SELECT item_id, emoji, count(*)::int AS count, bool_or(own) AS own,
      COALESCE(jsonb_agg(jsonb_build_object('kind', kind, 'id', reactor_id, 'displayName', display_name)
        ORDER BY created_at, id) FILTER (WHERE NOT own AND position <= 3), '[]'::jsonb) AS people
    FROM ranked GROUP BY item_id, emoji ORDER BY min(created_at), emoji
  `;
  const summaries = new Map<string, SpaceItemReaction[]>();
  for (const { item_id, ...reaction } of rows) {
    const summary = summaries.get(item_id) ?? [];
    summary.push(reaction);
    summaries.set(item_id, summary);
  }
  return summaries;
};

export const listForItem = async (itemId: string, viewer: ReactionViewer): Promise<SpaceItemReaction[]> =>
  (await getReactionsByItemIds([itemId], viewer)).get(itemId) ?? [];

const mutate = async (
  operation: "add" | "remove",
  { itemId, spaceId, emoji, actor }: ReactionIntent,
): Promise<Result<ReactionsResponse>> => {
  if (!ReactionEmojiSchema.safeParse(emoji).success) return fail(err.badInput("Expected one fully-qualified RGI emoji"));
  const userId = actor.kind === "user" ? actor.id : null;
  const serviceAccountId = actor.kind === "service_account" ? actor.id : null;
  const result = await sql.begin(async (tx): Promise<Result<{ changed: boolean }>> => {
    // Item first, then reactions: also compatible with comments' FOR SHARE and item.move. The Space is the one the
    // caller was authorized for; an item moved to another Space since then is not found here.
    const [item] = await tx<{ space_id: string }[]>`
      SELECT space_id FROM spaces.items WHERE id = ${itemId} AND space_id = ${spaceId} FOR NO KEY UPDATE
    `;
    if (!item) return fail(err.notFound("Item"));
    let changed: boolean;
    if (operation === "add") {
      const [existing] = await tx<{ id: string }[]>`
        SELECT id FROM spaces.item_reactions WHERE item_id = ${itemId} AND emoji = ${emoji}
          AND (user_id = ${userId}::uuid OR service_account_id = ${serviceAccountId}::uuid)
      `;
      if (existing) return ok({ changed: false });
      const [limit] = await tx<{ count: number; present: boolean }[]>`
        SELECT count(DISTINCT emoji)::int AS count, COALESCE(bool_or(emoji = ${emoji}), false) AS present
        FROM spaces.item_reactions WHERE item_id = ${itemId}
      `;
      if (limit && !limit.present && limit.count >= MAX_ITEM_REACTION_EMOJI) {
        return fail({ code: "REACTION_LIMIT_REACHED", message: "An item can have at most 20 different emoji reactions", status: 409 });
      }
      // Timestamp after the item lock: now() predates any wait and can reorder committed emoji.
      const inserted =
        actor.kind === "user"
          ? await tx<{ id: string }[]>`
          INSERT INTO spaces.item_reactions (item_id, emoji, user_id, created_at) VALUES (${itemId}, ${emoji}, ${userId}, clock_timestamp())
          ON CONFLICT (item_id, emoji, user_id) WHERE user_id IS NOT NULL DO NOTHING RETURNING id`
          : await tx<{ id: string }[]>`
          INSERT INTO spaces.item_reactions (item_id, emoji, service_account_id, created_at) VALUES (${itemId}, ${emoji}, ${serviceAccountId}, clock_timestamp())
          ON CONFLICT (item_id, emoji, service_account_id) WHERE service_account_id IS NOT NULL DO NOTHING RETURNING id`;
      changed = inserted.length > 0;
    } else {
      const deleted = await tx<{ id: string }[]>`
        DELETE FROM spaces.item_reactions WHERE item_id = ${itemId} AND emoji = ${emoji}
          AND (user_id = ${userId}::uuid OR service_account_id = ${serviceAccountId}::uuid) RETURNING id
      `;
      changed = deleted.length > 0;
    }
    if (changed) await publishSpaceChange(tx, { type: "item.updated", spaceId: item.space_id, itemId });
    return ok({ changed });
  });
  if (!result.ok) return result;
  if (result.data.changed) spacesLive.wake();
  return ok({ reactions: await listForItem(itemId, actor) });
};

export const add = (params: ReactionIntent) => mutate("add", params);
export const remove = (params: ReactionIntent) => mutate("remove", params);
