import { apiClient } from "@k2b/cloud/clients/core";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createSignal } from "solid-js";
import { FREEIPA_APP_SIGN_IN_COOKIE } from "../app-approval/availability";
import { afterSignInHref } from "./login-redirect";
import { authMessages } from "./messages";

export default function LoginForm(props: { redirectTo?: string; showBanner?: boolean; defaultUsername?: string; appName?: string }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [username, setUsername] = createSignal(props.defaultUsername ?? "");
  const [password, setPassword] = createSignal("");

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth.login.$post({
        json: { username: username(), password: password() },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          message?: string;
          passwordExpired?: boolean;
          ipaUid?: string;
        } | null;
        if (data?.passwordExpired) {
          const params = new URLSearchParams({ "ipa-uid": data.ipaUid ?? username() });
          if (props.redirectTo) params.set("redirectTo", props.redirectTo);
          window.location.href = `/auth/new-password?${params.toString()}`;
          throw new Error(t().passwordExpiredRedirect);
        }
        throw new Error(data?.message ?? t().loginFailed({ status: res.status }));
      }
    },
    onSuccess: () => {
      cookies.writeCookie("login_method", "ipa");
      cookies.deleteCookie(FREEIPA_APP_SIGN_IN_COOKIE);
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  const resetPasswordHref = () => {
    const params = new URLSearchParams();
    if (props.redirectTo) params.set("redirectTo", props.redirectTo);
    return params.size > 0 ? `/auth/password-reset?${params.toString()}` : "/auth/password-reset";
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({});
      }}
      class="flex flex-col gap-4"
    >
      {props.showBanner && <NoticeCard tone="info">{t().freeIpaBanner({ appName: props.appName || t().thisApp })}</NoticeCard>}

      <TextInput
        label={t().usernameOrEmail}
        description={t().usernameDescription}
        placeholder={t().usernamePlaceholder}
        icon="ti ti-user"
        value={username}
        onValueChange={setUsername}
        autocomplete="username"
      />
      <div class="flex flex-col gap-1">
        <TextInput
          label={t().password}
          description={t().passwordDescription}
          placeholder={t().freeIpaPassword}
          icon="ti ti-lock"
          password
          value={password}
          onValueChange={setPassword}
          autocomplete="current-password"
        />
        <a
          href={resetPasswordHref()}
          class="auth-reset-link self-start text-xs font-medium text-blue-600 hover:text-blue-700 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
        >
          {t().resetPassword}
        </a>
      </div>

      {mutation.error() && (
        <NoticeCard tone="danger">
          <span>{mutation.error()?.message}</span>
        </NoticeCard>
      )}

      <Button type="submit" size="lg" class="w-full justify-center" loading={mutation.loading()} loadingLabel={t().signingIn}>
        {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-login-2" />}
        {t().signInWithFreeIpa}
      </Button>
    </form>
  );
}
