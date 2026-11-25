import { listLegalLinks } from "@k2b/cloud";
import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import { ssr } from "../../../config";
import { isSignOutOthersRetry } from "../../sign-out-others";
import AuthPage from "../AuthPage";
import { authMessages } from "../messages";
import PasswordScreen from "../PasswordScreen.island";

/** Email password reset page for IPA-backed accounts. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const [rawAppName, legalLinks] = await Promise.all([coreSettings.get<string>("app.name"), listLegalLinks(locale)]);
  const params = new URL(c.req.url).searchParams;
  const token = params.get("token") ?? undefined;
  // After the password was set, the address keeps only the sign-out retry, without the used token.
  const retry = isSignOutOthersRetry(params);
  const completing = !!token || retry;
  const redirectTo = normalizeRedirectTo(params.get("redirectTo"));
  const loginParams = new URLSearchParams();
  if (redirectTo) loginParams.set("redirectTo", redirectTo);
  const loginHref = loginParams.size > 0 ? `/auth/login?${loginParams.toString()}` : "/auth/login";

  return () => (
    <LocaleProvider locale={locale}>
      <AuthPage>
        <PasswordScreen
          appName={rawAppName || "My App"}
          legalLinks={legalLinks}
          title={completing ? t.setNewPassword : t.resetYourPassword}
          subtitle={completing ? t.resetLinkDescription : t.resetIntro}
          form={completing ? { kind: "reset-complete", token: token ?? "" } : { kind: "reset-request" }}
          redirectTo={redirectTo}
          signOutFailed={retry}
          loginHref={loginHref}
        />
      </AuthPage>
    </LocaleProvider>
  );
});
