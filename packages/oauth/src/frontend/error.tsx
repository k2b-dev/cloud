import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Bar, Button, Facts, Notice } from "@k2b/ui/v2";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { oauthMessages } from "./messages";

/** OAuth error page shown when authorization fails. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const error = c.req.query("error") ?? "unknown_error";
  // The sentence comes from the error code in the page's language; the description in the address is only a detail,
  // in whatever language its sender wrote it.
  const sentence =
    {
      invalid_request: t.errorInvalidRequest,
      access_denied: t.errorAccessDenied,
      invalid_client: t.errorClient,
      unauthorized_client: t.errorClient,
      invalid_redirect_uri: t.errorRedirect,
      invalid_scope: t.errorScope,
      invalid_target: t.errorScope,
      server_error: t.errorServer,
      temporarily_unavailable: t.errorServer,
    }[error] ?? t.unknownError;
  const detail = c.req.query("error_description")?.trim().slice(0, 500);
  const clientName = c.req.query("client_name");

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
