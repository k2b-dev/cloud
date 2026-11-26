import type { AccountActivity } from "@k2b/cloud/contracts";
import { ACCOUNT_KINDS } from "./kinds";
import type { AccountMessages } from "./messages";

/** The app's own words for each self-service action of the audit log; a guard test keeps it complete. */
export const activityWords = (t: AccountMessages): Record<string, string> => ({
  "accounts.user.change_own_password": t.activityPasswordChanged,
  "accounts.user.remove_self": t.activityAccountDeleted,
  "accounts.user.update": t.activityProfileUpdated,
  "accounts.request.create": t.activityRequestSubmitted,
  "accounts.request.withdraw": t.activityRequestWithdrawn,
  "accounts.user.extend_account": t.activityAccountExtended,
  "service_account_credential.create": t.activityApiKeyCreated,
  "service_account_credential.revoke": t.activityApiKeyRevoked,
  "service_account_credential.authenticate": t.activityApiKeyUsed,
  "webauthn_credential.create": t.activityPasskeyAdded,
  "webauthn_credential.delete": t.activityPasskeyRemoved,
  "webauthn_credential.authenticate": t.activityPasskeyUsed,
  "auth.pwa.device.enroll": t.activityAppPaired,
  "auth.pwa.device.revoke": t.activityAppRemoved,
  "auth.session.sign_out_others": t.activitySignedOutElsewhere,
});

/** Whether the attempt was refused or failed: then it reads as a refusal, never as the deed it tried. */
export const activityRefused = (entry: Pick<AccountActivity, "outcome">): boolean => entry.outcome !== "allowed";

/** The app's own words for an activity it knows; the audit label for any other. A refused attempt says so. */
export const activityLabel = (entry: AccountActivity, t: AccountMessages): string => {
  const words = activityWords(t)[entry.action] ?? entry.label;
  if (!activityRefused(entry)) return words;
  if (entry.action === "webauthn_credential.authenticate") return t.activityPasskeyRefused;
  if (entry.action === "service_account_credential.authenticate") return t.activityApiKeyRefused;
  return t.activityRefused({ what: words });
};

/** An account event as the kind of thing it touched, with the same mark as on the account's pages. */
export const activityMark = (action: string): { icon: string; color: string } =>
  action.startsWith("webauthn_credential.")
    ? ACCOUNT_KINDS.passkey
    : action.startsWith("service_account_credential.")
      ? ACCOUNT_KINDS.apiKey
      : action.startsWith("auth.pwa.device.")
        ? ACCOUNT_KINDS.phone
        : action === "accounts.user.change_own_password"
          ? ACCOUNT_KINDS.password
          : action === "auth.session.sign_out_others"
            ? ACCOUNT_KINDS.session
            : action === "accounts.user.remove_self"
              ? ACCOUNT_KINDS.deletion
              : action.startsWith("accounts.request.")
                ? ACCOUNT_KINDS.freeIpa
                : ACCOUNT_KINDS.profile;
