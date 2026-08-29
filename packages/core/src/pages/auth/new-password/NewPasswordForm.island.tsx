import { mutation as mutations } from "@k2b/stdlib/solid";
import { NoticeCard, Button, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@valentinkolb/cloud/clients/core";
import { createSignal } from "solid-js";
import { PasswordSetupFields } from "../PasswordSetupFields";
import { authMessages } from "../messages";

type NewPasswordFormProps = {
  defaultUsername: string;
  redirectTo?: string;
};

/** Form for changing an expired/temporary password. */
export default function NewPasswordForm(props: NewPasswordFormProps) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [username, setUsername] = createSignal(props.defaultUsername);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");

  const mutation = mutations.create({
    mutation: async () => {
      if (newPassword() !== confirmPassword()) {
        throw new Error(t().passwordsDoNotMatch);
      }
      const res = await apiClient.auth["change-expired-password"].$post({
        json: {
          username: username(),
          currentPassword: currentPassword(),
          newPassword: newPassword(),
          confirmPassword: confirmPassword(),
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error("message" in data ? data.message : t().passwordChangeFailed);
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
        label={t().username}
        description={t().organizationUsernameDescription}
        placeholder={t().usernameShortPlaceholder}
        icon="ti ti-user"
        value={username}
        onValueChange={setUsername}
        autocomplete="username"
      />

      <TextInput
        label={t().currentPassword}
        description={t().currentPasswordDescription}
        placeholder={t().currentPassword}
        icon="ti ti-lock"
        password
        value={currentPassword}
        onValueChange={setCurrentPassword}
        autocomplete="current-password"
      />

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

      <Button type="submit" class="w-full justify-center py-2" loading={mutation.loading()} loadingLabel={t().updatingPassword}>
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
