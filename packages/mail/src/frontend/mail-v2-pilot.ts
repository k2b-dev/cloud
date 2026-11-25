import type { Context } from "hono";
import { z } from "zod";

/**
 * Whether this person sees the mailbox on @k2b/ui v2 (provisional, until the maintainer accepts Mail on v2).
 * The administrator lists email addresses in `mail.ui_v2_pilot`; `*` shows v2 to everyone, as in the dev stack.
 * Addresses compare without case and surrounding space; a person without an address never matches a listed one.
 */
export const showsMailV2 = (pilot: readonly string[], email: string | null | undefined): boolean => {
  const listed = pilot.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (listed.includes("*")) return true;
  const own = email?.trim().toLowerCase();
  return !!own && listed.includes(own);
};

const pilotSnapshot = z.object({ mail: z.object({ ui_v2_pilot: z.array(z.string()) }) });

/**
 * The administrator's pilot list, from the request's settings snapshot (no read of its own). A router mounted without
 * the settings middleware, such as an isolated route test, lists nobody.
 */
export const readMailV2Pilot = (c: Context): readonly string[] => {
  const snapshot = pilotSnapshot.safeParse(c.get("settings"));
  return snapshot.success ? snapshot.data.mail.ui_v2_pilot : [];
};
