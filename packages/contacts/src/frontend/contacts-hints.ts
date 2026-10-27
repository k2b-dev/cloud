import { hintOpen, markHintSeen } from "@k2b/cloud/ssr";
import type { Context } from "hono";

import { CONTACTS_FAVORITES_HINT_ID } from "./_components/contacts-hint-id";

export const CONTACTS_FAVORITES_HINT = CONTACTS_FAVORITES_HINT_ID;

/** Visiting the new path consumes the hint before this request decides to show it. */
export const contactsFavoritesHintOpen = (c: Context, readableBookCount: number): boolean => {
  // Write the cookie only while the hint is still unseen, not on every favorites visit.
  if (c.req.query("favorites") === "true" && hintOpen(c, CONTACTS_FAVORITES_HINT, { allowed: true }))
    markHintSeen(c, CONTACTS_FAVORITES_HINT);
  return hintOpen(c, CONTACTS_FAVORITES_HINT, { allowed: readableBookCount > 0 });
};
