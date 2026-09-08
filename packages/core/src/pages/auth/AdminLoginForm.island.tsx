import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, Checkbox, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { createSignal } from "solid-js";
import { authMessages } from "./messages";

export default function AdminLoginForm(props: { redirectTo?: string; requiresRecovery?: boolean }) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [token, setToken] = createSignal("");
  const [requiresRecovery, setRequiresRecovery] = createSignal(!!props.requiresRecovery);
  const [restoreLocalLogin, setRestoreLocalLogin] = createSignal(false);

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["admin-login"].$post({
        json: { token: token(), restoreLocalLogin: restoreLocalLogin() },
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; code?: string } | null;
        if (data?.code === "CATEGORY_RECOVERY_REQUIRED") setRequiresRecovery(true);
        throw new Error(data?.message ?? t().loginFailed({ status: res.status }));
      }
    },
    onSuccess: () => {
      window.location.href = props.redirectTo || "/";
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
      <TextInput
        label={t().adminToken}
        description={t().adminTokenDescription}
        placeholder={t().adminToken}
        icon="ti ti-key"
        password
        value={token}
        onValueChange={setToken}
        autocomplete="off"
      />

      {requiresRecovery() && (
        <NoticeCard tone="warning" title={t().restoreLoginTitle}>
          <Checkbox label={t().restoreLoginConfirmation} value={restoreLocalLogin} onValueChange={setRestoreLocalLogin} />
        </NoticeCard>
      )}

      {mutation.error() && (
        <NoticeCard tone="danger" icon={false}>
          <span>{mutation.error()?.message}</span>
        </NoticeCard>
      )}

      <Button
        type="submit"
        class="w-full justify-center py-2"
        disabled={requiresRecovery() && !restoreLocalLogin()}
        loading={mutation.loading()}
        loadingLabel={t().signingIn}
      >
        {mutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-shield" />}
        {t().signInWithAdminToken}
      </Button>
    </form>
  );
}
