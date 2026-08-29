/** @jsxImportSource solid-js */
import { Button } from "@k2b/ui";
import { type AuthContext, expectUserBackedActor, getLocale } from "@valentinkolb/cloud/server";
import { Layout } from "@valentinkolb/cloud/ssr";
import type { Context, Env } from "hono";
import { ssr } from "../config";
import { oauth } from "../service/oauth";
import { oauthMessages } from "./messages";

function localError<E extends Env>(c: Context<E>, description: string) {
  return c.redirect(`/oauth/error?error=invalid_request&error_description=${encodeURIComponent(description)}`);
}

const scopeLabel = (scope: string, t: ReturnType<typeof oauthMessages.resolve>["t"]): string => {
  if (scope === "read") return t.scopeConsentRead;
  if (scope === "write") return t.scopeConsentWrite;
  if (scope === "offline_access") return t.scopeConsentOffline;
  if (scope === "openid") return t.scopeConsentOpenId;
  if (scope === "profile") return t.scopeConsentProfile;
  if (scope === "email") return t.scopeConsentEmail;
  return scope;
};

/** Browser confirmation for one validated dynamic-client authorization request. */
export default ssr<AuthContext>(async (c) => {
  const { t } = oauthMessages.resolve([getLocale(c)]);
  const requestId = c.req.query("request");
  if (!requestId) return localError(c, t.consentMissing);
  const request = await oauth.consent.get(requestId);
  const user = expectUserBackedActor(c);
  if (!request || request.userId !== user.id) return localError(c, t.consentInvalid);
  const client = await oauth.clients.getByClientId({ clientId: request.clientId });
  if (!client || client.registrationKind !== "dynamic") return localError(c, t.clientUnavailable);

  const redirectHost = new URL(request.redirectUri).host;

  return () => (
    <Layout c={c} title={[{ title: t.authorizeApplication }]}>
      <main class="mx-auto flex w-full max-w-lg flex-col gap-5">
        <section class="paper p-6 sm:p-7">
          <div class="mb-5 flex items-start gap-3">
            <span class="flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
              <i class="ti ti-shield-check text-xl" aria-hidden="true" />
            </span>
            <div class="min-w-0">
              <h1 class="text-lg font-semibold text-primary">{t.authorize({ name: client.name })}</h1>
              <p class="mt-1 text-sm text-dimmed">{t.unverifiedDynamic}</p>
            </div>
          </div>

          <dl class="mb-5 grid gap-3 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-4 text-sm">
            <div>
              <dt class="text-xs font-medium uppercase tracking-wide text-dimmed">{t.resource}</dt>
              <dd class="mt-1 break-all font-mono text-xs text-secondary">{request.resource}</dd>
            </div>
            <div>
              <dt class="text-xs font-medium uppercase tracking-wide text-dimmed">{t.returnsTo}</dt>
              <dd class="mt-1 font-mono text-xs text-secondary">{redirectHost}</dd>
            </div>
            <div>
              <dt class="text-xs font-medium uppercase tracking-wide text-dimmed">{t.clientId}</dt>
              <dd class="mt-1 break-all font-mono text-xs text-secondary">{client.clientId}</dd>
            </div>
          </dl>

          <div class="mb-6">
            <h2 class="text-sm font-semibold text-primary">{t.requestedAccess}</h2>
            <ul class="mt-3 grid gap-2">
              {request.scopes.map((scope) => (
                <li class="flex items-start gap-2 text-sm text-secondary">
                  <i class="ti ti-check mt-0.5 text-emerald-600" aria-hidden="true" />
                  <span>{scopeLabel(scope, t)}</span>
                </li>
              ))}
            </ul>
          </div>

          <form method="post" action="/oauth/consent" class="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <input type="hidden" name="request" value={requestId} />
            <Button type="submit" name="decision" value="deny" variant="secondary">
              {t.deny}
            </Button>
            <Button type="submit" name="decision" value="approve">
              {t.allowAccess}
            </Button>
          </form>
        </section>
        <p class="px-2 text-center text-xs text-dimmed">{t.permissionLimit}</p>
      </main>
    </Layout>
  );
});
