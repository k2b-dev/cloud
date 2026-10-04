/**
 * Deriving the acting user from a request actor.
 *
 * Roles, display name and avatar are user properties, so features that need
 * them still need a user — but it must come **from the actor**, never from a
 * separate context variable. `c.get("user")` drops the credential context on
 * the way, which is how a scope cap silently stops applying and how a route
 * ends up unable to tell a session from an API key.
 *
 * For authorization, do not use these helpers at all: pass
 * `c.get("accessSubject")` into the shared access helpers, which already
 * normalises a user-delegated credential to its user.
 */

import type { Context } from "hono";
import type { AuthContext } from "./middleware/auth";

type RequestActor = AuthContext["Variables"]["actor"];
type ActingUser = AuthContext["Variables"]["user"];

/** The user behind an actor: itself for a session, the delegate for a user-bound credential, null for a resource-bound one. */
export const userFromActor = (actor: RequestActor | undefined): ActingUser | null => {
  if (!actor) return null;
  return actor.kind === "user" ? actor.user : actor.delegatedUser;
};

/**
 * True when the actor works through the mobile app's session (directly, through an invocation or
 * in an Assistant turn started there). Such an actor must not create authority that outlives the
 * phone: sign-in methods, API keys or background mandates.
 */
export const isAppSessionActor = (actor: RequestActor | undefined): boolean => actor?.kind === "user" && actor.sessionKind === "app";

/** Same, read off the request context. */
export const getUserBackedActor = <T extends AuthContext>(c: Context<T>): ActingUser | null =>
  userFromActor(c.get("actor") as RequestActor | undefined);

/**
 * The acting user, or throw.
 *
 * Only for routes already gated to a user-backed role — the throw is a
 * programming-error guard, not an access check.
 */
export const expectUserBackedActor = <T extends AuthContext>(c: Context<T>): ActingUser => {
  const user = getUserBackedActor(c);
  if (!user) throw new Error("Expected user-backed actor after role middleware");
  return user;
};
