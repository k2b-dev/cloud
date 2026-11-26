import { PWA_SCOPE } from "@k2b/cloud/contracts";
import type { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";

/**
 * Signs this phone out of the app and opens the pairing view; the drafts of the account go with the session. Returns
 * what went wrong in words, or nothing when the app is on its way to the pairing view.
 */
export const signOutOfApp = async (t: ReturnType<typeof shellMessages.resolve>["t"]): Promise<string | undefined> => {
  const answer = await phoneAuth.signOut();
  if (answer.status === 204) {
    location.replace(PWA_SCOPE);
    return undefined;
  }
  return answer.status === 0 ? t.offline : t.failed;
};
