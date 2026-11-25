import { finishIdleSignOut } from "@k2b/cloud/browser/session";
import { apiClient } from "@k2b/cloud/clients/core";
import { accountCategory } from "@k2b/cloud/contracts";
import { cookies } from "@k2b/stdlib/browser";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Band, Bar, Button, Check, Field, Input, Notice, Text } from "@k2b/ui/v2";
import { browserSupportsWebAuthn, startAuthentication } from "@simplewebauthn/browser";
import { createSignal, onMount, Show } from "solid-js";
import { FREEIPA_APP_SIGN_IN_COOKIE, LOGIN_EMAIL_SIGN_IN_COOKIE } from "../app-approval/availability";
import { signInAgainHref } from "../sign-out-others";
import { useAuthMessages } from "./AuthFrame";
import { autocomplete } from "./autocomplete";
import { afterSignInHref, confirmationRequestOptions } from "./login-redirect";
import { PasswordInput } from "./PasswordSetupFields";

// k2b-ui gap: v2 has no form primitive, so a sign-in form sends on Enter in its fields and on its button; the
// browser's password manager still finds the fields by their `autocomplete`.

const onEnter = (send: () => void) => (event: KeyboardEvent) => {
  if (event.key === "Enter" && !event.isComposing) send();
};

/** FreeIPA username and password. An expired password continues on the new-password page. */
export function FreeIpaForm(props: {
  /** The sentence that opens the form. */
  lead?: string | null;
  redirectTo?: string;
  showBanner?: boolean;
  defaultUsername?: string;
  appName?: string;
  forget?: boolean;
}) {
  const t = useAuthMessages();
  const [username, setUsername] = createSignal(props.defaultUsername ?? "");
  const [password, setPassword] = createSignal("");
  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth.login.$post(
        { json: { username: username(), password: password() } },
        confirmationRequestOptions(props.redirectTo),
      );
      if (res.status === 409) throw new Error(t().signedOutWhileSigningIn);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string; passwordExpired?: boolean; ipaUid?: string } | null;
        if (data?.passwordExpired) {
          const params = new URLSearchParams({ "ipa-uid": data.ipaUid ?? username() });
          if (props.redirectTo) params.set("redirectTo", props.redirectTo);
          window.location.href = `/auth/new-password?${params.toString()}`;
          throw new Error(t().passwordExpiredRedirect);
        }
        throw new Error(data?.message ?? t().loginFailed({ status: res.status }));
      }
    },
    onSuccess: () => {
      if (!props.forget) cookies.writeCookie("login_method", "ipa");
      cookies.deleteCookie(FREEIPA_APP_SIGN_IN_COOKIE);
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });
  const send = () => {
    if (!mutation.loading()) mutation.mutate({});
  };
  const resetPasswordHref = () => {
    const params = new URLSearchParams();
    if (props.redirectTo) params.set("redirectTo", props.redirectTo);
    return params.size > 0 ? `/auth/password-reset?${params.toString()}` : "/auth/password-reset";
  };
  return (
    <>
      <Show when={props.showBanner}>
        <Notice tone="note" icon="info-circle">
          {t().freeIpaBanner({ appName: props.appName || t().thisApp })}
        </Notice>
      </Show>
      <Band>
        <Show when={props.lead}>
          <Text muted>{props.lead}</Text>
        </Show>
        <Field name="username" label={t().usernameOrEmail} hint={t().usernameDescription}>
          <Input
            icon="user"
            value={username()}
            onInput={setUsername}
            placeholder={t().usernamePlaceholder}
            ref={autocomplete(props.forget ? "off" : "username")}
            onKeyDown={onEnter(send)}
          />
        </Field>
        <Field name="password" label={t().password} hint={t().passwordDescription}>
          <PasswordInput
            value={password()}
            onInput={setPassword}
            autocomplete="current-password"
            placeholder={t().freeIpaPassword}
            label={t().showPassword}
            onEnter={send}
          />
        </Field>
      </Band>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        start={
          <Button variant="text" href={resetPasswordHref()}>
            {t().resetPassword}
          </Button>
        }
        end={
          <Button variant="primary" icon="login-2" busy={mutation.loading()} onClick={send}>
            {t().signInWithFreeIpa}
          </Button>
        }
      />
    </>
  );
}

