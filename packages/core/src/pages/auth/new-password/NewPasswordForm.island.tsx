import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Field, Input, Notice } from "@k2b/ui/v2";
import { createSignal, Show } from "solid-js";
import { signInAgainHref, signOutOthersRetryPath } from "../../sign-out-others";
import { afterSignInHref, confirmationRequestOptions } from "../login-redirect";
import { authMessages } from "../messages";
import { PasswordChangedSignInAgain } from "../PasswordChangedSignInAgain";
import { PasswordSetupFieldsV2 } from "../PasswordSetupFieldsV2";
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
      const res = await apiClient.auth["change-expired-password"].$post(
        {
          json: {
            username: username(),
            currentPassword: currentPassword(),
            newPassword: newPassword(),
            confirmPassword: confirmPassword(),
          },
        },
        confirmationRequestOptions(props.redirectTo),
      );
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
        >
          <Band>
            <Field label={t().username} hint={t().organizationUsernameDescription}>
              <Input
                icon="user"
                value={username()}
                onInput={setUsername}
                placeholder={t().usernameShortPlaceholder}
                autocomplete="username"
                autocapitalize="off"
                spellcheck={false}
                autofocus={!props.defaultUsername}
              />
            </Field>
            <Field label={t().currentPassword} hint={t().currentPasswordDescription}>
              <Input
                icon="lock"
                type="password"
                value={currentPassword()}
                onInput={setCurrentPassword}
                placeholder={t().currentPassword}
                autocomplete="current-password"
                autofocus={!!props.defaultUsername}
              />
            </Field>
          </Band>
          <Band>
            <PasswordSetupFieldsV2
              newPassword={newPassword}
              confirmPassword={confirmPassword}
              onNewPasswordChange={setNewPassword}
              onConfirmPasswordChange={setConfirmPassword}
            />
          </Band>
          <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
          <Bar
            start={
              <Button variant="ghost" icon="arrow-left" href={signInAgainHref(props.redirectTo)}>
                {t().backToSignIn}
              </Button>
            }
            end={
              <Button variant="primary" type="submit" icon="lock-check" busy={mutation.loading()}>
                {mutation.loading() ? t().updatingPassword : t().setPassword}
              </Button>
            }
          />
        </form>
      </Show>
    </Show>
  );
}
