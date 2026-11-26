import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Bar, Button, Facts, Notice } from "@k2b/ui/v2";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { oauthMessages } from "./messages";

/** OAuth error page shown when authorization fails. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const error = c.req.query("error") ?? "unknown_error";
  const errorDescription = c.req.query("error_description") ?? t.unknownError;
  const clientName = c.req.query("client_name");

  return () => (
    <AuthorizationPage c={c} title={t.authorizationError} heading={t.authorizationFailed}>
      <Notice tone="bad" icon="shield-x">
        {errorDescription}
      </Notice>
      <Facts
        items={[...(clientName ? [{ label: t.application, value: clientName }] : []), { label: t.errorCode, value: error, mono: true }]}
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
