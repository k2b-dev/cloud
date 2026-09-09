import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import { createSignal } from "solid-js";
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
      class="flex flex-col gap-4"
    >
      {sent() && (
        <NoticeCard tone="success" icon={false}>
          {t().resetSent}
        </NoticeCard>
      )}

      <TextInput
        label={t().emailAddress}
        description={t().organizationEmailDescription}
        placeholder="you@example.org"
        icon="ti ti-mail"
        type="email"
        value={email}
        onValueChange={setEmail}
        autocomplete="email"
      />

      {mutation.error() && (
        <NoticeCard tone="danger" icon={false}>
          <span>{mutation.error()?.message}</span>
        </NoticeCard>
      )}

      <Button type="submit" class="w-full justify-center py-2" loading={mutation.loading()} loadingLabel={t().sendingResetLink}>
        {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-send" />}
        {t().sendResetLink}
      </Button>
    </form>
  );
}
