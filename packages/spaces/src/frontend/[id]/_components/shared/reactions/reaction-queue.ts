import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import { type SpaceItemReaction, SpaceItemReactionsResponseSchema } from "@/contracts";
import { invalidateSpacesData } from "../../workspace/workspace-events";

/** The person's own reaction for one emoji on or off. Sent as PUT or DELETE, so repeating it changes nothing. */
export type ReactionIntent = { emoji: string; on: boolean };
export type ReactionTarget = { spaceId: string; itemId: string };
/** How the surface that made an intent hears of trouble, for its Retry toasts. */
export type ReactionNotice = {
  /** The intent was not saved and left the queue; Retry queues the same intent again. */
  failed: (intent: ReactionIntent) => void;
  /** The item already has every different emoji it may have, so the same intent would fail again. */
  limitReached: () => void;
  /** The intents were saved, but the item could not be read again; Retry reads it again. */
  refreshFailed: (retry: () => void) => void;
};

type Intent = ReactionIntent & {
  id: number;
  notice: ReactionNotice;
  /** Saved: it stays on the view until the item's canonical reads have been loaded again. */
  saved: boolean;
};

// Card and detail can show the same item at once and are rebuilt by live reloads, so intents live with the item, not
// with the component that made them. Only the browser writes here: a server render reads an empty map.
const [entries, setEntries] = createSignal<ReadonlyMap<string, readonly Intent[]>>(new Map());
/** The intent on its way per item. */
const sending = new Map<string, number>();
let nextId = 0;

const keyOf = (target: ReactionTarget) => `${target.spaceId}/${target.itemId}`;
type AnswerListener = (target: ReactionTarget, reactions: SpaceItemReaction[]) => void;
const answerListeners = new Set<AnswerListener>();
/** Hears each saved write's summary as it arrives, for a view that keeps its own newest summaries. */
export const onReactionAnswer = (listener: AnswerListener): (() => void) => {
  answerListeners.add(listener);
  return () => answerListeners.delete(listener);
};
const surfaces = new Map<string, ReactionNotice[]>();

/** Keeps failures visible when the surface that queued an intent has gone away. */
export const showReactions = (target: ReactionTarget, notice: ReactionNotice): (() => void) => {
  const key = keyOf(target);
  surfaces.set(key, [...(surfaces.get(key) ?? []), notice]);
  return () => {
    const remaining = (surfaces.get(key) ?? []).filter((surface) => surface !== notice);
    if (remaining.length) surfaces.set(key, remaining);
    else surfaces.delete(key);
  };
};

const noticeFor = (key: string, notice: ReactionNotice) => {
  const mounted = surfaces.get(key);
  return mounted?.includes(notice) ? notice : (mounted?.at(-1) ?? notice);
};
const update = (key: string, change: (intents: readonly Intent[]) => readonly Intent[]) =>
  setEntries((current) => {
    const next = new Map(current);
    const intents = change(current.get(key) ?? []);
    if (intents.length === 0) next.delete(key);
    else next.set(key, intents);
    return next;
  });

/** The intent applied to a summary: the person's own reaction on or off, the count with it. New emoji go last. */
const applyIntent = (reactions: SpaceItemReaction[], intent: ReactionIntent): SpaceItemReaction[] => {
  const index = reactions.findIndex((reaction) => reaction.emoji === intent.emoji);
  const current = index < 0 ? undefined : reactions[index]!;
  if ((current?.own ?? false) === intent.on) return reactions;
  if (!current) return [...reactions, { emoji: intent.emoji, count: 1, own: true, people: [] }];
  const count = current.count + (intent.on ? 1 : -1);
  if (count <= 0) return reactions.filter((_, position) => position !== index);
  return reactions.map((reaction, position) => (position === index ? { ...reaction, count, own: intent.on } : reaction));
};

/**
 * What the person sees: the item payload, then the person's intents in order. An intent names the state it wants,
 * so one that a newer payload already shows changes nothing. `busy` names the emoji with an intent still to be saved.
 */
export const shownReactions = (
  target: ReactionTarget,
  reactions: SpaceItemReaction[],
): { reactions: SpaceItemReaction[]; busy: ReadonlySet<string> } => {
  const intents = entries().get(keyOf(target)) ?? [];
  return {
    reactions: intents.reduce(applyIntent, reactions),
    busy: new Set(intents.filter((intent) => !intent.saved).map((intent) => intent.emoji)),
  };
};

