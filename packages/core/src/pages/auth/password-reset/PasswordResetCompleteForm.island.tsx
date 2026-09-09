import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, useLocale } from "@k2b/ui";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { createSignal } from "solid-js";
import { PasswordSetupFields } from "../PasswordSetupFields";
import { authMessages } from "../messages";
import { afterSignInHref } from "../login-redirect";

type PasswordResetCompleteFormProps = {
  token: string;
  redirectTo?: string;
};

export default function PasswordResetCompleteForm(props: PasswordResetCompleteFormProps) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["password-reset"].complete.$post({
        json: {
          token: props.token,
          newPassword: newPassword(),
          confirmPassword: confirmPassword(),
        },
      });
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      if (!res.ok) {
        throw new Error(data?.message ?? t().resetFailed);
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
      class="flex flex-col gap-4"
    >
      <PasswordSetupFields
        newPassword={newPassword}
        confirmPassword={confirmPassword}
        onNewPasswordChange={setNewPassword}
        onConfirmPasswordChange={setConfirmPassword}
      />

      {mutation.error() && (
        <NoticeCard tone="danger" icon={false}>
          <span>{mutation.error()?.message}</span>
        </NoticeCard>
      )}

      <Button type="submit" class="w-full justify-center py-2" loading={mutation.loading()} loadingLabel={t().resettingPassword}>
        {mutation.loading() ? (
          <i class="ti ti-loader-2 animate-spin" />
        ) : (
          <>
            <i class="ti ti-lock-check" />
            <span>{t().setPassword}</span>
          </>
        )}
      </Button>
    </form>
  );
}
