import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, TextInput, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { signOutOthersRetryPath } from "../../sign-out-others";
import { afterSignInHref } from "../login-redirect";
import { authMessages } from "../messages";
import { PasswordChangedSignInAgain } from "../PasswordChangedSignInAgain";
import { PasswordSetupFields } from "../PasswordSetupFields";
import { SignOutOthersRecovery } from "../SignOutOthersRecovery";

type NewPasswordFormProps = {
  defaultUsername: string;
  redirectTo?: string;
  /** Opens at the sign-out retry, as the page address says. */
  signOutFailed?: boolean;
};

/** Form for changing an expired/temporary password. */
export default function NewPasswordForm(props: NewPasswordFormProps) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [username, setUsername] = createSignal(props.defaultUsername);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");

  // The password is already changed and this browser signed in; only ending the other sign-ins is left.
  const [signOutFailed, setSignOutFailed] = createSignal(props.signOutFailed ?? false);
  // The password is changed, but a sign-out everywhere ended this browser's new sign-in before it was issued.
  const [signInAgain, setSignInAgain] = createSignal(false);

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
      if (res.status === 409) return "sign-in-again";
      const data = await res.json();
      if (!res.ok) {
        throw new Error("message" in data ? data.message : t().passwordChangeFailed);
      }
      return "signOutOthersFailed" in data && data.signOutOthersFailed ? "sign-out-failed" : "signed-in";
    },
    onSuccess: (outcome) => {
      if (outcome === "sign-in-again") {
        setSignInAgain(true);
        return;
      }
      if (outcome === "signed-in") {
        window.location.href = afterSignInHref(props.redirectTo);
        return;
      }
      // The address keeps the retry across a reload and the sign-in or consent a retry can need.
      window.history.replaceState(window.history.state, "", signOutOthersRetryPath(window.location.href));
      setSignOutFailed(true);
    },
  });

  return (
    <Show when={!signInAgain()} fallback={<PasswordChangedSignInAgain redirectTo={props.redirectTo} />}>
      <Show when={!signOutFailed()} fallback={<SignOutOthersRecovery redirectTo={props.redirectTo} />}>
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
            <NoticeCard tone="danger">
              <span>{mutation.error()?.message}</span>
            </NoticeCard>
          )}

          <Button type="submit" class="w-full justify-center py-2" loading={mutation.loading()} loadingLabel={t().updatingPassword}>
            <i class="ti ti-lock-check" />
            <span>{t().setPassword}</span>
          </Button>
        </form>
      </Show>
    </Show>
  );
}
