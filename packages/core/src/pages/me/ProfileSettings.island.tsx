import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, TextInput, useLocale } from "@k2b/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import type { UserProfile, UserProvider } from "@k2b/cloud/contracts";
import { createSignal, Show } from "solid-js";
import { PasswordSetupFields } from "../auth/PasswordSetupFields";
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
        class={`ti ti-chevron-right shrink-0 text-xs text-dimmed transition-transform group-hover:translate-x-0.5 ${props.variant === "danger" ? "group-hover:text-red-500" : "group-hover:text-primary"}`}
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

      {error() && (
        <NoticeCard tone="danger" icon={false}>
          {error()}
        </NoticeCard>
      )}

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
  const passwordMutation = mutations.create<void, { currentPassword: string; newPassword: string; confirmPassword: string }>({
    mutation: async (vars) => {
      const res = await apiClient.me.password.$post({ json: vars });
      if (!res.ok) {
        throw new Error(res.status === 401 ? t().currentPasswordIncorrect : t().changePasswordFailed);
      }
    },
    onSuccess: () => prompts.alert(t().passwordChanged),
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
    <section class="paper p-5">
      <div class="mb-5">
        <h2 class="flex items-center gap-1.5 text-sm font-semibold text-primary">
          <i class="ti ti-user-cog text-sm" />
          {t().signInAndAccount}
        </h2>
        <p class="mt-1 text-xs text-dimmed">{t().signInAndAccountDescription}</p>
      </div>

      <div class="flex flex-col gap-1">
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
    </section>
  );
}
