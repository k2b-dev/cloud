import { apiClient } from "@k2b/cloud/clients/core";
import type { UserProfile, UserProvider } from "@k2b/cloud/contracts";
import { normalizeRedirectTo } from "@k2b/cloud/shared";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, SettingsSection, TextInput, useLocale } from "@k2b/ui";
import { createSignal, onMount, Show } from "solid-js";
import { PasswordSetupFields } from "../auth/PasswordSetupFields";
import {
  isSignOutOthersRetry,
  retrySignOutOthers,
  signInAgainHref,
  signOutOthersRetryPath,
  withoutSignOutOthersRetry,
} from "../sign-out-others";
import { signOutCurrentSession } from "./account-session";
import { accountMessages } from "./messages";

type Props = {
  provider: UserProvider;
  profile: UserProfile;
  freeIpaEnabled: boolean;
};

// ── Action Row ──

function ActionRow(props: { icon: string; label: string; description: string; onClick: () => void; variant?: "danger" }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      class={`group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        props.variant === "danger" ? "hover:bg-red-50 dark:hover:bg-red-950/30" : "hover:bg-[var(--ui-hover)]"
      }`}
    >
      <i class={`ti ${props.icon} text-base shrink-0 ${props.variant === "danger" ? "text-red-500" : "text-dimmed"}`} />
      <div class="flex-1 min-w-0">
        <span class={`text-sm block ${props.variant === "danger" ? "text-red-600 dark:text-red-400" : "text-primary"}`}>{props.label}</span>
        <span class="text-xs text-dimmed block">{props.description}</span>
      </div>
      <i
        class={`ti ti-chevron-right shrink-0 text-xs text-dimmed transition-colors ${props.variant === "danger" ? "group-hover:text-red-500" : "group-hover:text-primary"}`}
        aria-hidden="true"
      />
    </button>
  );
}

type ChangePasswordPayload = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

function ChangePasswordDialog(props: { close: (value: ChangePasswordPayload | null) => void }) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const [currentPassword, setCurrentPassword] = createSignal("");
  const [newPassword, setNewPassword] = createSignal("");
  const [confirmPassword, setConfirmPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);

  const submit = () => {
    setError(null);
    if (!currentPassword().trim() || !newPassword() || !confirmPassword()) {
      setError(t().changePasswordFieldsRequired);
      return;
    }
    if (newPassword() !== confirmPassword()) {
      setError(t().passwordsDoNotMatch);
      return;
    }
    props.close({
      currentPassword: currentPassword(),
      newPassword: newPassword(),
      confirmPassword: confirmPassword(),
    });
  };

  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextInput
        label={t().currentPassword}
        placeholder={t().currentPasswordPlaceholder}
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
        locale={locale()}
      />

      {error() && <NoticeCard tone="danger">{error()}</NoticeCard>}

      <p class="text-sm text-dimmed">{t().changePasswordSignsOutHint}</p>

      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(null)}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm">
          <i class="ti ti-lock-check" />
          {t().change}
        </Button>
      </div>
    </form>
  );
}

// ── Main Component ──

