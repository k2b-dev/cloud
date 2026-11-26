import { apiClient } from "@k2b/cloud/clients/core";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Band, Bar, Button, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { createSignal, type JSX, Show } from "solid-js";
import { retrySignOutOthers, signInAgainHref, signOutOthersRetryPath } from "../sign-out-others";
import { useAuthMessages } from "./AuthFrame";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { PasswordInput, PasswordSetupFields } from "./PasswordSetupFields";

type Outcome = "signed-in" | "sign-in-again" | "sign-out-failed";

/** Shown when a password change succeeded but a sign-out everywhere ended its new sign-in before it was issued. */
export function PasswordChangedSignInAgain(props: { redirectTo?: string }) {
  const t = useAuthMessages();
  return (
    <Notice tone="warn" icon="login-2" actions={[{ label: t().signIn, href: signInAgainHref(props.redirectTo) }]}>
      {t().passwordChangedSignInAgain}
    </Notice>
  );
}

/** Shown after a password change signed this browser in but could not end the other sign-ins. */
export function SignOutOthersRecovery(props: { redirectTo?: string }) {
  const t = useAuthMessages();
  const [retrying, setRetrying] = createSignal(false);
  const retry = async () => {
    setRetrying(true);
    const outcome = await retrySignOutOthers();
    if (outcome === "signed-out") window.location.href = afterSignInHref(props.redirectTo);
    // Without a usable browser sign-in (ended, or terms not yet accepted), sign-in or consent comes back to this retry.
    else if (outcome === "sign-in-again") window.location.href = afterSignInHref(signOutOthersRetryPath(window.location.href));
    else setRetrying(false);
  };
  return (
    <Notice
      tone="bad"
      title={t().passwordChangedSignOutFailed}
      actions={[
        { label: retrying() ? t().signingOutOthers : t().tryAgain, icon: "refresh", disabled: retrying(), onClick: () => void retry() },
        { label: t().continueWithoutSignOut, href: afterSignInHref(props.redirectTo) },
      ]}
    >
      {t().signOutOthersRetryHint}
    </Notice>
  );
}

/** After the request: on to the page, or one of the two recoveries; the address keeps the retry across a reload. */
const useOutcome = (props: { redirectTo?: string; signOutFailed?: boolean }) => {
  const [signOutFailed, setSignOutFailed] = createSignal(props.signOutFailed ?? false);
  const [signInAgain, setSignInAgain] = createSignal(false);
  const settle = (outcome: Outcome) => {
    if (outcome === "sign-in-again") return setSignInAgain(true);
    if (outcome === "signed-in") {
      window.location.href = afterSignInHref(props.redirectTo);
      return;
    }
    window.history.replaceState(window.history.state, "", signOutOthersRetryPath(window.location.href));
    setSignOutFailed(true);
  };
  return { signOutFailed, signInAgain, settle };
};

/** A new password for an expired or temporary one; it signs in when it is set. */
export function NewPasswordForm(props: {
  defaultUsername: string;
  redirectTo?: string;
  signOutFailed?: boolean;
  start?: JSX.Element;
  lead?: string;
}) {
  const t = useAuthMessages();
  const [username, setUsername] = createSignal(props.defaultUsername);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const outcome = useOutcome(props);
  const mutation = mutations.create({
    mutation: async (): Promise<Outcome> => {
      if (newPassword() !== confirmPassword()) throw new Error(t().passwordsDoNotMatch);
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
      if (!res.ok) throw new Error("message" in data ? data.message : t().passwordChangeFailed);
      return "signOutOthersFailed" in data && data.signOutOthersFailed ? "sign-out-failed" : "signed-in";
    },
    onSuccess: outcome.settle,
  });
  const send = () => {
    if (!mutation.loading()) mutation.mutate({});
  };
  return (
    <Show when={!outcome.signInAgain()} fallback={<PasswordChangedSignInAgain redirectTo={props.redirectTo} />}>
      <Show when={!outcome.signOutFailed()} fallback={<SignOutOthersRecovery redirectTo={props.redirectTo} />}>
        <Band>
          <Show when={props.lead}>
            <Text muted>{props.lead}</Text>
          </Show>
          <Field name="username" label={t().username} hint={t().organizationUsernameDescription}>
            <Input
              icon="user"
              value={username()}
              onInput={setUsername}
              placeholder={t().usernameShortPlaceholder}
              autocomplete="username"
            />
          </Field>
          <Field name="currentPassword" label={t().currentPassword} hint={t().currentPasswordDescription}>
            <PasswordInput
              value={currentPassword()}
              onInput={setCurrentPassword}
              autocomplete="current-password"
              placeholder={t().currentPassword}
              label={t().showPassword}
            />
          </Field>
          <PasswordSetupFields
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            onNewPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
        </Band>
        <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
        <Bar
          start={props.start}
          end={
            <Button variant="primary" icon="lock-check" busy={mutation.loading()} onClick={send}>
              {t().setPassword}
            </Button>
          }
        />
      </Show>
    </Show>
  );
}

