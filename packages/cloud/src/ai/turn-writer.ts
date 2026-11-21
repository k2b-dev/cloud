import type { RequestActor } from "../server";
import { isAppSessionActor } from "../server/actor";

/**
 * Whether `writer` may add text to a turn or queued message that runs as `stored`. Text added there runs with the
 * stored actor's authority, so the writer must not be weaker: a mobile app session may only write into turns started
 * in the app. Other callers, such as `cld`, keep their access.
 */
export const mayWriteIntoAiTurn = (writer: RequestActor, stored: RequestActor | undefined): boolean =>
  !isAppSessionActor(writer) || isAppSessionActor(stored);

/** The `403` message when {@link mayWriteIntoAiTurn} refuses. */
export const AI_TURN_WRITE_FORBIDDEN = "This was started outside the Cloud app. Continue it where it was started.";
