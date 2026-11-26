import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { isSignOutOthersRetry } from "../../sign-out-others";
import { authMessages } from "../messages";
import { VisitorHead } from "../VisitorHead";
import PasswordResetCompleteForm from "./PasswordResetCompleteForm.island";
import PasswordResetRequestForm from "./PasswordResetRequestForm.island";

/** Email password reset page for IPA-backed accounts. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const rawAppName = await coreSettings.get<string>("app.name");
  const appName = rawAppName || "My App";
  const params = new URL(c.req.url).searchParams;
  const token = params.get("token") ?? undefined;
  // After the password was set, the address keeps only the sign-out retry, without the used token.
  const retry = isSignOutOthersRetry(params);
  const completing = !!token || retry;
  const redirectTo = normalizeRedirectTo(params.get("redirectTo"));

  const formTitle = completing ? t.setNewPassword : t.resetPassword;
  const formSubtitle = completing ? t.resetLinkDescription : t.resetRequestDescription;

  c.get("page").title = formTitle;
  return () => (
    <MinimalLayout c={c} ui="v2" column>
      <VisitorHead appName={appName} title={formTitle} description={formSubtitle} />
      {completing ? (
        <PasswordResetCompleteForm token={token ?? ""} redirectTo={redirectTo} signOutFailed={retry} />
      ) : (
        <PasswordResetRequestForm redirectTo={redirectTo} />
      )}
    </MinimalLayout>
  );
});
