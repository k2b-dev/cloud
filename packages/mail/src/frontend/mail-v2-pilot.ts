import { app } from "../config";

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

/** The administrator's pilot list, as the mailbox page reads it. */
export const readMailV2Pilot = (): Promise<readonly string[]> => app.settings.get("mail.ui_v2_pilot");
