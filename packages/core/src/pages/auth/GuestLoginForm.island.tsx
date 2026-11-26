import { apiClient } from "@k2b/cloud/clients/core";
import { accountCategory } from "@k2b/cloud/contracts";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Button, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, createUniqueId, onMount, Show } from "solid-js";
import { LOGIN_EMAIL_SIGN_IN_COOKIE } from "../app-approval/availability";
import { signInAgainHref } from "../sign-out-others";
import { FormActions } from "./FormActions";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { authMessages } from "./messages";

export default function GuestLoginForm(props: {
  redirectTo?: string;
  token?: string;
  allowSelfRegistration: boolean;
  category?: "guest" | "login";
  /** A shared workstation: the page remembers neither the address nor the method. */
  forget?: boolean;
  /** The other way into the same account ("Use the app instead"): a link in the form, beside its other links. */
  alternative?: { href: string; label: string };
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
      if (!props.forget) {
        cookies.writeCookie("login_method", category);
        if (category === "login") cookies.writeCookie(LOGIN_EMAIL_SIGN_IN_COOKIE, "1");
      }
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  onMount(() => {
    if (props.token) tokenMutation.mutate({});
  });

  const loading = () => emailMutation.loading() || tokenMutation.loading();

  // the form stands apart and hidden; its fields and buttons name it, so no form box stands in the column
  const codeFormId = createUniqueId();
  const emailFormId = createUniqueId();
  return (
    <Show
      when={!showTokenInput()}
      fallback={
        <>
          <form
            id={codeFormId}
            hidden
            onSubmit={(e) => {
              e.preventDefault();
              tokenMutation.mutate({});
            }}
          />
          <Notice tone="note" icon="mail-check">
            {t().checkEmail}
          </Notice>
          <Band>
            <Field label={t().loginCode} hint={t().loginCodeDescription}>
              <Input
                form={codeFormId}
                icon="key"
                value={tokenInput()}
                onInput={setTokenInput}
                placeholder={t().loginCode}
                autocomplete="one-time-code"
                spellcheck={false}
                autocapitalize="off"
                autofocus={!props.token}
              />
            </Field>
          </Band>
          <Show when={tokenMutation.error()}>
            {(error) => (
              <Notice tone="bad" actions={[{ label: t().backToSignIn, href: signInAgainHref(props.redirectTo) }]}>
                {error().message}
              </Notice>
            )}
          </Show>
          <FormActions
            end={
              <Button variant="primary" type="submit" form={codeFormId} busy={loading()}>
                {loading() ? t().verifying : t().verify}
              </Button>
            }
          />
        </>
      }
    >
      <>
        <form
          id={emailFormId}
          hidden
          onSubmit={(e) => {
            e.preventDefault();
            emailMutation.mutate({});
          }}
        />
        <Band>
          <Field
            label={t().emailOrUsername}
            hint={props.allowSelfRegistration ? t().selfRegistrationEmailDescription : t().existingEmailDescription}
          >
            <Input
              form={emailFormId}
              icon="mail"
              value={email()}
              onInput={setEmail}
              placeholder={t().emailOrUsernamePlaceholder}
              autocomplete={props.forget ? "off" : "username"}
              autocapitalize="off"
              spellcheck={false}
              autofocus
            />
          </Field>
          <Text type="meta" muted>
            {props.allowSelfRegistration ? t().selfRegistrationHint : t().existingAccountHint}
          </Text>
          <Show when={props.alternative}>{(link) => <Text href={link().href}>{link().label}</Text>}</Show>
        </Band>
        <Show when={emailMutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
        <FormActions
          end={
            <Button variant="primary" type="submit" form={emailFormId} icon="send" busy={loading()}>
              {loading() ? t().sendingLoginLink : t().sendLoginLink}
            </Button>
          }
        />
      </>
    </Show>
  );
}
