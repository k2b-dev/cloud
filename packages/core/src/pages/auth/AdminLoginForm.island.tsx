import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Button, Check, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { signInAgainHref } from "../sign-out-others";
import { FormActions } from "./FormActions";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { authMessages } from "./messages";

export default function AdminLoginForm(props: { redirectTo?: string; requiresRecovery?: boolean }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [token, setToken] = createSignal("");
  const [requiresRecovery, setRequiresRecovery] = createSignal(!!props.requiresRecovery);
  const [restoreLocalLogin, setRestoreLocalLogin] = createSignal(false);

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["admin-login"].$post(
        {
          json: { token: token(), restoreLocalLogin: restoreLocalLogin() },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
        if (data?.code === "CATEGORY_RECOVERY_REQUIRED") setRequiresRecovery(true);
        throw new Error(data?.message ?? t().loginFailed({ status: res.status }));
      }
    },
    onSuccess: () => {
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutation.mutate({});
      }}
    >
      <Band>
        <Field label={t().adminToken}>
          <Input icon="key" type="password" value={token()} onInput={setToken} autocomplete="off" spellcheck={false} autofocus />
        </Field>
      </Band>
      <Show when={requiresRecovery()}>
        <Notice tone="warn" title={t().restoreLoginTitle}>
          <Check label={t().restoreLoginConfirmation} checked={restoreLocalLogin()} onChange={setRestoreLocalLogin} />
        </Notice>
      </Show>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <FormActions
        start={
          <Button variant="ghost" icon="arrow-left" href={signInAgainHref(props.redirectTo)}>
            {t().backToSignIn}
          </Button>
        }
        end={
          <Button
            variant="primary"
            type="submit"
            icon="shield"
            disabled={requiresRecovery() && !restoreLocalLogin()}
            busy={mutation.loading()}
          >
            {mutation.loading() ? t().signingIn : t().signInWithAdminToken}
          </Button>
        }
      />
    </form>
  );
}
