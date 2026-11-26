import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Empty, Facts } from "@k2b/ui/v2";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { type ErrorReason, isErrorReason } from "./error-reasons";
import { oauthMessages } from "./messages";

type Messages = ReturnType<typeof oauthMessages.resolve>["t"];

/** The sentence of each reason; `app` is the application's registered name where the reason names one. */
const sentences: Record<ErrorReason, (t: Messages, app?: string) => string> = {
  consent_missing: (t) => t.consentMissing,
  consent_invalid: (t) => t.consentInvalid,
  consent_expired: (t) => t.consentNoLongerValid,
  client_unavailable: (t) => t.clientUnavailable,
  origin_invalid: (t) => t.consentOriginInvalid,
  account_not_allowed: (t, app) => (app ? t.accountNotAllowedFor({ app }) : t.deviceNoAccess),
  web_session_required: (t) => t.webSessionRequired,
  device_session_required: (t) => t.deviceSessionRequired,
  sign_in_again: (t) => t.deviceSignInAgain,
};

/** The page a person sees when this app refuses or cannot continue an authorization: the one reason, once. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const sent = c.req.query("error") ?? "";
  const reason = isErrorReason(sent) ? sent : undefined;
  // the application's name comes from its registration, never from the address
  const clientId = c.req.query("client");
  const client =
    reason === "account_not_allowed" && clientId && clientId.length <= 255 ? await oauth.clients.getByClientId({ clientId }) : null;
  const sentence = reason ? sentences[reason](t, client?.name) : t.unknownError;

  return () => (
    <AuthorizationPage c={c} title={t.authorizationError} heading={t.authorizationFailed}>
      <Empty icon="shield-x" tone="bad" text={sentence} action={{ label: t.backHome, icon: "home", href: "/" }} />
      <Facts items={[{ label: t.errorCode, value: reason ?? "unknown_error", mono: true }]} />
    </AuthorizationPage>
  );
});
