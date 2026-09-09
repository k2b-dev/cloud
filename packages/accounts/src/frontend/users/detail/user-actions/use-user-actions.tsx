import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, DatePicker, NoticeCard, prompts, toast } from "@k2b/ui";
import { openAvatarUploadDialog } from "@k2b/cloud/account/ui";
import type { AccountActionNoticeInput } from "@k2b/cloud/shared";
import { createSignal } from "solid-js";
import { apiClient } from "@/api/client";
import type { User } from "@/contracts";
import { showAccountActionNotice } from "../../../action-notice";
import { useAccountsMessages } from "../../../messages";
import { createDeleteUserAction } from "../../delete-user";
import { openCredentialDialog } from "./credential-dialog";

type UserActionsProps = {
  user: User;
  listHref: string;
  freeIpaEnabled: boolean;
};

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const toSafeParagraphHtml = (value: string): string =>
  value
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<p>${escapeHtml(line)}</p>`)
    .join("");

const confirmProviderSwitch = (config: {
  title: string;
  icon: string;
  confirmText: string;
  cancelText: string;
  description: string;
  details: string[];
}) =>
  prompts.confirm(
    <div class="flex flex-col gap-2">
      <p>{config.description}</p>
      <ul class="list-disc list-inside text-sm text-dimmed">
        {config.details.map((detail) => (
          <li>{detail}</li>
        ))}
      </ul>
    </div>,
    {
      title: config.title,
      icon: config.icon,
      confirmText: config.confirmText,
      cancelText: config.cancelText,
    },
  );

export function createUserActions(props: UserActionsProps) {
  const messages = useAccountsMessages();
  const notice = (action: AccountActionNoticeInput["action"], extra: Partial<AccountActionNoticeInput> = {}) =>
    showAccountActionNotice(
      {
        action,
        id: props.user.id,
        uid: props.user.uid,
        name: props.user.uid,
        email: props.user.mail ?? "",
        firstName: props.user.givenname,
        lastName: props.user.sn,
        provider: props.user.provider,
        profile: props.user.profile,
        category: props.user.provider === "ipa" ? "freeipa" : props.user.profile === "guest" ? "guest" : "login",
        ...extra,
      },
      messages(),
    );
  const editMutation = mutations.create<
    void,
    {
      givenname: string;
      sn: string;
      displayName: string;
      mail?: string;
      ipa?: {
        phone?: string;
      };
    }
  >({
    mutation: async (vars) => {
      const res = await apiClient.users[":id"].$patch({
        param: { id: props.user.id },
        json: vars,
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().updateUserFailed);
      }
      await notice("user.update", { email: vars.mail ?? props.user.mail ?? "", firstName: vars.givenname, lastName: vars.sn });
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const saveAvatar = async (dataUrl: string) => {
    const res = await apiClient.users[":id"].avatar.$put({
      param: { id: props.user.id },
      json: { dataUrl },
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.message ?? messages().updateAvatarFailed);
    }
    refreshCurrentPath();
  };

  const removeAvatar = async () => {
    const res = await apiClient.users[":id"].avatar.$delete({
      param: { id: props.user.id },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message ?? messages().removeAvatarFailed);
    }
    refreshCurrentPath();
  };

  const resetPasswordMutation = mutations.create<{ message: string; password: string }, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"]["password-reset"].$post({
        param: { id: props.user.id },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().resetPasswordFailed);
      }
      await notice("user.password_reset");
      return await res.json();
    },
    onSuccess: (data) =>
      openCredentialDialog({
        title: messages().temporaryPasswordCreated,
        icon: "ti ti-lock-open",
        intro: (
          <>
            <p>{messages().temporaryPasswordIntro}</p>
            <p>{messages().temporaryPasswordNextLogin}</p>
          </>
        ),
        fields: [{ label: messages().temporaryPassword, value: data.password }],
        doneLabel: messages().done,
      }),
    onError: (err) => prompts.error(err.message),
  });

  const deleteUser = createDeleteUserAction({ user: props.user, onDeleted: () => navigateTo(props.listHref) });

  const setExpiryMutation = mutations.create<{ message: string }, string | null>({
    mutation: async (expiryDate) => {
      const res = await apiClient.users[":id"].expiry.$put({
        param: { id: props.user.id },
        json: { expiryDate },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().setExpiryFailed);
      }
      await notice("user.expiry");
      return data;
    },
    onSuccess: () => {
      toast.success(messages().updated);
      refreshCurrentPath();
    },
    onError: (err) => prompts.error(err.message),
  });

  const setProfileMutation = mutations.create<{ message: string }, "user" | "guest">({
    mutation: async (profile) => {
      const res = await apiClient.users[":id"].profile.$put({
        param: { id: props.user.id },
        json: { profile },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().updateProfileFailed);
      }
      await notice("user.profile", {
        profile,
        category: props.user.provider === "ipa" ? "freeipa" : profile === "guest" ? "guest" : "login",
      });
      return data;
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const setAdminMutation = mutations.create<{ message: string }, boolean>({
    mutation: async (admin) => {
      const res = await apiClient.users[":id"].admin.$put({
        param: { id: props.user.id },
        json: { admin },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().updateAdminFailed);
      }
      await notice("user.admin");
      return data;
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const createIpaMutation = mutations.create<{ message: string }, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"].provider.$put({
        param: { id: props.user.id },
        json: { provider: "ipa" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().createIpaFailed);
      }
      await notice("user.provider", { provider: "ipa", category: "freeipa" });
      return data;
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const makeLocalMutation = mutations.create<{ message: string }, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"].provider.$put({
        param: { id: props.user.id },
        json: { provider: "local" },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().makeLocalFailed);
      }
      await notice("user.provider", { provider: "local", category: props.user.profile === "guest" ? "guest" : "login" });
      return data;
    },
    onSuccess: () => refreshCurrentPath(),
    onError: (err) => prompts.error(err.message),
  });

  const createLoginTokenMutation = mutations.create<{ token: string; magicLink: string; expiresInSeconds: number }, void>({
    mutation: async () => {
      const res = await apiClient.users[":id"]["login-token"].$post({
        param: { id: props.user.id },
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? messages().createLoginTokenFailed);
      }
      await notice("user.login_token");
      return await res.json();
    },
    onSuccess: (data) =>
      openCredentialDialog({
        title: messages().loginTokenCreated,
        icon: "ti ti-key",
        intro: (
          <>
            <p>{messages().loginTokenIntro({ minutes: Math.ceil(data.expiresInSeconds / 60) })}</p>
            <p>{messages().loginTokenShare}</p>
          </>
        ),
        fields: [
          { label: messages().loginToken, value: data.token },
          { label: messages().directLoginLink, value: data.magicLink },
        ],
        doneLabel: messages().done,
      }),
    onError: (err) => prompts.error(err.message),
  });

  const notifyMutation = mutations.create<{ message: string }, { subject: string; content: string }>({
    mutation: async ({ subject, content }) => {
      const res = await apiClient.users[":id"].notifications.$post({
        param: { id: props.user.id },
        json: {
          subject,
          rawHtml: toSafeParagraphHtml(content),
        },
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message ?? messages().notifyFailed);
      }
      return data;
    },
    onSuccess: (data) => prompts.alert(data.message),
    onError: (err) => prompts.error(err.message),
  });

  const handleResetPassword = async () => {
    const confirmed = await prompts.confirm(messages().resetPasswordConfirm({ uid: props.user.uid }), {
      title: messages().resetPassword,
      icon: "ti ti-lock-open",
      confirmText: messages().reset,
      cancelText: messages().cancel,
      variant: "danger",
    });
    if (confirmed) {
      await resetPasswordMutation.mutate();
    }
  };

  const handleEdit = async () => {
    const result = await prompts.form({
      title: messages().editUser,
      icon: "ti ti-pencil",
      confirmText: messages().save,
      fields: {
        givenname: {
          type: "text" as const,
          label: messages().firstName,
          placeholder: messages().firstName,
          icon: "ti ti-user",
          required: true,
          default: props.user.givenname,
        },
        sn: {
          type: "text" as const,
          label: messages().lastName,
          placeholder: messages().lastName,
          icon: "ti ti-user",
          required: true,
          default: props.user.sn,
        },
        displayName: {
          type: "text" as const,
          label: messages().displayName,
          placeholder: messages().displayName,
          icon: "ti ti-id-badge-2",
          required: true,
          default: props.user.displayName,
        },
        ...(props.user.provider === "ipa"
          ? {
              mailInfo: {
                type: "info" as const,
                content: () => (
                  <NoticeCard tone="warning" icon={false}>
                    {messages().emailSyncWarning}
                  </NoticeCard>
                ),
              },
            }
          : {}),
        mail: {
          type: "text" as const,
          label: messages().email,
          placeholder: messages().email,
          icon: "ti ti-mail",
          default: props.user.mail ?? "",
        },
        ...(props.user.provider === "ipa"
          ? {
              phone: {
                type: "text" as const,
                label: messages().phone,
                placeholder: messages().phonePlaceholder,
                icon: "ti ti-phone",
                description: messages().visibleToAccounts,
                default: props.user.ipa?.phone ?? "",
              },
            }
          : {}),
      },
    });
    if (result) {
      await editMutation.mutate({
        givenname: result.givenname,
        sn: result.sn,
        displayName: result.displayName,
        mail: result.mail || undefined,
        ...(props.user.provider === "ipa" ? { ipa: { phone: result.phone || undefined } } : {}),
      });
    }
  };

  const handleChangeAvatar = async () => {
    await openAvatarUploadDialog({
      username: props.user.displayName || props.user.uid,
      userId: props.user.id,
      avatarHash: props.user.avatarHash,
      subtitle: messages().avatarSubtitle({ uid: props.user.uid }),
      visibilityText: messages().avatarVisibility,
      onSave: saveAvatar,
      onRemove: props.user.avatarHash ? removeAvatar : undefined,
    });
  };

  const handleSetExpiry = async () => {
    const currentExpiry = props.user.accountExpires ? new Date(props.user.accountExpires).toISOString().split("T")[0] : "";

    prompts.dialog<void>(
      (close) => {
        const [expiryDate, setExpiryDate] = createSignal(currentExpiry);

        const handleSubmit = async (date: string | null) => {
          try {
            await setExpiryMutation.mutate(date);
            close();
          } catch {
            // Error is shown by onError callback.
          }
        };

        return (
          <div class="flex flex-col gap-4">
            <DatePicker
              label={messages().expiryDate}
              description={messages().expiryDescription}
              value={() => expiryDate() || null}
              onValueChange={(value) => setExpiryDate(value ?? "")}
              clearable
            />

            <div class="flex justify-end gap-2">
              <Button
                size="sm"
                variant="secondary"
                onClick={async () => {
                  const confirmed = await prompts.confirm(messages().neverExpireDescription, {
                    title: messages().neverExpireQuestion,
                    icon: "ti ti-infinity",
                    confirmText: messages().neverExpire,
                    cancelText: messages().cancel,
                  });
                  if (confirmed) {
                    handleSubmit(null);
                  }
                }}
                disabled={setExpiryMutation.loading()}
              >
                {messages().neverExpire}
              </Button>
              <Button size="sm" onClick={() => handleSubmit(expiryDate() || null)} disabled={setExpiryMutation.loading() || !expiryDate()}>
                {setExpiryMutation.loading() ? messages().saving : messages().setExpiry}
              </Button>
            </div>
          </div>
        );
      },
      { title: messages().setAccountExpiry, icon: "ti ti-calendar" },
    );
  };

  const handleNotify = async () => {
    const result = await prompts.form({
      title: messages().notifyUser({ name: props.user.displayName || props.user.uid }),
      icon: "ti ti-send",
      confirmText: messages().send,
      fields: {
        subject: {
          type: "text" as const,
          label: messages().subject,
          placeholder: messages().notificationSubjectPlaceholder,
          icon: "ti ti-mail",
          required: true,
        },
        content: {
          type: "text" as const,
          label: messages().message,
          placeholder: messages().notificationMessagePlaceholder,
          multiline: true,
          required: true,
        },
      },
    });

    if (result) {
      await notifyMutation.mutate({
        subject: result.subject,
        content: result.content,
      });
    }
  };

  const handleSetProfile = async (profile: "user" | "guest") => {
    const confirmed = await prompts.confirm(profile === "guest" ? messages().guestProfileDescription : messages().fullProfileDescription, {
      title:
        profile === "guest" ? messages().setGuestQuestion({ uid: props.user.uid }) : messages().setFullQuestion({ uid: props.user.uid }),
      icon: profile === "guest" ? "ti ti-user-down" : "ti ti-user-up",
      confirmText: profile === "guest" ? messages().setGuestAccount : messages().setFullAccount,
      cancelText: messages().cancel,
    });
    if (confirmed) {
      await setProfileMutation.mutate(profile);
    }
  };

  const handleSetAdmin = async (admin: boolean) => {
    const confirmed = await prompts.confirm(
      admin ? messages().grantLocalAdminConfirm({ uid: props.user.uid }) : messages().revokeLocalAdminConfirm({ uid: props.user.uid }),
      {
        title: admin ? messages().grantLocalAdmin : messages().revokeLocalAdmin,
        icon: admin ? "ti ti-shield-check" : "ti ti-shield-x",
        confirmText: admin ? messages().grantAdmin : messages().revokeAdmin,
        cancelText: messages().cancel,
      },
    );
    if (confirmed) {
      await setAdminMutation.mutate(admin);
    }
  };

  const handleCreateIpa = async () => {
    const confirmed = await confirmProviderSwitch({
      title: messages().switchToIpaQuestion({ uid: props.user.uid }),
      icon: "ti ti-brand-open-source",
      confirmText: messages().createFreeIpaAccount,
      cancelText: messages().cancel,
      description: messages().switchToIpaDescription,
      details: [messages().keepsUidEmail, messages().keepsDatabaseIdentity, messages().localGroupsStayLocal, messages().ipaGroupsDerived],
    });
    if (confirmed) {
      await createIpaMutation.mutate();
    }
  };

  const handleMakeLocal = async () => {
    const confirmed = await confirmProviderSwitch({
      title: messages().switchToLocalQuestion({ uid: props.user.uid }),
      icon: "ti ti-home-move",
      confirmText: messages().makeLocal,
      cancelText: messages().cancel,
      description: messages().switchToLocalDescription,
      details: [
        messages().keepsDatabaseIdentity,
        messages().localGroupsUntouched,
        messages().ipaRelationsRemoved,
        messages().profilePreserved,
      ],
    });
    if (confirmed) {
      await makeLocalMutation.mutate();
    }
  };

  const handleCreateLoginToken = async () => {
    const confirmed = await prompts.confirm(messages().createLoginTokenConfirm({ identity: props.user.mail ?? props.user.uid }), {
      title: messages().createLoginToken,
      icon: "ti ti-key",
      confirmText: messages().createToken,
      cancelText: messages().cancel,
    });

    if (confirmed) {
      await createLoginTokenMutation.mutate();
    }
  };

  const isIpaUser = props.user.provider === "ipa";
  const isLocalUser = props.user.provider === "local";
  const canMutateUser = !isIpaUser || props.freeIpaEnabled;
  const isGuestProfile = props.user.profile === "guest";
  const isLocalAdmin = isLocalUser && props.user.roles.includes("admin");
  const canCreateIpa = props.freeIpaEnabled && isLocalUser && Boolean(props.user.mail);
  const canCreateLoginToken = isLocalUser && Boolean(props.user.mail);
  const canSetExpiry = canMutateUser;
  const auditByUserHref = `/app/accounts/audit?actor=${encodeURIComponent(props.user.id)}`;
  const auditOnUserHref = `/app/accounts/audit?target=${encodeURIComponent(props.user.id)}`;

  return {
    auditByUserHref,
    auditOnUserHref,
    canCreateIpa,
    canCreateLoginToken,
    canMutateUser,
    canSetExpiry,
    handleCreateIpa,
    handleCreateLoginToken,
    handleChangeAvatar,
    handleDestroy: deleteUser.run,
    handleEdit,
    handleMakeLocal,
    handleNotify,
    handleResetPassword,
    handleSetAdmin,
    handleSetExpiry,
    handleSetProfile,
    isGuestProfile,
    isIpaUser,
    isLocalAdmin,
    isLocalUser,
  };
}
