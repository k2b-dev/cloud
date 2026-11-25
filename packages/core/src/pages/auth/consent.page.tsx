import { listLegalLinks } from "@k2b/cloud";
import { auth, getLocale } from "@k2b/cloud/server";
import { coreSettings, legalConsent } from "@k2b/cloud/services";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import AuthPage from "./AuthPage";
import ConsentScreen from "./ConsentScreen.island";

export default ssr(async (c) => {
  const requested = normalizeRedirectTo(c.req.query("redirectTo")) ?? "/";
  const path = new URL(requested, c.req.url).pathname;
  const redirectTo = path === "/auth/continue" || path === "/auth/login" ? "/" : requested;
  const token = auth.session.getToken(c);
  if (token && (await auth.session.authenticateRequest(c, token))) return c.redirect(redirectTo, 302);
  const pending = await legalConsent.pending(c);
  if (!pending) return c.redirect(`/auth/login?${new URLSearchParams({ redirectTo })}`, 302);
  const { version } = await legalConsent.documents();
  const [legalLinks, appName] = await Promise.all([listLegalLinks(getLocale(c)), coreSettings.get<string>("app.name")]);
  return () => (
    <MinimalLayout c={c} preferences={false}>
      <AuthPage legalVersion={version}>
        <ConsentScreen appName={appName || "Cloud"} legalLinks={legalLinks} userId={pending.user.id} version={version} redirectTo={redirectTo} />
      </AuthPage>
    </MinimalLayout>
  );
});
