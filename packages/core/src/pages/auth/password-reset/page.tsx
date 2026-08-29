import { ButtonLink, LocaleProvider } from "@k2b/ui";
import { listLegalLinks } from "@valentinkolb/cloud";
import { getLocale } from "@valentinkolb/cloud/server";
import { coreSettings } from "@valentinkolb/cloud/services";
import { normalizeRedirectTo, readThemeFromCookieHeader } from "@valentinkolb/cloud/shared";
import { ssr } from "../../../config";
import PasswordResetCompleteForm from "./PasswordResetCompleteForm.island";
import PasswordResetRequestForm from "./PasswordResetRequestForm.island";
import { authMessages } from "../messages";

/** Email password reset page for IPA-backed accounts. */
export default ssr(async (c) => {
  const locale = getLocale(c);
  const t = authMessages.resolve([locale]).t;
  const [rawAppName, legalLinks] = await Promise.all([coreSettings.get<string>("app.name"), listLegalLinks(locale)]);
  const appName = rawAppName || "My App";
  const params = new URL(c.req.url).searchParams;
  const token = params.get("token") ?? undefined;
  const redirectTo = normalizeRedirectTo(params.get("redirectTo"));
  const loginParams = new URLSearchParams();
  if (redirectTo) loginParams.set("redirectTo", redirectTo);
  const loginHref = loginParams.size > 0 ? `/auth/login?${loginParams.toString()}` : "/auth/login";

  const cookie = c.req.raw.headers.get("Cookie") ?? "";
  c.get("page").theme = readThemeFromCookieHeader(cookie);

  const title = token ? t.setNewPassword : t.resetYourPassword;
  const subtitle = token ? t.newPasswordIntro : t.resetIntro;
  const formTitle = token ? t.setNewPassword : t.resetPassword;
  const formSubtitle = token ? t.resetLinkDescription : t.resetRequestDescription;

  return () => (
    <LocaleProvider locale={locale}>
      <div class="min-h-screen bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
        <div class="flex min-h-screen flex-col items-center justify-center gap-5 p-4">
          <div class="grid w-full max-w-5xl overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-[0_16px_48px_rgb(24_24_27/0.12)] dark:border-zinc-800 dark:bg-zinc-950 [@media(min-width:560px)]:grid-cols-[0.9fr_1.1fr]">
            <aside class="flex flex-col justify-between border-r border-zinc-200 bg-zinc-50 p-8 dark:border-zinc-800 dark:bg-zinc-900/60 [@media(max-width:559px)]:hidden">
              <div class="flex flex-1 items-center justify-center">
                <div class="flex flex-col items-center gap-4 text-center">
                  <img
                    src="/branding/logo"
                    alt={appName}
                    width="112"
                    height="112"
                    class="max-h-28 max-w-28 object-contain"
                    style={{ "view-transition-name": "logo" }}
                  />
                  <p class="text-lg font-semibold text-primary">{appName}</p>
                </div>
              </div>

              <div class="max-w-md">
                <p class="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-400">{t.secureAccess}</p>
                <h1 class="mt-3 text-3xl font-semibold tracking-tight text-primary" style={{ "view-transition-name": "page-title" }}>
                  {title}
                </h1>
                <p class="mt-4 text-sm leading-6 text-dimmed">{subtitle}</p>
              </div>
            </aside>

            <main class="flex items-center justify-center p-6 sm:p-10">
              <div class="w-full max-w-md" style={{ "view-transition-name": "login-card" }}>
                <div class="mb-8 flex items-start justify-between gap-4">
                  <div>
                    <h1 class="text-3xl font-semibold tracking-tight text-primary">{formTitle}</h1>
                    <p class="mt-1 text-sm text-dimmed">{formSubtitle}</p>
                  </div>
                  <span class="inline-flex items-center gap-1 rounded-md bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 shadow-sm dark:bg-emerald-950/45 dark:text-emerald-300">
                    <i class="ti ti-shield-lock" />
                    {t.secure}
                  </span>
                </div>

                {token ? (
                  <PasswordResetCompleteForm token={token} redirectTo={redirectTo} />
                ) : (
                  <PasswordResetRequestForm redirectTo={redirectTo} />
                )}

                <ButtonLink href={loginHref} variant="secondary" size="sm" class="mt-4 w-full justify-center">
                  <i class="ti ti-arrow-left" />
                  {t.backToSignIn}
                </ButtonLink>
              </div>
            </main>
          </div>
          <div class="text-center text-xs text-dimmed">
            {legalLinks.map((link, i) => (
              <>
                {i > 0 ? " · " : null}
                <a href={link.href} target="_blank" class="hover:text-primary">
                  {link.label}
                </a>
              </>
            ))}
          </div>
        </div>
      </div>
    </LocaleProvider>
  );
});
