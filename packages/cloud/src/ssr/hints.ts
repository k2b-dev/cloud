import type { Context } from "hono";
import { isHintId, mergeSeenHints, parseSeenHintsCookieHeader, seenHintsSetCookie } from "../contracts/seen-hints";
import { userFromActor } from "../server/actor";

/** The caller checks access to the new path; anonymous visitors never see a hint. */
export const hintOpen = (c: Context, id: string, options: { allowed: boolean }): boolean => {
  if (!isHintId(id)) throw new Error(`Invalid hint id: ${id}`);
  return options.allowed && !!userFromActor(c.get("actor")) && !parseSeenHintsCookieHeader(c.req.header("Cookie")).includes(id);
};

/** Call on the new path too: using it counts as having seen the hint. */
export const markHintSeen = (c: Context, id: string): void => {
  const ids = mergeSeenHints(parseSeenHintsCookieHeader(c.req.header("Cookie")), id);
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  c.header("Set-Cookie", seenHintsSetCookie(ids, secure), { append: true });
};