/** An email link: the address first, then the code from the mail (or the link's token, verified at once). */
export function EmailForm(props: {
  /** The sentence that opens the form. */
  lead?: string | null;
  redirectTo?: string;
  token?: string;
  allowSelfRegistration: boolean;
  category?: "guest" | "login";
  forget?: boolean;
}) {
  const t = useAuthMessages();
  const [email, setEmail] = createSignal("");
  const [tokenInput, setTokenInput] = createSignal(props.token ?? "");
  const [showTokenInput, setShowTokenInput] = createSignal(!!props.token);
  const emailMutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["email-login"].$post(
        { json: { email: email(), redirectTo: props.redirectTo, category: props.category } },
        confirmationRequestOptions(props.redirectTo),
      );
      const data = (await res.json()) as Record<string, unknown>;
      if (!res.ok) throw new Error((data.message as string) ?? t().requestFailed);
    },
    onSuccess: () => setShowTokenInput(true),
  });
  const tokenMutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["verify-token"].$post(
        { json: { token: tokenInput() } },
        confirmationRequestOptions(props.redirectTo),
      );
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? t().invalidToken);
      }
      const data = await res.json();
      if (!("user" in data)) throw new Error(t().invalidToken);
      return data.user;
    },
    onSuccess: (user) => {
      // A clicked mail link has no category prop; remember the verified account's category.
      const category = accountCategory(user);
      if (!props.forget) {
        cookies.writeCookie("login_method", category);
        if (category === "login") cookies.writeCookie(LOGIN_EMAIL_SIGN_IN_COOKIE, "1");
      }
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });
  onMount(() => {
    if (props.token) tokenMutation.mutate({});
  });
  const error = () => (showTokenInput() ? tokenMutation.error() : emailMutation.error());
  const loading = () => emailMutation.loading() || tokenMutation.loading();
  const sendEmail = () => {
    if (!loading()) emailMutation.mutate({});
  };
  const verify = () => {
    if (!loading()) tokenMutation.mutate({});
  };
  return (
    <Show
      when={!showTokenInput()}
      fallback={
        <>
          <Notice tone="note" icon="mail">
            {t().checkEmail}
          </Notice>
          <Band>
            <Field name="token" label={t().loginCode} hint={t().loginCodeDescription}>
              <Input
                icon="key"
                value={tokenInput()}
                onInput={setTokenInput}
                placeholder={t().loginCode}
                ref={autocomplete("one-time-code")}
                onKeyDown={onEnter(verify)}
              />
            </Field>
          </Band>
          <Show when={error()}>
            {(cause) => (
              <Notice tone="bad" actions={[{ label: t().backToSignIn, href: signInAgainHref(props.redirectTo) }]}>
                {cause().message}
              </Notice>
            )}
          </Show>
          <Bar
            end={
              <Button variant="primary" busy={loading()} onClick={verify}>
                {t().verify}
              </Button>
            }
          />
        </>
      }
    >
      <Band>
        <Show when={props.lead}>
          <Text muted>{props.lead}</Text>
        </Show>
        <Field
          name="email"
          label={t().emailOrUsername}
          hint={props.allowSelfRegistration ? t().selfRegistrationEmailDescription : t().existingEmailDescription}
        >
          <Input
            icon="mail"
            value={email()}
            onInput={setEmail}
            placeholder={t().emailOrUsernamePlaceholder}
            ref={autocomplete(props.forget ? "off" : "username")}
            onKeyDown={onEnter(sendEmail)}
          />
        </Field>
      </Band>
      <Show when={error()}>{(cause) => <Notice tone="bad">{cause().message}</Notice>}</Show>
      <Bar
        end={
          <Button variant="primary" icon="send" busy={loading()} onClick={sendEmail}>
            {t().sendLoginLink}
          </Button>
        }
      />
      <Text muted>{props.allowSelfRegistration ? t().selfRegistrationHint : t().existingAccountHint}</Text>
    </Show>
  );
}

