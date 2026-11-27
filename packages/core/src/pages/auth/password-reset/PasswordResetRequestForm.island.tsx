import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Button, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, createUniqueId, Show } from "solid-js";
import { signInAgainHref } from "../../sign-out-others";
import { FormActions } from "../FormActions";
import { authMessages } from "../messages";

type PasswordResetRequestFormProps = {
  redirectTo?: string;
};

export default function PasswordResetRequestForm(props: PasswordResetRequestFormProps) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [email, setEmail] = createSignal("");
  const [sent, setSent] = createSignal(false);

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["password-reset"].request.$post({
        json: {
          email: email(),
          redirectTo: props.redirectTo,
          acceptedAgb: true,
        },
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.message ?? t().resetRequestFailed);
      }
      setSent(true);
    },
  });

  // the form stands apart and hidden; its fields and buttons name it, so no form box stands in the column
  const formId = createUniqueId();
  return (
    <>
      <form
        id={formId}
        hidden
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate({});
        }}
      />
      <Show when={sent()}>
        <Notice tone="note" icon="mail-check">
          <span role="status">{t().resetSent}</span>
        </Notice>
      </Show>
      <Band>
        <Field label={t().emailAddress} hint={t().organizationEmailDescription}>
          <Input
            form={formId}
            icon="mail"
            type="email"
            value={email()}
            onInput={setEmail}
            placeholder={t().emailExample}
            autocomplete="email"
            autofocus
          />
        </Field>
        <Text href={signInAgainHref(props.redirectTo)}>{t().backToSignIn}</Text>
      </Band>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <FormActions
        end={
          <Button variant="primary" type="submit" form={formId} icon="send" busy={mutation.loading()}>
            {mutation.loading() ? t().sendingResetLink : t().sendResetLink}
          </Button>
        }
      />
    </>
  );
}
