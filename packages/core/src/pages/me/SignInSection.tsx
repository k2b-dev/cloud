import { apiClient } from "@k2b/cloud/clients/core";
import type { UserProfile, UserProvider } from "@k2b/cloud/contracts";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { useLocale } from "@k2b/ui";
import { Button, confirm, Dialog, Field, Notice, Row, Section, Text, useToast } from "@k2b/ui/v2";
import { createSignal, onMount, Show } from "solid-js";
import { PasswordInput, PasswordSetupFields } from "../auth/PasswordSetupFields";
import {
  isSignOutOthersRetry,
  retrySignOutOthers,
  signInAgainHref,
  signOutOthersRetryPath,
  withoutSignOutOthersRetry,
} from "../sign-out-others";
import { useAccountMessages } from "./AccountWorkspace";
import { signOutCurrentSession } from "./account-session";

type Outcome = "signed-out" | "sign-in-again" | "sign-out-failed";

/**
 * Security › Sign-in and account: change the FreeIPA password, sign out here, delete a guest account. The endpoints,
 * the sign-out of every other sign-in after a password change and its retry through the address are unchanged; only
 * the dialogs are v2.
 */
export default function SignInSection(props: { userId: string; provider: UserProvider; profile: UserProfile; freeIpaEnabled: boolean }) {
  const t = useAccountMessages();
  const locale = useLocale();
  const toast = useToast();
  const isIpa = props.provider === "ipa" && props.freeIpaEnabled;
  const isGuest = props.profile === "guest";

  // ── What happens after the password changed ──
  /** A message the person must read before the page goes on, with the deed that follows. */
  const [notice, setNotice] = createSignal<{ text: string; confirm: string; next: () => void } | null>(null);
  const signedOutElsewhere = () => toast(t().passwordChangedToast, { status: "ok" });
  // Every sign-in ended, this browser's too: sign in again and come back to this page.
  const signInAgain = () =>
    setNotice({
      text: t().passwordChangedSignInAgain,
      confirm: t().signInAgain,
      next: () => {
        window.location.href = signInAgainHref(normalizeRedirectTo(`${window.location.pathname}${window.location.search}`));
      },
    });
  // The address keeps the unfinished retry until it succeeds or the person closes it, so a reload asks again.
  const keepRetryInAddress = (keep: boolean): void => {
    const url = new URL(window.location.href);
    if (isSignOutOthersRetry(url.searchParams) === keep) return;
    window.history.replaceState(window.history.state, "", keep ? signOutOthersRetryPath(url.href) : withoutSignOutOthersRetry(url));
  };
  // The password is already changed here; only signing out the other sign-ins is retried.
  const retryUntilSignedOut = async (): Promise<void> => {
    keepRetryInAddress(true);
    for (;;) {
      const retry = await confirm({
        title: t().changePasswordTitle,
        description: t().passwordChangedSignOutFailed,
        confirm: t().tryAgain,
        cancel: t().close,
      });
      if (!retry) return keepRetryInAddress(false);
      const outcome = await retrySignOutOthers();
      if (outcome === "sign-in-again") {
        signInToFinish();
        return;
      }
      if (outcome === "signed-out") {
        keepRetryInAddress(false);
        signedOutElsewhere();
        return;
      }
    }
  };
  // A retry found no browser sign-in here, so the other sign-ins may still be there: sign in, then this page retries.
  const signInToFinish = () =>
    setNotice({
      text: t().signInToFinishSignOut,
      confirm: t().signInAgain,
      next: () => {
        window.location.href = signInAgainHref(signOutOthersRetryPath(window.location.href));
      },
    });
  // After a reload or that sign-in, the address asks for the retry again.
  onMount(() => {
    if (isSignOutOthersRetry(new URL(window.location.href).searchParams)) void retryUntilSignedOut();
  });

  // ── Change password ──
  const [passwordOpen, setPasswordOpen] = createSignal(false);
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [passwordError, setPasswordError] = createSignal<string | null>(null);
  const [passwordBusy, setPasswordBusy] = createSignal(false);
  const openPassword = () => {
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    setPasswordOpen(true);
  };
  const changePassword = async () => {
    if (passwordBusy()) return;
    setPasswordError(null);
    if (!currentPassword().trim() || !newPassword() || !confirmPassword()) return setPasswordError(t().changePasswordFieldsRequired);
    if (newPassword() !== confirmPassword()) return setPasswordError(t().passwordsDoNotMatch);
    setPasswordBusy(true);
    try {
      const res = await apiClient.me.password.$post({
        json: { currentPassword: currentPassword(), newPassword: newPassword(), confirmPassword: confirmPassword() },
      });
      let outcome: Outcome;
      if (res.ok) outcome = (await res.json()).signInAgain ? "sign-in-again" : "signed-out";
      else {
        const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
        if (body?.code !== "SIGN_OUT_OTHERS_FAILED")
          throw new Error(res.status === 401 ? t().currentPasswordIncorrect : t().changePasswordFailed);
        outcome = "sign-out-failed";
      }
      setPasswordOpen(false);
      if (outcome === "signed-out") signedOutElsewhere();
      else if (outcome === "sign-in-again") signInAgain();
      else void retryUntilSignedOut();
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : t().changePasswordFailed);
    } finally {
      setPasswordBusy(false);
    }
  };

  // ── Sign out, delete ──
  const signOut = () =>
    void signOutCurrentSession(props.userId, t().signOutFailed).catch(() => toast(t().signOutFailedToast, { status: "bad" }));
  const remove = async () => {
    if (!(await confirm({ title: t().deleteAccountTitle, description: t().deleteAccountConfirm, confirm: t().delete, cancel: t().cancel })))
      return;
    const res = await apiClient.me.$delete({}).catch(() => null);
    if (!res?.ok) return toast(t().deleteAccountFailed, { status: "bad" });
    window.location.href = "/auth/login";
  };

  return (
    <>
      <Section icon="key" title={t().signInAndAccount} summary={t().signInAndAccountDescription}>
        <Show when={isIpa}>
          <Row icon="lock" lines={[t().changePassword, t().changeFreeIpaPassword]} action={{ label: t().change, onClick: openPassword }} />
        </Show>
        <Row icon="logout" lines={[t().signOut, t().signOutDescription]} action={{ label: t().signOut, onClick: signOut }} />
        <Show when={isGuest}>
          <Row
            icon="trash"
            lines={[t().deleteAccount, t().deleteAccountDescription]}
            action={{ label: t().delete, onClick: () => void remove() }}
          />
        </Show>
      </Section>
      <Dialog
        title={t().changePasswordTitle}
        open={passwordOpen()}
        onOpenChange={(open) => !passwordBusy() && setPasswordOpen(open)}
        foot={
          <>
            <Button disabled={passwordBusy()} onClick={() => setPasswordOpen(false)}>
              {t().cancel}
            </Button>
            <Button variant="primary" icon="lock-check" busy={passwordBusy()} onClick={() => void changePassword()}>
              {t().change}
            </Button>
          </>
        }
      >
        <Field name="currentPassword" label={t().currentPassword} required>
          <PasswordInput
            value={currentPassword()}
            onInput={setCurrentPassword}
            autocomplete="current-password"
            placeholder={t().currentPasswordPlaceholder}
            label={t().showPassword}
          />
        </Field>
        <PasswordSetupFields
          newPassword={newPassword}
          confirmPassword={confirmPassword}
          onNewPasswordChange={setNewPassword}
          onConfirmPasswordChange={setConfirmPassword}
          locale={locale()}
        />
        <Show when={passwordError()}>{(message) => <Notice tone="bad">{message()}</Notice>}</Show>
        <Text muted>{t().changePasswordSignsOutHint}</Text>
      </Dialog>
      <Dialog
        title={t().changePasswordTitle}
        open={notice() !== null}
        dismissible={false}
        onOpenChange={(open) => {
          if (!open) notice()?.next();
        }}
        foot={
          <Button variant="primary" onClick={() => notice()?.next()}>
            {notice()?.confirm}
          </Button>
        }
      >
        <Text>{notice()?.text}</Text>
      </Dialog>
    </>
  );
}