export default function ProfileSettings(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  // ── Account mutations ──
  const signedOutElsewhere = () => prompts.success(t().passwordChangedSignedOut, { title: t().changePasswordTitle });

  // Every sign-in ended, this browser's too: sign in again and come back to this page.
  const signInAgain = async (): Promise<void> => {
    await prompts.alert(t().passwordChangedSignInAgain, { title: t().changePasswordTitle, confirmText: t().signInAgain });
    window.location.href = signInAgainHref(normalizeRedirectTo(`${window.location.pathname}${window.location.search}`));
  };

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
      const retry = await prompts.confirm(t().passwordChangedSignOutFailed, {
        title: t().changePasswordTitle,
        icon: "ti ti-alert-triangle",
        confirmText: t().tryAgain,
        cancelText: t().close,
      });
      if (!retry) return keepRetryInAddress(false);
      const outcome = await retrySignOutOthers();
      if (outcome === "sign-in-again") return signInToFinish();
      if (outcome === "signed-out") {
        keepRetryInAddress(false);
        return void (await signedOutElsewhere());
      }
    }
  };

  // A retry found no browser sign-in here, so the other sign-ins may still be there: sign in, then this page retries.
  const signInToFinish = async (): Promise<void> => {
    await prompts.alert(t().signInToFinishSignOut, { title: t().changePasswordTitle, confirmText: t().signInAgain });
    window.location.href = signInAgainHref(signOutOthersRetryPath(window.location.href));
  };

  // After a reload or that sign-in, the address asks for the retry again.
  onMount(() => {
    if (isSignOutOthersRetry(new URL(window.location.href).searchParams)) void retryUntilSignedOut();
  });

  const passwordMutation = mutations.create<
    "signed-out" | "sign-in-again" | "sign-out-failed",
    { currentPassword: string; newPassword: string; confirmPassword: string }
  >({
    mutation: async (vars) => {
      const res = await apiClient.me.password.$post({ json: vars });
      if (res.ok) return (await res.json()).signInAgain ? "sign-in-again" : "signed-out";
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (body?.code === "SIGN_OUT_OTHERS_FAILED") return "sign-out-failed";
      throw new Error(res.status === 401 ? t().currentPasswordIncorrect : t().changePasswordFailed);
    },
    onSuccess: (outcome) =>
      outcome === "signed-out" ? signedOutElsewhere() : outcome === "sign-in-again" ? signInAgain() : retryUntilSignedOut(),
    onError: (err) => prompts.error(err.message),
  });

  const deleteMutation = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.me.$delete({});
      if (!res.ok) {
        throw new Error(t().deleteAccountFailed);
      }
    },
    onSuccess: () => {
      window.location.href = "/auth/login";
    },
    onError: (err) => prompts.error(err.message),
  });

  const handleChangePassword = async () => {
    const result = await prompts.dialog<ChangePasswordPayload | null>((close) => <ChangePasswordDialog close={close} />, {
      title: t().changePasswordTitle,
      icon: "ti ti-lock",
      size: "medium",
    });
    if (result) {
      await passwordMutation.mutate({
        currentPassword: result.currentPassword,
        newPassword: result.newPassword,
        confirmPassword: result.confirmPassword,
      });
    }
  };

  const handleDelete = async () => {
    const confirmed = await prompts.confirm(t().deleteAccountConfirm, {
      title: t().deleteAccountTitle,
      icon: "ti ti-trash",
      confirmText: t().delete,
      cancelText: t().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await deleteMutation.mutate();
    }
  };

  const isIpa = props.provider === "ipa" && props.freeIpaEnabled;
  const isGuest = props.profile === "guest";

  return (
    <SettingsSection title={t().signInAndAccount} subtitle={t().signInAndAccountDescription}>
      {/* The section body sets its children's margins; the inner list bleeds its row padding past the text edge. */}
      <div>
        <div class="-mx-3 flex flex-col gap-1">
          <Show when={isIpa}>
            <ActionRow icon="ti-lock" label={t().changePassword} description={t().changeFreeIpaPassword} onClick={handleChangePassword} />
          </Show>

          <ActionRow
            icon="ti-logout"
            label={t().signOut}
            description={t().signOutDescription}
            onClick={() =>
              void signOutCurrentSession(t().signOutFailed).catch((error) =>
                prompts.error(error instanceof Error ? error.message : t().signOutFailed),
              )
            }
          />

          <Show when={isGuest}>
            <ActionRow
              icon="ti-trash"
              label={t().deleteAccount}
              description={t().deleteAccountDescription}
              onClick={handleDelete}
              variant="danger"
            />
          </Show>
        </div>
      </div>
    </SettingsSection>
  );
}
