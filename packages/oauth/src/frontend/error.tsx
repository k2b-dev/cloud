import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Bar, Button, Facts, Notice } from "@k2b/ui/v2";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { oauthMessages } from "./messages";

/** An error code as OAuth writes them; anything else in the address is shown as an unknown error. */
const ERROR_CODE = /^[a-z_]{1,64}$/;

/** OAuth error page shown when authorization fails. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const sent = c.req.query("error") ?? "";
  const error = ERROR_CODE.test(sent) ? sent : "unknown_error";
  // The sentence comes from the error code in the page's language, for the codes this app sends here; the description
  // in the address is only a detail, in whatever language its sender wrote it.
  const sentence =
    {
      invalid_request: t.errorInvalidRequest,
      access_denied: t.errorAccessDenied,
      web_session_required: t.webSessionRequired,
      device_session_required: t.deviceSessionRequired,
      sign_in_again: t.deviceSignInAgain,
    }[error] ?? t.unknownError;
  const detail = c.req.query("error_description")?.trim().slice(0, 500);
  const clientName = c.req.query("client_name")?.trim().slice(0, 200);

  return () => (
    <AuthorizationPage c={c} title={t.authorizationError} heading={t.authorizationFailed}>
      <Notice tone="bad" icon="shield-x">
        {sentence}
      </Notice>
      <Facts
        items={[
          ...(clientName ? [{ label: t.application, value: clientName }] : []),
          ...(detail ? [{ label: t.details, value: detail }] : []),
          { label: t.errorCode, value: error, mono: true },
        ]}
      />
      <Bar
        end={
          <Button icon="home" href="/">
            {t.backHome}
          </Button>
        }
      />
    </AuthorizationPage>
  );
});
