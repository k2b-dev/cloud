import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { useLocale } from "@k2b/ui";
import { Band, Button, Notice, Text } from "@k2b/ui/v2";
import { createSignal, createUniqueId, Show } from "solid-js";
import { signInAgainHref, signOutOthersRetryPath } from "../../sign-out-others";
import { FormActions } from "../FormActions";
import { afterSignInHref, confirmationRequestOptions } from "../login-redirect";
import { authMessages } from "../messages";
import { PasswordChangedSignInAgain } from "../PasswordChangedSignInAgain";
import { PasswordSetupFieldsV2 } from "../PasswordSetupFieldsV2";
import { SignOutOthersRecovery } from "../SignOutOthersRecovery";

type PasswordResetCompleteFormProps = {
  token: string;
  redirectTo?: string;
  /** Opens at the sign-out retry, as the page address says. */
  signOutFailed?: boolean;
};

/** The reset page without a token asks for a new link and keeps where to go afterwards. */
const newResetLinkHref = (redirectTo?: string): string =>
  redirectTo ? `/auth/password-reset?${new URLSearchParams({ redirectTo }).toString()}` : "/auth/password-reset";

export default function PasswordResetCompleteForm(props: PasswordResetCompleteFormProps) {
  const locale = useLocale();
  const t = () => authMessages.resolve([locale()]).t;
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");

  // The password is already changed and this browser signed in; only ending the other sign-ins is left.
  const [signOutFailed, setSignOutFailed] = createSignal(props.signOutFailed ?? false);
  // The password is changed, but a sign-out everywhere ended this browser's new sign-in before it was issued.
  const [signInAgain, setSignInAgain] = createSignal(false);

  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["password-reset"].complete.$post(
        {
          json: {
            token: props.token,
            newPassword: newPassword(),
            confirmPassword: confirmPassword(),
          },
        },
        confirmationRequestOptions(props.redirectTo),
      );
      if (res.status === 409) return "sign-in-again";
      const data = (await res.json().catch(() => null)) as {
        message?: string;
        signOutOthersFailed?: boolean;
      } | null;
      if (!res.ok) {
        throw new Error(data?.message ?? t().resetFailed);
      }
      return data?.signOutOthersFailed === true ? "sign-out-failed" : "signed-in";
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
            <PasswordSetupFieldsV2
              form={formId}
              newPassword={newPassword}
              confirmPassword={confirmPassword}
              onNewPasswordChange={setNewPassword}
              onConfirmPasswordChange={setConfirmPassword}
              autofocus
            />
            <Text href={signInAgainHref(props.redirectTo)}>{t().backToSignIn}</Text>
          </Band>
          <Show when={mutation.error()}>
            {(error) => (
              // Every attempt uses up the link, so a failure offers a new one right where it is reported.
              <Notice
                tone="bad"
                actions={[{ label: t().requestNewResetLink, icon: "mail-forward", href: newResetLinkHref(props.redirectTo) }]}
              >
                <span role="alert">{error().message}</span>
              </Notice>
            )}
          </Show>
          <FormActions
            end={
              <Button variant="primary" type="submit" form={formId} icon="lock-check" busy={mutation.loading()}>
                {mutation.loading() ? t().resettingPassword : t().setPassword}
              </Button>
            }
          />
        </>
      </Show>
    </Show>
  );
}
