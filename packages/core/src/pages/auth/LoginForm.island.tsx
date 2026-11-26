import { apiClient } from "@k2b/cloud/clients/core";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { FREEIPA_APP_SIGN_IN_COOKIE } from "../app-approval/availability";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { authMessages } from "./messages";

export default function LoginForm(props: {
  redirectTo?: string;
  showBanner?: boolean;
  defaultUsername?: string;
  appName?: string;
  /** A shared workstation: the page remembers neither the username nor the method. */
  forget?: boolean;
  /** The other way to sign in to the same account ("Use the app instead"), beside the form's own action. */
  alternative?: { href: string; label: string };
}) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [username, setUsername] = createSignal(props.defaultUsername ?? "");
  const [password, setPassword] = createSignal("");

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth.login.$post(
        {
          json: { username: username(), password: password() },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      if (res.status === 409) throw new Error(t().signedOutWhileSigningIn);
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
      if (!props.forget) cookies.writeCookie("login_method", "ipa");
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
    >
      <Show when={props.showBanner}>
        <Notice tone="note" icon="info-circle">
          {t().freeIpaBanner({ appName: props.appName || t().thisApp })}
        </Notice>
      </Show>
      <Band>
        <Field label={t().usernameOrEmail} hint={t().usernameDescription}>
          <Input
            icon="user"
            value={username()}
            onInput={setUsername}
            placeholder={t().usernamePlaceholder}
            autocomplete={props.forget ? "off" : "username"}
            autocapitalize="off"
            spellcheck={false}
            autofocus={!props.defaultUsername}
          />
        </Field>
        <Field label={t().password} hint={t().passwordDescription}>
          <Input
            icon="lock"
            type="password"
            value={password()}
            onInput={setPassword}
            placeholder={t().freeIpaPassword}
            autocomplete="current-password"
            autofocus={!!props.defaultUsername}
          />
        </Field>
        <Text href={resetPasswordHref()}>{t().resetPassword}</Text>
      </Band>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        start={
          props.alternative && (
            <Button variant="ghost" icon="device-mobile" href={props.alternative.href}>
              {props.alternative.label}
            </Button>
          )
        }
        end={
          <Button variant="primary" type="submit" icon="login-2" busy={mutation.loading()}>
            {mutation.loading() ? t().signingIn : t().signInWithFreeIpa}
          </Button>
        }
      />
    </form>
  );
}
