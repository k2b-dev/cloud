import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Band, Bar, Button, Empty, Facts } from "@k2b/ui/v2";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { AuthorizationPage, signedInName } from "./_components/AuthorizationPage";
import { type ErrorReason, isErrorReason, mayBeNamed } from "./error-reasons";
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The name of the application a device request was refused for, bound to that refusal: the request is open, its
 * application is one an administrator set up (`mayBeNamed`), and the signed-in person is indeed not allowed to use it.
 * Anything else names nothing, so a guessed request or client reveals no name.
 */
const refusedApp = async (
  actor: AuthContext["Variables"]["actor"] | undefined,
  request: string | undefined,
): Promise<string | undefined> => {
  if (actor?.kind !== "user" || !request || !UUID.test(request)) return undefined;
  const pending = await oauth.device.getPending(request);
  const client = pending ? await oauth.clients.getByClientId({ clientId: pending.clientId }) : null;
  if (!client || !mayBeNamed(client)) return undefined;
  const allowed = await oauth.clients.canAuthorizeUser({ client, userId: actor.user.id, profile: actor.user.profile });
  return allowed ? undefined : client.name;
};

/** The page a person sees when this app refuses or cannot continue an authorization: the one reason, once. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const sent = c.req.query("error") ?? "";
  const reason = isErrorReason(sent) ? sent : undefined;
  const sentence = reason
    ? sentences[reason](t, reason === "account_not_allowed" ? await refusedApp(c.get("actor"), c.req.query("request")) : undefined)
    : t.unknownError;

  return () => (
    <AuthorizationPage c={c} person={signedInName(c.get("actor"))} title={t.authorizationError} heading={t.authorizationFailed}>
      {/* the reason, its code, then the way on */}
      <Empty icon="shield-x" tone="bad" text={sentence} />
      <Band>
        <Facts items={[{ label: t.errorCode, value: reason ?? "unknown_error", mono: true }]} />
        <Bar
          end={
            <Button icon="home" href="/">
              {t.backHome}
            </Button>
          }
        />
      </Band>
    </AuthorizationPage>
  );
});
