import { type AuthContext, getLocale, getTimeZone, userFromActor } from "@k2b/cloud/server";
import type { Context } from "hono";
export function viewerContext(c: Context<AuthContext>) {
  const user = userFromActor(c.get("actor"));
  return { locale: getLocale(c), timeZone: getTimeZone(c), user: user ? { id: user.id, name: user.displayName ?? user.id } : null };
}
