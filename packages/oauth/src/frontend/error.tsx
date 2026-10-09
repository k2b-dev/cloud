import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { ButtonLink } from "@k2b/ui";
import { ssr } from "../config";
import { AuthorizationPage } from "./_components/AuthorizationPage";
import { Outcome } from "./_components/AuthorizationParts";
import { oauthMessages } from "./messages";

/** OAuth error page shown when authorization fails. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const error = c.req.query("error") ?? "unknown_error";
  const errorDescription = c.req.query("error_description") ?? t.unknownError;
  const clientName = c.req.query("client_name");

  return () => (
    <AuthorizationPage c={c} title={t.authorizationError}>
      <Outcome
        icon="ti ti-shield-x"
        title={t.authorizationFailed}
        body={
          <>
            {errorDescription}
            <span class="mt-2 block text-xs">
              {clientName && (
                <>
                  {t.application}: <span class="font-medium text-secondary">{clientName}</span>
                  <br />
                </>
              )}
              {t.errorCode}: <code class="font-mono">{error}</code>
            </span>
          </>
        }
      >
        <ButtonLink href="/" variant="secondary" size="lg">
          {t.backHome}
        </ButtonLink>
      </Outcome>
    </AuthorizationPage>
  );
});