/** Asks for a reset link; the answer never says whether the address has an account. */
export function PasswordResetRequestForm(props: { redirectTo?: string; start?: JSX.Element; lead?: string }) {
  const t = useAuthMessages();
  const [email, setEmail] = createSignal("");
  const [sent, setSent] = createSignal(false);
  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["password-reset"].request.$post({
        json: { email: email(), redirectTo: props.redirectTo, acceptedAgb: true },
      });
      const data = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(data?.message ?? t().resetRequestFailed);
      setSent(true);
    },
  });
  const send = () => {
    if (!mutation.loading()) mutation.mutate({});
  };
  return (
    <>
      <Show when={sent()}>
        <Notice tone="note" icon="mail">
          {t().resetSent}
        </Notice>
      </Show>
      <Band>
        <Show when={props.lead}>
          <Text muted>{props.lead}</Text>
        </Show>
        <Field name="email" label={t().emailAddress} hint={t().organizationEmailDescription}>
          <Input
            type="email"
            icon="mail"
            value={email()}
            onInput={setEmail}
            placeholder="you@example.org"
            autocomplete="email"
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.isComposing) send();
            }}
          />
        </Field>
      </Band>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        start={props.start}
        end={
          <Button variant="primary" icon="send" busy={mutation.loading()} onClick={send}>
            {t().sendResetLink}
          </Button>
        }
      />
    </>
  );
}

/** The reset page without a token asks for a new link and keeps where to go afterwards. */
const newResetLinkHref = (redirectTo?: string): string =>
  redirectTo ? `/auth/password-reset?${new URLSearchParams({ redirectTo }).toString()}` : "/auth/password-reset";

/** Sets the new password from a reset link; every attempt uses the link up. */
export function PasswordResetCompleteForm(props: {
  token: string;
  redirectTo?: string;
  signOutFailed?: boolean;
  start?: JSX.Element;
  lead?: string;
}) {
  const t = useAuthMessages();
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const outcome = useOutcome(props);
  const mutation = mutations.create({
    mutation: async (): Promise<Outcome> => {
      const res = await apiClient.auth["password-reset"].complete.$post(
        { json: { token: props.token, newPassword: newPassword(), confirmPassword: confirmPassword() } },
        confirmationRequestOptions(props.redirectTo),
      );
      if (res.status === 409) return "sign-in-again";
      const data = (await res.json().catch(() => null)) as { message?: string; signOutOthersFailed?: boolean } | null;
      if (!res.ok) throw new Error(data?.message ?? t().resetFailed);
      return data?.signOutOthersFailed === true ? "sign-out-failed" : "signed-in";
    },
    onSuccess: outcome.settle,
  });
  const send = () => {
    if (!mutation.loading()) mutation.mutate({});
  };
  return (
    <Show when={!outcome.signInAgain()} fallback={<PasswordChangedSignInAgain redirectTo={props.redirectTo} />}>
      <Show when={!outcome.signOutFailed()} fallback={<SignOutOthersRecovery redirectTo={props.redirectTo} />}>
        <Band>
          <Show when={props.lead}>
            <Text muted>{props.lead}</Text>
          </Show>
          <PasswordSetupFields
            newPassword={newPassword}
            confirmPassword={confirmPassword}
            onNewPasswordChange={setNewPassword}
            onConfirmPasswordChange={setConfirmPassword}
          />
        </Band>
        <Show when={mutation.error()}>
          {(error) => (
            // Every attempt uses up the link, so a failure offers a new one right where it is reported.
            <Notice
              tone="bad"
              actions={[{ label: t().requestNewResetLink, icon: "mail-forward", href: newResetLinkHref(props.redirectTo) }]}
            >
              {error().message}
            </Notice>
          )}
        </Show>
        <Bar
          start={props.start}
          end={
            <Button variant="primary" icon="lock-check" busy={mutation.loading()} onClick={send}>
              {t().setPassword}
            </Button>
          }
        />
      </Show>
    </Show>
  );
}
