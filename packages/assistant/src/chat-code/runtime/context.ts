import { type AuthContext, getLocale, getTimeZone, userFromActor } from "@k2b/cloud/server";
import { principalLabel } from "@k2b/cloud/shared";
import type { Context } from "hono";
export function viewerContext(c: Context<AuthContext>) {
  const user = userFromActor(c.get("actor"));
  return {
    locale: getLocale(c),
    timeZone: getTimeZone(c),
    user: user
      ? {
          id: user.id,
          name: principalLabel({ principal: { type: "user", userId: user.id }, displayName: user.displayName || user.uid }, getLocale(c)),
        }
      : null,
  };
}
