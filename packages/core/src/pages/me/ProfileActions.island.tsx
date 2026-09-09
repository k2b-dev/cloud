import { dates } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { Button, NoticeCard, prompts, TextInput, useLocale } from "@k2b/ui";
import { openAvatarUploadDialog } from "@k2b/cloud/account/ui";
import { apiClient } from "@k2b/cloud/clients/core";
import type { UserProfile, UserProvider } from "@k2b/cloud/contracts";
import { createSignal, For, Show } from "solid-js";
import { accountMessages } from "./messages";

type Props = {
  userId: string;
  provider: UserProvider;
  profile: UserProfile;
  uid: string;
  givenname: string;
  sn: string;
  displayName: string;
  avatarHash: string | null;
  ipa: {
    phone: string | null;
    address: {
      street: string | null;
      postalCode: string | null;
      city: string | null;
      state: string | null;
    };
    sshPublicKeys: string[];
    sshFingerprints: string[];
  } | null;
  appName?: string;
  freeIpaEnabled: boolean;
  actions?: ("avatar" | "profile" | "details" | "extend")[];
};

const SSH_KEY_PATTERN = /^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521))\s+[A-Za-z0-9+/=]+/;

export default function ProfileActions(props: Props) {
  const locale = useLocale();
  const t = () => accountMessages.resolve([locale()]).t;
  const isIpa = props.provider === "ipa" && props.freeIpaEnabled;
  const canMutateAccount = props.provider !== "ipa" || props.freeIpaEnabled;
  const holders = () => (props.appName ? t().holdersNamed({ appName: props.appName }) : t().holdersAll);

  const saveAvatar = async (dataUrl: string) => {
    const res = await apiClient.me.avatar.$put({ json: { dataUrl } });
    if (!res.ok) {
      throw new Error(t().failedToUpdateAvatar);
    }
    window.location.reload();
  };

  const removeAvatar = async () => {
    const res = await apiClient.me.avatar.$delete();
    if (!res.ok) {
      throw new Error(t().failedToRemoveAvatar);
    }
    window.location.reload();
  };

  const handleChangeAvatar = async () => {
    await openAvatarUploadDialog({
      username: props.displayName || props.uid,
      userId: props.userId,
      avatarHash: props.avatarHash,
      title: t().changeAvatar,
      visibilityText: t().avatarVisibility,
      saveLabel: t().save,
      subtitle: t().avatarSubtitle,
      messages: {
        processFailed: t().avatarProcessFailed,
        typeInvalid: t().avatarTypeInvalid,
        tooLarge: t().avatarTooLarge,
        empty: t().avatarEmpty,
        unsupported: t().avatarUnsupported,
        compressionFailed: t().avatarCompressionFailed,
        saveFailed: t().avatarSaveFailed,
        removeFailed: t().avatarRemoveFailed,
        replaceDrop: t().avatarReplaceDrop,
        chooseDrop: t().avatarChooseDrop,
        cropHint: t().avatarCropHint,
        removing: t().avatarRemoving,
        remove: t().removeAvatar,
        removeAria: t().removeAvatar,
        cancel: t().cancel,
        saving: t().avatarSaving,
      },
      onSave: saveAvatar,
      onRemove: props.avatarHash ? removeAvatar : undefined,
    });
  };

  // ── Edit Profile (name fields) ──

  const editMutation = mutations.create<void, { givenname: string; sn: string; displayName: string }>({
    mutation: async (vars) => {
      const res = await apiClient.me.$patch({ json: vars });
      if (!res.ok) {
        throw new Error(t().failedToUpdateProfile);
      }
    },
    onSuccess: () => window.location.reload(),
    onError: (err) => prompts.error(err.message),
  });

  const handleEditProfile = async () => {
    const result = await prompts.form({
      title: t().editProfile,
      icon: "ti ti-pencil",
      confirmText: t().save,
      fields: {
        notice: {
          type: "info" as const,
          content: () => (
            <NoticeCard tone="warning" icon={false}>
              {t().realNameNotice}
            </NoticeCard>
          ),
        },
        visibility: {
          type: "info" as const,
          content: () => <p class="text-xs text-dimmed">{t().identityVisibility({ holders: holders() })}</p>,
        },
        givenname: {
          type: "text" as const,
          label: t().firstName,
          placeholder: t().firstNamePlaceholder,
          icon: "ti ti-user",
          required: true,
          default: props.givenname,
        },
        sn: {
          type: "text" as const,
          label: t().lastName,
          placeholder: t().lastNamePlaceholder,
          icon: "ti ti-user",
          required: true,
          default: props.sn,
        },
        displayName: {
          type: "text" as const,
          label: t().displayName,
          placeholder: t().displayNamePlaceholder,
          icon: "ti ti-id-badge-2",
          required: true,
          default: props.displayName,
        },
      },
    });
    if (result) {
      await editMutation.mutate({
        givenname: result.givenname,
        sn: result.sn,
        displayName: result.displayName,
      });
    }
  };

  // ── Contact & Details (phone + address + SSH keys in one dialog) ──

  const detailsMutation = mutations.create<
    void,
    {
      ipa?: { phone?: string; address?: { street?: string; postalCode?: string; city?: string; state?: string }; sshPublicKeys?: string[] };
    }
  >({
    mutation: async (vars) => {
      const res = await apiClient.me.$patch({ json: vars });
      if (!res.ok) {
        throw new Error(t().failedToUpdateDetails);
      }
    },
    onSuccess: () => window.location.reload(),
    onError: (err) => prompts.error(err.message),
  });

  const handleEditDetails = async () => {
    const result = await prompts.dialog<
      { phone: string; street: string; postalCode: string; city: string; state: string; sshKeys: string[] } | undefined
    >(
      (close) => {
        const [phone, setPhone] = createSignal(props.ipa?.phone ?? "");
        const [street, setStreet] = createSignal(props.ipa?.address.street ?? "");
        const [postalCode, setPostalCode] = createSignal(props.ipa?.address.postalCode ?? "");
        const [city, setCity] = createSignal(props.ipa?.address.city ?? "");
        const [state, setState] = createSignal(props.ipa?.address.state ?? "");
        const [keys, setKeys] = createSignal<string[]>([...(props.ipa?.sshPublicKeys ?? [])]);
        const [newKey, setNewKey] = createSignal("");
        const [keyError, setKeyError] = createSignal<string | null>(null);

        const addKey = () => {
          const key = newKey().trim();
          if (!key) return;
          if (!SSH_KEY_PATTERN.test(key)) {
            setKeyError(t().invalidSshKey);
            return;
          }
          if (keys().includes(key)) {
            setKeyError(t().duplicateSshKey);
            return;
          }
          setKeys([...keys(), key]);
          setNewKey("");
          setKeyError(null);
        };

        const keyLabel = (key: string): { type: string; comment: string; suffix: string } => {
          const parts = key.split(/\s+/);
          const type = parts[0] ?? "ssh";
          const blob = parts[1] ?? "";
          const suffix = blob.length > 8 ? `...${blob.slice(-8)}` : blob;
          const comment = parts.slice(2).join(" ") || "";
          return { type, comment, suffix };
        };

        return (
          <div class="flex flex-col gap-5">
            <p class="text-xs text-dimmed">{t().detailVisibility({ holders: holders() })}</p>

            <div class="flex flex-col gap-3">
              <span class="text-[11px] uppercase tracking-[0.14em] text-dimmed">{t().contact}</span>
              <TextInput label={t().phone} placeholder={t().phonePlaceholder} icon="ti ti-phone" value={phone} onValueChange={setPhone} />
            </div>

            <Show when={isIpa}>
              <div class="flex flex-col gap-3">
                <span class="text-[11px] uppercase tracking-[0.14em] text-dimmed">{t().address}</span>
                <div class="grid gap-3 sm:grid-cols-2">
                  <div class="sm:col-span-2">
                    <TextInput
                      label={t().street}
                      placeholder={t().streetPlaceholder}
                      icon="ti ti-road"
                      value={street}
                      onValueChange={setStreet}
                    />
                  </div>
                  <TextInput
                    label={t().postalCode}
                    placeholder={t().postalCodePlaceholder}
                    icon="ti ti-hash"
                    value={postalCode}
                    onValueChange={setPostalCode}
                  />
                  <TextInput
                    label={t().city}
                    placeholder={t().cityPlaceholder}
                    icon="ti ti-building-community"
                    value={city}
                    onValueChange={setCity}
                  />
                  <div class="sm:col-span-2">
                    <TextInput
                      label={t().state}
                      placeholder={t().statePlaceholder}
                      icon="ti ti-map"
                      value={state}
                      onValueChange={setState}
                    />
                  </div>
                </div>
              </div>

              <div class="flex flex-col gap-3">
                <span class="text-[11px] uppercase tracking-[0.14em] text-dimmed">{t().sshKeys}</span>
                <NoticeCard tone="info" icon={false} bodyClass="flex flex-col gap-1">
                  <p>
                    {t().connectVia} <code class="bg-zinc-200 dark:bg-zinc-700 px-1 rounded text-[11px]">ssh {props.uid}@host-ip</code>
                  </p>
                  <p>
                    {t().generateSshKey} <code class="bg-zinc-200 dark:bg-zinc-700 px-1 rounded text-[11px]">ssh-keygen -t ed25519</code>
                  </p>
                  <p>
                    {t().pasteSshKey} <code class="bg-zinc-200 dark:bg-zinc-700 px-1 rounded text-[11px]">~/.ssh/id_ed25519.pub</code>
                  </p>
                </NoticeCard>
                <Show when={keys().length > 0}>
                  <div class="flex flex-col gap-1.5">
                    <For each={keys()}>
                      {(key, i) => {
                        const info = keyLabel(key);
                        return (
                          <div class="flex items-center gap-2 bg-zinc-100 dark:bg-zinc-800 px-2.5 py-2 rounded">
                            <div class="flex-1 min-w-0">
                              <span class="text-xs font-medium text-primary block truncate">{info.comment || info.type}</span>
                              <span class="text-[10px] font-mono text-dimmed block truncate">
                                {info.type} {info.suffix}
                              </span>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => setKeys(keys().filter((_, idx) => idx !== i()))}
                              class="shrink-0 text-red-500 hover:text-red-700 dark:hover:text-red-400"
                              title={t().removeKey}
                              aria-label={t().removeNamedSshKey({ name: info.comment || info.type })}
                            >
                              <i class="ti ti-trash text-sm" />
                            </Button>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>
                <div class="flex flex-col gap-2">
                  <TextInput
                    placeholder="ssh-ed25519 AAAA... your-comment"
                    icon="ti ti-key"
                    value={newKey}
                    onValueChange={(v) => {
                      setNewKey(v);
                      setKeyError(null);
                    }}
                    multiline
                  />
                  <Show when={keyError()}>
                    <p class="text-xs text-red-500">{keyError()}</p>
                  </Show>
                  <Button type="button" variant="secondary" size="sm" onClick={addKey} class="self-end">
                    <i class="ti ti-plus text-sm" />
                    {t().addKey}
                  </Button>
                </div>
              </div>
            </Show>

            <div class="flex justify-end gap-3 pt-1">
              <Button type="button" variant="secondary" size="sm" onClick={() => close(undefined)}>
                {t().cancel}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() =>
                  close({ phone: phone(), street: street(), postalCode: postalCode(), city: city(), state: state(), sshKeys: keys() })
                }
              >
                {t().save}
              </Button>
            </div>
          </div>
        );
      },
      { title: t().contactAndDetails, icon: "ti ti-address-book", size: "large" },
    );

    if (!result) return;

    const contactChanged =
      (result.phone || "") !== (props.ipa?.phone ?? "") ||
      (result.street || "") !== (props.ipa?.address.street ?? "") ||
      (result.postalCode || "") !== (props.ipa?.address.postalCode ?? "") ||
      (result.city || "") !== (props.ipa?.address.city ?? "") ||
      (result.state || "") !== (props.ipa?.address.state ?? "");

    const sshChanged =
      result.sshKeys.length !== (props.ipa?.sshPublicKeys.length ?? 0) ||
      result.sshKeys.some((k, i) => k !== (props.ipa?.sshPublicKeys[i] ?? undefined));

    if (contactChanged || sshChanged) {
      await detailsMutation.mutate({
        ipa: {
          phone: result.phone || undefined,
          address: {
            street: result.street || undefined,
            postalCode: result.postalCode || undefined,
            city: result.city || undefined,
            state: result.state || undefined,
          },
          sshPublicKeys: result.sshKeys,
        },
      });
    }
  };

  // ── Extend Account ──

  const extendMutation = mutations.create<{ newExpiry?: string }, void>({
    mutation: async () => {
      const res = await apiClient.me["account-extension"].$post();
      if (!res.ok) {
        throw new Error(t().failedToExtendAccount);
      }
      const result = await res.json();
      await prompts.alert(
        result.newExpiry
          ? t().accountExtendedUntil({ date: dates.formatDate(result.newExpiry, { locale: locale() }) })
          : t().accountExtensionNotApplied,
      );
      return result;
    },
    onSuccess: () => window.location.reload(),
    onError: (err) => prompts.error(err.message),
  });

  const enabledActions = new Set(props.actions ?? ["avatar", "profile", "details", "extend"]);
  const actions = [
    {
      id: "avatar" as const,
      icon: "ti ti-camera",
      label: t().changeAvatar,
      action: () => void handleChangeAvatar(),
    },
    ...(canMutateAccount
      ? [{ id: "profile" as const, icon: "ti ti-pencil", label: t().editProfile, action: () => void handleEditProfile() }]
      : []),
    ...(isIpa
      ? [{ id: "details" as const, icon: "ti ti-address-book", label: t().contactAndSshDetails, action: () => void handleEditDetails() }]
      : []),
    ...(canMutateAccount
      ? [
          {
            id: "extend" as const,
            icon: "ti ti-calendar-plus",
            label: extendMutation.loading() ? t().extending : t().extendAccount,
            action: () => void extendMutation.mutate(),
          },
        ]
      : []),
  ].filter((action) => enabledActions.has(action.id));

  return (
    <Show when={actions.length > 0}>
      <div class="flex flex-wrap items-center gap-2">
        <For each={actions}>
          {(action) => (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={action.id === "extend" && extendMutation.loading()}
              onClick={action.action}
            >
              <i class={action.icon} />
              {action.label}
            </Button>
          )}
        </For>
      </div>
    </Show>
  );
}
