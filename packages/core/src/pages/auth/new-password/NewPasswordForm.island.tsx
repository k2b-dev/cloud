import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Button, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, createUniqueId, Show } from "solid-js";
import { signInAgainHref, signOutOthersRetryPath } from "../../sign-out-others";
import { FormActions } from "../FormActions";
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

  // the form stands apart and hidden; its fields and buttons name it, so no form box stands in the column
  const formId = createUniqueId();
  return (
    <Show when={!signInAgain()} fallback={<PasswordChangedSignInAgain redirectTo={props.redirectTo} />}>
      <Show when={!signOutFailed()} fallback={<SignOutOthersRecovery redirectTo={props.redirectTo} />}>
        <>
          <form
            id={formId}
            hidden
            onSubmit={(e) => {
              e.preventDefault();
              mutation.mutate({});
            }}
          />
          <Band>
            {/* the name from the link is only a suggestion: it stays in the field, where a wrong one can be corrected */}
            <Field label={t().username} hint={t().organizationUsernameDescription}>
              <Input
                form={formId}
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
                form={formId}
                icon="lock"
                type="password"
                value={currentPassword()}
                onInput={setCurrentPassword}
                autocomplete="current-password"
                autofocus={!!props.defaultUsername}
              />
            </Field>
          </Band>
          <Band>
            <PasswordSetupFieldsV2
              form={formId}
              newPassword={newPassword}
              confirmPassword={confirmPassword}
              onNewPasswordChange={setNewPassword}
              onConfirmPasswordChange={setConfirmPassword}
            />
            <Text href={signInAgainHref(props.redirectTo)}>{t().backToSignIn}</Text>
          </Band>
          <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
          <FormActions
            end={
              <Button variant="primary" type="submit" form={formId} icon="lock-check" busy={mutation.loading()}>
                {mutation.loading() ? t().updatingPassword : t().setPassword}
              </Button>
            }
          />
        </>
      </Show>
    </Show>
  );
}
