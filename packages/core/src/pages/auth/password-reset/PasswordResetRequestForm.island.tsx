import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { signInAgainHref } from "../../sign-out-others";
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({});
      }}
    >
      <Show when={sent()}>
        <Notice tone="note" icon="mail-check">
          <span role="status">{t().resetSent}</span>
        </Notice>
      </Show>
      <Band>
        <Field label={t().emailAddress} hint={t().organizationEmailDescription}>
          <Input icon="mail" type="email" value={email()} onInput={setEmail} placeholder="you@example.org" autocomplete="email" autofocus />
        </Field>
      </Band>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        start={
          <Button variant="ghost" icon="arrow-left" href={signInAgainHref(props.redirectTo)}>
            {t().backToSignIn}
          </Button>
        }
        end={
          <Button variant="primary" type="submit" icon="send" busy={mutation.loading()}>
            {mutation.loading() ? t().sendingResetLink : t().sendResetLink}
          </Button>
        }
      />
    </form>
  );
}
