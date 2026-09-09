import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { createSignal, onMount, Show } from "solid-js";
import { authMessages } from "./messages";
import { afterSignInHref } from "./login-redirect";

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
      const res = await apiClient.auth["email-login"].$post({
        json: { email: email(), redirectTo: props.redirectTo, category: props.category },
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.message as string) ?? t().requestFailed);
    },
    onSuccess: () => setShowTokenInput(true),
  });

  const tokenMutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["verify-token"].$post({
        json: { token: tokenInput() },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? t().invalidToken);
      }
    },
    onSuccess: () => {
      cookies.writeCookie("login_method", props.category ?? "email");
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
          <NoticeCard tone="success" icon={false}>
            {t().checkEmail}
          </NoticeCard>

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
            <NoticeCard tone="danger" icon={false}>
              <span>{error()?.message}</span>
            </NoticeCard>
          )}

          <Button type="submit" class="w-full justify-center py-2" loading={loading()} loadingLabel={t().verifying}>
            {tokenMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : t().verify}
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
          label={t().emailAddress}
          description={props.allowSelfRegistration ? t().selfRegistrationEmailDescription : t().existingEmailDescription}
          placeholder="you@example.org"
          type="email"
          icon="ti ti-mail"
          value={email}
          onValueChange={setEmail}
          autocomplete="email"
        />

        {error() && (
          <NoticeCard tone="danger" icon={false}>
            <span>{error()?.message}</span>
          </NoticeCard>
        )}

        <Button type="submit" size="lg" class="w-full justify-center" loading={loading()} loadingLabel={t().sendingLoginLink}>
          {emailMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-send" />}
          {t().sendLoginLink}
        </Button>

        <p class="text-sm text-dimmed">
          {props.allowSelfRegistration ? t().selfRegistrationHint : t().existingAccountHint}
        </p>
      </form>
    </Show>
  );
}