class ReactionWriteError extends Error {
  constructor(
    status: number,
    readonly limitReached: boolean,
  ) {
    super(`Reaction write failed with ${status}`);
  }
}

const send = async (target: ReactionTarget, intent: ReactionIntent) => {
  const route = apiClient[":id"].items[":itemId"].reactions[":emoji"];
  const request = { param: { id: target.spaceId, itemId: target.itemId, emoji: encodeURIComponent(intent.emoji) }, query: {} };
  const res = await (intent.on ? route.$put(request) : route.$delete(request));
  if (!res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    const code = body && typeof body === "object" && "code" in body ? body.code : undefined;
    throw new ReactionWriteError(res.status, code === "REACTION_LIMIT_REACHED");
  }
  try {
    const parsed = SpaceItemReactionsResponseSchema.safeParse(await res.json());
    if (parsed.success) for (const listener of answerListeners) listener(target, parsed.data.reactions);
  } catch {
    // The write succeeded even if its summary cannot be read; the canonical reload still follows.
  }
};

/**
 * Loads the item's card and detail again. An answer's summary is no revision a later read can be ordered against, so
 * the saved intents stay on the view until these reads finish, and then leave it. A failed reload lets them go too,
 * as every other write does: the view shows the last read, and the toast says it is not current and reads again.
 */
const reload = (target: ReactionTarget, notice: ReactionNotice) => {
  const key = keyOf(target);
  // Only intents saved before the reads start are covered by them; one saved meanwhile waits for its own reload.
  const covered = new Set((entries().get(key) ?? []).filter((intent) => intent.saved).map((intent) => intent.id));
  const release = () => update(key, (intents) => intents.filter((intent) => !covered.has(intent.id)));
  invalidateSpacesData(["view", "detail"], null, target.itemId).then(release, () => {
    release();
    const surface = noticeFor(key, notice);
    surface.refreshFailed(() => reload(target, surface));
  });
};

/** Sends the item's intents one after another. A failed one leaves the queue and is reported; later ones still go. */
const drain = async (target: ReactionTarget) => {
  const key = keyOf(target);
  if (sending.has(key)) return;
  let saved: ReactionNotice | undefined;
  try {
    for (
      let next = entries()
        .get(key)
        ?.find((intent) => !intent.saved);
      next;
      next = entries()
        .get(key)
        ?.find((intent) => !intent.saved)
    ) {
      const intent = next;
      sending.set(key, intent.id);
      let ok = true;
      let limitReached = false;
      try {
        await send(target, intent);
      } catch (error) {
        ok = false;
        limitReached = error instanceof ReactionWriteError && error.limitReached;
      }
      if (ok) {
        saved = intent.notice;
        // A saved intent supersedes the saved ones before it for the same emoji.
        update(key, (intents) =>
          intents.flatMap((open) =>
            open.id === intent.id
              ? [{ ...open, saved: true }]
              : open.saved && open.emoji === intent.emoji && open.id < intent.id
                ? []
                : [open],
          ),
        );
      } else {
        update(key, (intents) => intents.filter((open) => open.id !== intent.id));
        const notice = noticeFor(key, intent.notice);
        if (limitReached) notice.limitReached();
        else notice.failed({ emoji: intent.emoji, on: intent.on });
      }
    }
  } finally {
    sending.delete(key);
  }
  // One reload covers every intent saved in this run.
  if (saved) reload(target, saved);
};

/**
 * Queues an intent behind the item's open ones. `notice` comes from the surface that made it. Each emoji keeps at most
 * one intent waiting behind the one on its way: a newer one replaces it, because only the last wish counts. So quick
 * presses or a held key send at most two requests per emoji, however slow the connection.
 */
export const queueReaction = (target: ReactionTarget, intent: ReactionIntent, notice: ReactionNotice) => {
  const key = keyOf(target);
  const queued: Intent = { emoji: intent.emoji, on: intent.on, id: ++nextId, notice, saved: false };
  update(key, (intents) => [
    ...intents.filter((open) => open.saved || open.emoji !== intent.emoji || open.id === sending.get(key)),
    queued,
  ]);
  void drain(target);
};
