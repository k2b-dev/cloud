import { listLegalLinks } from "@k2b/cloud";
import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { LOCALE_COOKIE, normalizeRedirectTo } from "@k2b/cloud/shared";
import { LocaleProvider } from "@k2b/ui";
import { ssr } from "../../../config";
import { isSignOutOthersRetry } from "../../sign-out-others";
import AuthPage from "../AuthPage";
import { authMessages } from "../messages";
import PasswordScreen from "../PasswordScreen.island";

/** Set new password page (for expired/temporary passwords). */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const [rawAppName, legalLinks] = await Promise.all([coreSettings.get<string>("app.name"), listLegalLinks(locale)]);
  const params = new URL(c.req.url).searchParams;
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
          localeCookie={LOCALE_COOKIE}
          title={t.setNewPassword}
          subtitle={t.expiredPasswordDescription}
          form={{ kind: "new", defaultUsername: params.get("ipa-uid") ?? "" }}
          redirectTo={redirectTo}
          signOutFailed={isSignOutOthersRetry(params)}
          loginHref={loginHref}
        />
      </AuthPage>
    </LocaleProvider>
  );
});
