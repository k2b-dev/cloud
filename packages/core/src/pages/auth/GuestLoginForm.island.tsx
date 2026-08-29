import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, Checkbox, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { createSignal, onMount, Show } from "solid-js";
import { authMessages } from "./messages";

export default function GuestLoginForm(props: { redirectTo?: string; token?: string; allowSelfRegistration: boolean }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [email, setEmail] = createSignal("");
  const [acceptedAgb, setAcceptedAgb] = createSignal(!!props.token);
  const [tokenInput, setTokenInput] = createSignal(props.token ?? "");
  const [showTokenInput, setShowTokenInput] = createSignal(!!props.token);

  const emailMutation = mutations.create({
    mutation: async () => {
      if (!acceptedAgb()) throw new Error(t().acceptLegal);
      const res = await apiClient.auth["email-login"].$post({
        json: { email: email(), acceptedAgb: true, redirectTo: props.redirectTo },
      });
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.message as string) ?? t().requestFailed);
    },
    onSuccess: () => setShowTokenInput(true),
  });

  const tokenMutation = mutations.create({
    mutation: async () => {
      if (!acceptedAgb()) throw new Error(t().acceptLegal);
      const res = await apiClient.auth["verify-token"].$post({
        json: { token: tokenInput(), acceptedAgb: true },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? t().invalidToken);
      }
    },
    onSuccess: () => {
      cookies.writeCookie("login_method", "email");
      window.location.href = props.redirectTo || "/";
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

          <Checkbox
            label={
              <span>
                {t().termsPrefix}{" "}
                <a href="/legal/terms" target="_blank" class="text-primary hover:underline">
                  {t().terms}
                </a>{" "}
                {t().privacyJoin}{" "}
                <a href="/legal/privacy" target="_blank" class="text-primary hover:underline">
                  {t().privacy}
                </a>
              </span>
            }
            value={acceptedAgb}
            onValueChange={setAcceptedAgb}
          />

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

        <Checkbox
          label={
            <span>
              {t().termsPrefix}{" "}
              <a href="/legal/terms" target="_blank" class="text-primary hover:underline">
                {t().terms}
              </a>{" "}
              {t().privacyJoin}{" "}
              <a href="/legal/privacy" target="_blank" class="text-primary hover:underline">
                {t().privacy}
              </a>
            </span>
          }
          value={acceptedAgb}
          onValueChange={setAcceptedAgb}
        />

        <Button type="submit" class="w-full justify-center py-2" loading={loading()} loadingLabel={t().sendingLoginLink}>
          {emailMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-send" />}
          {t().sendLoginLink}
        </Button>

        <div class="rounded-md border border-zinc-200 bg-zinc-50 p-3 text-xs leading-5 text-dimmed dark:border-zinc-800 dark:bg-zinc-900">
          {props.allowSelfRegistration ? t().selfRegistrationHint : t().existingAccountHint}
        </div>
      </form>
    </Show>
  );
}
