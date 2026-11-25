import type { AccountActivity } from "@k2b/cloud/contracts";
import type { AccountMessages } from "./messages";

/** The app's own words for an activity it knows; the audit label for any other. */
export const activityLabel = (entry: AccountActivity, t: AccountMessages): string =>
  ({
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
  })[entry.action] ?? entry.label;
