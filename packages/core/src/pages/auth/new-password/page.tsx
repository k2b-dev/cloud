import { getLocale } from "@k2b/cloud/server";
import { coreSettings } from "@k2b/cloud/services";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../../config";
import { isSignOutOthersRetry } from "../../sign-out-others";
import { authMessages } from "../messages";
import { VisitorHead } from "../VisitorHead";
import NewPasswordForm from "./NewPasswordForm.island";

/** Set new password page (for expired/temporary passwords). */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const rawAppName = await coreSettings.get<string>("app.name");
  const appName = rawAppName || "My App";
  const params = new URL(c.req.url).searchParams;
  const user = params.get("ipa-uid") ?? "";
  const redirectTo = normalizeRedirectTo(params.get("redirectTo"));

  c.get("page").title = t.setNewPassword;
  return () => (
    <MinimalLayout c={c} ui="v2" column>
      <VisitorHead appName={appName} title={t.setNewPassword} description={t.expiredPasswordDescription} />
      <NewPasswordForm defaultUsername={user} redirectTo={redirectTo} signOutFailed={isSignOutOthersRetry(params)} />
    </MinimalLayout>
  );
});
