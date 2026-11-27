import { PWA_SCOPE } from "@k2b/cloud/contracts/pwa-paths";
import type { shellMessages } from "../../messages";
import { phoneAuth } from "../phone";

type Messages = ReturnType<typeof shellMessages.resolve>["t"];

/** Where the sign-out question comes from: loaded when it is asked, so a page draws without the dialog's code. */
export const signOutQuestion = { load: () => import("./confirm-with-back") };

/**
 * Asks whether to sign out of the app. Rejects when the question cannot load, such as offline or after a newer release
 * replaced its file; the caller then says so and stays usable.
 */
export const askToSignOut = async (t: Messages, cloud: string): Promise<boolean> => {
  const { confirmWithBack } = await signOutQuestion.load();
  return confirmWithBack({ title: t.signOut, description: t.signOutConfirm({ cloud }), confirm: t.signOut });
};

/**
 * Signs this phone out of the app and opens the pairing view; the drafts of the account go with the session. Returns
 * what went wrong in words, or nothing when the app is on its way to the pairing view.
 */
export const signOutOfApp = async (t: Messages): Promise<string | undefined> => {
  const answer = await phoneAuth.signOut();
  if (answer.status === 204) {
    location.replace(PWA_SCOPE);
    return undefined;
  }
  return answer.status === 0 ? t.offline : t.failed;
};
