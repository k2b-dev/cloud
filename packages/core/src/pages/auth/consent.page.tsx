import { auth, getLocale } from "@k2b/cloud/server";
import { coreSettings, legalConsent } from "@k2b/cloud/services";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { MinimalLayout } from "@k2b/cloud/ssr";
import { ssr } from "../../config";
import ConsentForm from "./ConsentForm.island";
import { authMessages } from "./messages";
import { VisitorHead } from "./VisitorHead";

export default ssr(async (c) => {
  const t = authMessages.resolve([getLocale(c)]).t;
  const requested = normalizeRedirectTo(c.req.query("redirectTo")) ?? "/";
  const path = new URL(requested, c.req.url).pathname;
  const redirectTo = path === "/auth/continue" || path === "/auth/login" ? "/" : requested;
  const token = auth.session.getToken(c);
  if (token && (await auth.session.authenticateRequest(c, token))) return c.redirect(redirectTo, 302);
  const pending = await legalConsent.pending(c);
  if (!pending) return c.redirect(`/auth/login?${new URLSearchParams({ redirectTo })}`, 302);
  const { version } = await legalConsent.documents();
  const appName = (await coreSettings.get<string>("app.name")) || "My App";
  c.get("page").title = t.consentTitle;
  return () => (
    <MinimalLayout c={c} ui="v2" column>
      <VisitorHead appName={appName} title={t.consentTitle} description={t.consentDescription} />
      <ConsentForm userId={pending.user.id} version={version} redirectTo={redirectTo} />
    </MinimalLayout>
  );
});
