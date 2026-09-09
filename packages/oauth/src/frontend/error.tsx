import { ButtonLink } from "@k2b/ui";
import { type AuthContext, getLocale } from "@k2b/cloud/server";
import { Layout } from "@k2b/cloud/ssr";
import { ssr } from "../config";
import { oauthMessages } from "./messages";

/** OAuth error page shown when authorization fails. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const error = c.req.query("error") ?? "unknown_error";
  const errorDescription = c.req.query("error_description") ?? t.unknownError;
  const clientName = c.req.query("client_name");

  return () => (
    <Layout c={c} title={[{ title: t.authorizationError }]}>
      <div class="max-w-md mx-auto flex flex-col gap-6">
        <div class="paper p-6 text-center">
          <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
            <i class="ti ti-shield-x text-3xl text-red-500" />
          </div>

          <h1 class="text-xl font-bold text-primary mb-2">{t.authorizationFailed}</h1>

          {clientName && (
            <p class="text-sm text-dimmed mb-4">
              {t.application}: <span class="font-medium text-primary">{clientName}</span>
            </p>
          )}

          <p class="text-sm text-dimmed mb-6">{errorDescription}</p>

          <div class="text-xs text-dimmed bg-zinc-100 dark:bg-zinc-800 rounded px-3 py-2 mb-6">
            {t.errorCode}: <code>{error}</code>
          </div>

          <ButtonLink href="/">
            <i class="ti ti-home" />
            {t.backHome}
          </ButtonLink>
        </div>
      </div>
    </Layout>
  );
});
