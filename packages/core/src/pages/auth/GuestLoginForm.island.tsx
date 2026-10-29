import { apiClient } from "@k2b/cloud/clients/core";
import { accountCategory } from "@k2b/cloud/contracts";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, ButtonLink, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { LOGIN_EMAIL_SIGN_IN_COOKIE } from "../app-approval/availability";
import { signInAgainHref } from "../sign-out-others";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { authMessages } from "./messages";

export default function GuestLoginForm(props: {
  redirectTo?: string;
  token?: string;
  allowSelfRegistration: boolean;
  category?: "guest" | "login";
}) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [email, setEmail] = createSignal("");
  const [tokenInput, setTokenInput] = createSignal(props.token ?? "");
  const [showTokenInput, setShowTokenInput] = createSignal(!!props.token);

  const emailMutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["email-login"].$post(
        {
          json: { email: email(), redirectTo: props.redirectTo, category: props.category },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.message as string) ?? t().requestFailed);
    },
    onSuccess: () => setShowTokenInput(true),
  });

  const tokenMutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["verify-token"].$post(
        {
          json: { token: tokenInput() },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? t().invalidToken);
      }
      const data = await res.json();
      if (!("user" in data)) throw new Error(t().invalidToken);
      return data.user;
    },
    onSuccess: (user) => {
      // A clicked mail link has no category prop; remember the verified account's category.
      const category = accountCategory(user);
      cookies.writeCookie("login_method", category);
      if (category === "login") cookies.writeCookie(LOGIN_EMAIL_SIGN_IN_COOKIE, "1");
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  onMount(() => {
    if (props.token) tokenMutation.mutate({});
  });

  const error = () => (showTokenInput() ? tokenMutation.error() : emailMutation.error());
  const loading = () => emailMutation.loading() || tokenMutation.loading();

  return (
    <Show
      when={!showTokenInput()}
      fallback={
        <form
          onSubmit={(e) => {
            e.preventDefault();
            tokenMutation.mutate({});
          }}
          class="flex flex-col gap-4"
        >
          <NoticeCard tone="success">{t().checkEmail}</NoticeCard>

          <TextInput
            label={t().loginCode}
            description={t().loginCodeDescription}
            placeholder={t().loginCode}
            icon="ti ti-key"
            value={tokenInput}
            onValueChange={setTokenInput}
            autocomplete="one-time-code"
          />

          {error() && (
            <NoticeCard tone="danger">
              <span>{error()?.message}</span>
              <ButtonLink href={signInAgainHref(props.redirectTo)} navigation="document" variant="text">
                {t().backToSignIn}
              </ButtonLink>
            </NoticeCard>
          )}

          <Button type="submit" class="w-full justify-center py-2" loading={loading()} loadingLabel={t().verifying}>
            {t().verify}
          </Button>
        </form>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          emailMutation.mutate({});
        }}
        class="flex flex-col gap-4"
      >
        <TextInput
          label={t().emailOrUsername}
          description={props.allowSelfRegistration ? t().selfRegistrationEmailDescription : t().existingEmailDescription}
          placeholder={t().emailOrUsernamePlaceholder}
          type="text"
          icon="ti ti-mail"
          value={email}
          onValueChange={setEmail}
          autocomplete="username"
        />

        {error() && (
          <NoticeCard tone="danger">
            <span>{error()?.message}</span>
          </NoticeCard>
        )}

        <Button type="submit" size="lg" class="w-full justify-center" loading={loading()} loadingLabel={t().sendingLoginLink}>
          <i class="ti ti-send" />
          {t().sendLoginLink}
        </Button>

        <p class="text-sm text-dimmed">{props.allowSelfRegistration ? t().selfRegistrationHint : t().existingAccountHint}</p>
      </form>
    </Show>
  );
}
