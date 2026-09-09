import { listLegalLinks } from "@valentinkolb/cloud";
import { auth, getLocale } from "@valentinkolb/cloud/server";
import { legalConsent } from "@valentinkolb/cloud/services";
import { normalizeRedirectTo } from "@valentinkolb/cloud/shared";
import { MinimalLayout } from "@valentinkolb/cloud/ssr";
import { ssr } from "../../config";
import AuthFooter from "./AuthFooter";
import ConsentForm from "./ConsentForm.island";
import { authMessages } from "./messages";

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
  const legalLinks = await listLegalLinks(getLocale(c));
  return () => (
    <MinimalLayout c={c} preferences={false}>
      <main class="flex min-h-screen flex-col items-center justify-center gap-6 bg-zinc-50 p-4 dark:bg-zinc-950">
        <section class="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-6 sm:p-8 dark:border-zinc-800 dark:bg-zinc-900">
          <h1 class="text-2xl font-semibold text-primary">{t.consentTitle}</h1>
          <p class="mt-2 text-sm text-dimmed">{t.consentDescription}</p>
          <ConsentForm version={version} redirectTo={redirectTo} />
        </section>
        <AuthFooter links={legalLinks} />
      </main>
    </MinimalLayout>
  );
});
