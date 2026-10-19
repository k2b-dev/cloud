import type { Context } from "hono";
import { isHintId, mergeSeenHints, parseSeenHintsCookieHeader, seenHintsSetCookie } from "../contracts/seen-hints";
import { userFromActor } from "../server/actor";

/** Ids marked seen earlier in the same request, so a second mark or a later check sees them too. */
const marked = new WeakMap<Context, string[]>();

const seenIds = (c: Context): string[] => marked.get(c) ?? parseSeenHintsCookieHeader(c.req.header("Cookie"));

/** The caller checks access to the new path; anonymous visitors never see a hint. */
export const hintOpen = (c: Context, id: string, options: { allowed: boolean }): boolean => {
  if (!isHintId(id)) throw new Error(`Invalid hint id: ${id}`);
  return options.allowed && !!userFromActor(c.get("actor")) && !seenIds(c).includes(id);
};

/**
 * Call on the new path too: using it counts as having seen the hint. Each call writes the whole list seen so far in
 * this request, so with several calls the browser keeps the last cookie and with it every id.
 */
export const markHintSeen = (c: Context, id: string): void => {
  const ids = mergeSeenHints(seenIds(c), id);
  marked.set(c, ids);
  const secure = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  c.header("Set-Cookie", seenHintsSetCookie(ids, secure), { append: true });
};