/** The emergency admin token, with the recovery of local Login accounts when they are disabled. */
export function AdminForm(props: {
  redirectTo?: string;
  requiresRecovery?: boolean;
  /** The sentence that opens the form. */
  lead?: string | null;
}) {
  const t = useAuthMessages();
  const [token, setToken] = createSignal("");
  const [requiresRecovery, setRequiresRecovery] = createSignal(!!props.requiresRecovery);
  const [restoreLocalLogin, setRestoreLocalLogin] = createSignal(false);
  const mutation = mutations.create({
    mutation: async () => {
      const res = await apiClient.auth["admin-login"].$post(
        { json: { token: token(), restoreLocalLogin: restoreLocalLogin() } },
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
  const blocked = () => requiresRecovery() && !restoreLocalLogin();
  const send = () => {
    if (!mutation.loading() && !blocked()) mutation.mutate({});
  };
  return (
    <>
      <Band>
        <Show when={props.lead}>
          <Text muted>{props.lead}</Text>
        </Show>
        <Field name="token" label={t().adminToken} hint={t().adminTokenDescription}>
          <PasswordInput
            value={token()}
            onInput={setToken}
            autocomplete="off"
            placeholder={t().adminToken}
            label={t().showPassword}
            onEnter={send}
          />
        </Field>
      </Band>
      <Show when={requiresRecovery()}>
        <Notice tone="warn" title={t().restoreLoginTitle}>
          {t().restoreLoginConfirmation}
        </Notice>
        <Check label={t().restoreLoginConfirm} checked={restoreLocalLogin()} onChange={setRestoreLocalLogin} />
      </Show>
      <Show when={mutation.error()}>{(error) => <Notice tone="bad">{error().message}</Notice>}</Show>
      <Bar
        end={
          <Button variant="primary" icon="shield" busy={mutation.loading()} disabled={blocked()} onClick={send}>
            {t().signInWithAdminToken}
          </Button>
        }
      />
    </>
  );
}

/** Signing in with a passkey of this device; the error stays at the place where it was started. */
export const usePasskeySignIn = (props: { redirectTo?: string; forget?: boolean }) => {
  const t = useAuthMessages();
  const mutation = mutations.create({
    mutation: async () => {
      if (!browserSupportsWebAuthn()) throw new Error(t().passkeysUnsupported);
      const optionsRes = await apiClient.auth.passkeys.authentication.start.$post();
      const options = await optionsRes.json();
      if (!optionsRes.ok) throw new Error((options as { message?: string }).message ?? t().passkeyStartFailed);
      const response = await startAuthentication({ optionsJSON: options as never });
      const verifyRes = await apiClient.auth.passkeys.authentication.verify.$post(
        { json: { response } },
        confirmationRequestOptions(props.redirectTo),
      );
      if (!verifyRes.ok) {
        const data = (await verifyRes.json().catch(() => null)) as { message?: string } | null;
        throw new Error(data?.message ?? t().passkeyLoginFailed);
      }
    },
    onSuccess: () => {
      if (!props.forget) cookies.writeCookie("login_method", "passkey");
      window.location.href = afterSignInHref(props.redirectTo);
    },
  });
  return { start: () => mutation.mutate({}), busy: mutation.loading, error: () => mutation.error()?.message };
};

/**
 * After a shared workstation signed out for lack of input: ends the session the page left and clears its data in this
 * browser. Says so when that did not fully work and offers to try again.
 */
export function IdleSignOutFinish() {
  const t = useAuthMessages();
  const [failed, setFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const finish = async () => {
    setBusy(true);
    setFailed((await finishIdleSignOut()) === "failed");
    setBusy(false);
  };
  onMount(() => void finish());
  return (
    <Show when={failed()}>
      <Notice tone="warn" actions={[{ label: t().tryAgain, icon: "refresh", disabled: busy(), onClick: () => void finish() }]}>
        {t().idleCleanupFailed}
      </Notice>
    </Show>
  );
}
