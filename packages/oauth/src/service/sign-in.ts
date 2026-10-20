import { requireConfirmedBrowserSignIn } from "@k2b/cloud/services";
import { sql } from "bun";

/** A browser confirmation can be renewed without discarding the authorization request. */
export class BrowserSignInRequiredError extends Error {
  constructor(readonly code: "REAUTHENTICATE" | "FORBIDDEN") {
    super(code);
  }
}

export const rejectBrowserSignIn = (code: "REAUTHENTICATE" | "FORBIDDEN"): never => {
  throw new BrowserSignInRequiredError(code);
};

/** Read-only page hint; writers repeat the same check inside their transaction. */
export const isConfirmedBrowserSignIn = async (signIn: { userId: string; sid: string } | null): Promise<boolean> => {
  if (!signIn) return false;
  try {
    await requireConfirmedBrowserSignIn(sql, signIn, rejectBrowserSignIn);
    return true;
  } catch (error) {
    if (error instanceof BrowserSignInRequiredError) return false;
    throw error;
  }
};
