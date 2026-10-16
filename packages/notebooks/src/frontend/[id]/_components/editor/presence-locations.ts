import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { type HeadingLine, headingAtLine } from "../../../../lib/note-insights";
import type { PresenceLocationsEventDetail } from "../detail/events";

/** Old clients without a user id, and malformed or unrelated cursor positions, are ignored. */
type ParticipantCursor = { writing: boolean; position: number | null };
export const participantCursors = (awareness: Awareness, ytext: Y.Text): Map<string, ParticipantCursor> => {
  const positions = new Map<string, ParticipantCursor>();
  const doc = ytext.doc;
  if (!doc) return positions;
  for (const [clientId, state] of awareness.getStates()) {
    if (clientId === doc.clientID) continue;
    const user: unknown = state.user;
    if (!user || typeof user !== "object" || !("userId" in user) || typeof user.userId !== "string") continue;
    let position: number | null = null;
    const cursor: unknown = state.cursor;
    if (cursor && typeof cursor === "object" && "head" in cursor && cursor.head && typeof cursor.head === "object") {
      try {
        const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(cursor.head), doc);
        if (head?.type === ytext) position = Math.min(head.index, ytext.length);
      } catch {
        // Awareness is ephemeral and may arrive before the referenced document update.
      }
    }
    // A person may have several tabs: prefer a tab with a visible cursor.
    if (!positions.has(user.userId) || position !== null || (cursor != null && !positions.get(user.userId)?.writing))
      positions.set(user.userId, { writing: cursor != null, position });
  }
  return positions;
};

export const presenceLocations = (
  positions: ReadonlyMap<string, ParticipantCursor>,
  markdown: string,
  headings: readonly HeadingLine[],
): PresenceLocationsEventDetail => {
  return Object.fromEntries(
    [...positions].map(([userId, { position, writing }]) => {
      const heading = position === null ? null : headingAtLine(headings, markdown.slice(0, position).split("\n").length);
      return [userId, { writing, headingId: heading?.id ?? null, headingText: heading?.text ?? null }];
    }),
  );
};
