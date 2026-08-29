import { navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, Checkbox, CopyButton, NoticeCard, prompts, SegmentedControl, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createSignal, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { type CreateUserResponse, CreateUserResponseSchema, ErrorResponseSchema } from "@/contracts";
import { type accountsMessages, useAccountsMessages } from "../../messages";

type PrefillData = {
  requestId: string;
  email: string;
  givenname: string;
  sn: string;
  displayName?: string;
  firstName: string;
};

type ProviderChoice = "ipa" | "local";
type LocalProfile = "user" | "guest";

type CreateUserPayload =
  | {
      provider: "ipa";
      email: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification: boolean;
      requestId?: string;
    }
  | {
      provider: "local";
      profile: LocalProfile;
      admin?: boolean;
      email: string;
      givenname: string;
      sn: string;
      displayName?: string;
      autoSendNotification: boolean;
      requestId?: string;
    };

type CreateFlowResult = {
  payload: CreateUserPayload;
  data: CreateUserResponse;
};

type Props = {
  prefill?: PrefillData;
  buttonLabel?: string;
  buttonIcon?: string;
  buttonClass?: string;
  autoOpen?: boolean;
  hideButton?: boolean;
  freeIpaEnabled?: boolean;
};

type AccountsCopy = ReturnType<typeof accountsMessages.resolve>["t"];

const providerCards = (
  t: AccountsCopy,
): Array<{
  value: ProviderChoice;
  title: string;
  eyebrow: string;
  description: string;
  icon: string;
}> => [
  {
    value: "ipa",
    title: t.managedByFreeIpa,
    eyebrow: t.directory,
    description: t.freeIpaProviderDescription,
    icon: "ti ti-building-fortress",
  },
  {
    value: "local",
    title: t.managedLocally,
    eyebrow: t.appManaged,
    description: t.localProviderDescription,
    icon: "ti ti-home-spark",
  },
];

const PROVIDER_CARD_CLASS =
  "group flex min-h-40 flex-col items-start gap-3 rounded-xl bg-zinc-50/85 px-4 py-4 text-left transition hover:bg-blue-50/45 dark:bg-zinc-900/70 dark:hover:bg-blue-950/20";
const PROVIDER_CARD_ICON_CLASS =
  "flex h-10 w-10 items-center justify-center rounded-lg bg-white text-zinc-600 shadow-sm shadow-zinc-950/[0.04] transition group-hover:text-blue-600 dark:bg-zinc-950/75 dark:text-zinc-300 dark:shadow-none dark:group-hover:text-blue-300";

const profileOptions = (t: AccountsCopy) =>
  [
    { value: "user", label: t.fullAccount, icon: "ti ti-user-check" },
    { value: "guest", label: t.guestAccount, icon: "ti ti-user-exclamation" },
  ] as const;

const buildPayloadSummary = (payload: CreateUserPayload, t: AccountsCopy) => {
  const lines: Array<[string, string]> = [[t.managedBy, payload.provider === "ipa" ? "FreeIPA" : t.local]];

  if (payload.provider === "local") {
    lines.push([t.accessLevel, payload.profile === "user" ? t.fullAccount : t.guestAccount]);
    if (payload.profile === "user") {
      lines.push([t.privileges, payload.admin ? t.admin : t.standard]);
    }
  } else {
    lines.push([t.accessLevel, t.derivedFromIpaGroups]);
  }

  lines.push([t.email, payload.email]);
  lines.push([t.name, `${payload.givenname} ${payload.sn}`]);
  lines.push([t.displayName, payload.displayName || `${payload.givenname} ${payload.sn}`]);
  lines.push([t.onboarding, payload.provider === "ipa" ? t.ipaOnboarding : t.localOnboarding]);

  return lines;
};

function ProviderSelectionDialog(props: { close: (provider?: ProviderChoice) => void; requestPrefill: boolean }) {
  const messages = useAccountsMessages();
  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1">
        <p class="text-sm font-medium text-primary">{messages().chooseProviderQuestion}</p>
        <p class="text-xs text-dimmed">{messages().chooseProviderDescription}</p>
      </div>

      <div class="grid gap-3 md:grid-cols-2">
        {providerCards(messages()).map((provider) => (
          <button type="button" class={PROVIDER_CARD_CLASS} onClick={() => props.close(provider.value)}>
            <div class="flex items-center gap-3">
              <div class={PROVIDER_CARD_ICON_CLASS}>
                <i class={`${provider.icon} text-lg`} />
              </div>
              <div class="flex flex-col gap-0.5">
                <span class="text-[11px] font-semibold uppercase tracking-[0.18em] text-dimmed">{provider.eyebrow}</span>
                <span class="text-sm font-semibold text-primary">{provider.title}</span>
              </div>
            </div>
            <p class="text-sm leading-6 text-secondary">{provider.description}</p>
            <Show when={props.requestPrefill && provider.value === "ipa"}>
              <NoticeCard tone="success" icon={false} class="mt-auto">
                {messages().recommendedForRequest}
              </NoticeCard>
            </Show>
          </button>
        ))}
      </div>
    </div>
  );
}

function CreateUserDialog(props: { provider: ProviderChoice; prefill?: PrefillData; close: (payload?: CreateUserPayload) => void }) {
  const messages = useAccountsMessages();
  const [profile, setProfile] = createSignal<LocalProfile>("user");
  const [admin, setAdmin] = createSignal(false);
  const [email, setEmail] = createSignal(props.prefill?.email ?? "");
  const [givenname, setGivenname] = createSignal(props.prefill?.givenname ?? "");
  const [sn, setSn] = createSignal(props.prefill?.sn ?? "");
  const [displayName, setDisplayName] = createSignal(props.prefill?.displayName ?? "");
  const [autoSendNotification, setAutoSendNotification] = createSignal(true);
  const [displayNameTouched, setDisplayNameTouched] = createSignal(!!props.prefill?.displayName);
  const [errors, setErrors] = createSignal<Record<string, string>>({});

  createEffect(() => {
    if (!displayNameTouched()) {
      setDisplayName([givenname(), sn()].filter(Boolean).join(" "));
    }
  });

  createEffect(() => {
    if (props.provider !== "local" || profile() !== "user") {
      setAdmin(false);
    }
  });

  const validate = () => {
    const nextErrors: Record<string, string> = {};
    if (!email().trim()) nextErrors.email = messages().emailRequired;
    if (!givenname().trim()) nextErrors.givenname = messages().firstNameRequired;
    if (!sn().trim()) nextErrors.sn = messages().lastNameRequired;
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = () => {
    if (!validate()) return;

    if (props.provider === "ipa") {
      props.close({
        provider: "ipa",
        email: email().trim(),
        givenname: givenname().trim(),
        sn: sn().trim(),
        displayName: displayName().trim() || undefined,
        autoSendNotification: autoSendNotification(),
        requestId: props.prefill?.requestId,
      });
      return;
    }

    props.close({
      provider: "local",
      profile: profile(),
      admin: profile() === "user" ? admin() : false,
      email: email().trim(),
      givenname: givenname().trim(),
      sn: sn().trim(),
      displayName: displayName().trim() || undefined,
      autoSendNotification: autoSendNotification(),
      requestId: props.prefill?.requestId,
    });
  };

  return (
    <div class="flex flex-col gap-5">
      <div class="flex flex-col gap-1">
        <p class="text-sm font-medium text-primary">
          {props.provider === "ipa" ? messages().createFreeIpa : messages().createLocalAccount}
        </p>
        <p class="text-xs text-dimmed">{props.provider === "ipa" ? messages().ipaAccessAfterCreation : messages().localAccessCreation}</p>
      </div>

      <Show when={props.prefill}>
        <NoticeCard tone="success" icon={false}>
          <div class="flex items-center gap-2">
            <i class="ti ti-sparkles text-base" />
            <span class="font-medium">{messages().prefilledRequest}</span>
          </div>
        </NoticeCard>
      </Show>

      <Show when={props.provider === "ipa"}>
        <NoticeCard tone="info" icon={false}>
          <div class="flex items-start gap-3">
            <i class="ti ti-info-circle mt-0.5 text-base" />
            <div class="flex flex-col gap-1">
              <span class="font-medium">{messages().ipaDecidesAccess}</span>
              <span class="text-xs text-blue-700/90 dark:text-blue-200/80">{messages().ipaAccessExplanation}</span>
            </div>
          </div>
        </NoticeCard>
      </Show>

      <Show when={props.provider === "local"}>
        <div class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <p class="text-xs font-semibold uppercase tracking-[0.16em] text-dimmed">{messages().accessLevel}</p>
            <span class="text-[11px] text-dimmed">{messages().localAccessOnly}</span>
          </div>
          <SegmentedControl
            ariaLabel={messages().localAccountProfile}
            options={profileOptions(messages()).map((option) => ({ value: option.value, label: option.label, icon: option.icon }))}
            value={profile}
            onValueChange={(value) => setProfile(value as LocalProfile)}
          />
        </div>
      </Show>

      <Show when={props.provider === "local" && profile() === "user"}>
        <div class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)] px-4 py-3">
          <Checkbox
            label={messages().grantAdminAccess}
            description={messages().adminAccessDescription}
            value={admin}
            onValueChange={setAdmin}
          />
        </div>
      </Show>

      <div class="grid gap-4 md:grid-cols-2">
        <TextInput
          label={messages().email}
          required
          icon="ti ti-mail"
          value={email}
          onValueChange={setEmail}
          error={() => errors().email}
          placeholder="name@example.com"
        />
        <TextInput
          label={messages().displayName}
          icon="ti ti-id-badge-2"
          value={displayName}
          onValueChange={(value) => {
            setDisplayNameTouched(true);
            setDisplayName(value);
          }}
          placeholder={messages().visibleNamePlaceholder}
        />
        <TextInput
          label={messages().firstName}
          required
          icon="ti ti-user"
          value={givenname}
          onValueChange={setGivenname}
          error={() => errors().givenname}
          placeholder={messages().firstName}
        />
        <TextInput
          label={messages().lastName}
          required
          icon="ti ti-user"
          value={sn}
          onValueChange={setSn}
          error={() => errors().sn}
          placeholder={messages().lastName}
        />
      </div>

      <div class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)] px-4 py-3 text-xs text-dimmed">
        {messages().generatedIdentity}
      </div>

      <div class="rounded-[var(--ui-radius-surface)] bg-[var(--ui-surface-muted)] px-4 py-3">
        <Checkbox
          label={messages().sendWelcomeAutomatically}
          description={props.provider === "ipa" ? messages().ipaWelcomeDescription : messages().localWelcomeDescription}
          value={autoSendNotification}
          onValueChange={setAutoSendNotification}
        />
      </div>

      <div class="flex justify-end">
        <Button size="sm" onClick={handleSubmit}>
          {messages().continue}
        </Button>
      </div>
    </div>
  );
}

const buildSuccessDialog = (payload: CreateUserPayload, data: CreateUserResponse, t: AccountsCopy, locale: string) => {
  const nfsCommands = `sudo nfsctl useradd ${data.uid}`;
  const isIpa = payload.provider === "ipa";
  const notificationMessage = data.notificationSent ? (isIpa ? t.ipaWelcomeSent : t.localWelcomeSent) : t.welcomeNotSent;

  return prompts.dialog<void>(
    (close) => (
      <div class="flex flex-col gap-4">
        <NoticeCard tone="success" icon={false}>
          <div class="flex items-start gap-3">
            <i class="ti ti-check text-base" />
            <div class="flex flex-col gap-1">
              <span class="font-medium">{payload.provider === "ipa" ? t.ipaAccountCreated : t.localAccountCreated}</span>
              <span class="text-xs">{notificationMessage}</span>
            </div>
          </div>
        </NoticeCard>

        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt class="text-dimmed">UID</dt>
          <dd class="font-mono">{data.uid}</dd>
          <dt class="text-dimmed">{t.managedBy}</dt>
          <dd>{payload.provider === "ipa" ? "FreeIPA" : t.local}</dd>
          <Show when={payload.provider === "local"}>
            {(() => {
              const localPayload = payload.provider === "local" ? payload : null;
              return (
                <>
                  <dt class="text-dimmed">{t.accessLevel}</dt>
                  <dd>{localPayload?.profile === "user" ? t.fullAccount : t.guestAccount}</dd>
                </>
              );
            })()}
          </Show>
          <Show when={data.accountExpires}>
            <dt class="text-dimmed">{t.accountExpires}</dt>
            <dd>{dates.formatDate(data.accountExpires!, { locale })}</dd>
          </Show>
        </dl>

        <Show when={isIpa}>
          <NoticeCard tone="info" icon={false} bodyClass="flex flex-col gap-3">
            <div class="flex items-center justify-between gap-3">
              <div class="flex flex-col">
                <span class="text-sm font-medium text-primary">{t.nfsFollowUp}</span>
                <span class="text-xs text-dimmed">{t.nfsFollowUpDescription}</span>
              </div>
              <CopyButton text={nfsCommands} label={t.copy} />
            </div>
            <pre class="overflow-x-auto whitespace-pre rounded-xl bg-white/80 px-3 py-3 text-xs font-mono text-secondary dark:bg-zinc-950/80">
              {nfsCommands}
            </pre>
          </NoticeCard>
        </Show>

        <div class="flex justify-end gap-3">
          <Button size="sm" variant="secondary" onClick={() => close()}>
            {t.close}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              close();
              navigateTo(`/app/accounts/users/${data.id}`);
            }}
          >
            {t.viewAccount}
          </Button>
        </div>
      </div>
    ),
    { title: t.accountCreated, icon: "ti ti-user-check", size: "large" },
  );
};

export default function CreateUserForm(props: Props) {
  const messages = useAccountsMessages();
  const locale = useLocale();
  let opened = false;
  const freeIpaEnabled = props.freeIpaEnabled ?? true;

  const openProviderDialog = async (): Promise<ProviderChoice | undefined> => {
    if (!freeIpaEnabled) return "local";
    if (props.prefill) return "ipa";
    return prompts.dialog<ProviderChoice>((close) => <ProviderSelectionDialog close={close} requestPrefill={false} />, {
      title: messages().chooseAccountProvider,
      icon: "ti ti-user-plus",
      size: "medium",
    });
  };

  const openCreateDialog = async (provider: ProviderChoice): Promise<CreateUserPayload | undefined> =>
    prompts.dialog<CreateUserPayload>((close) => <CreateUserDialog provider={provider} prefill={props.prefill} close={close} />, {
      title: provider === "ipa" ? messages().createFreeIpa : messages().createLocalAccount,
      icon: provider === "ipa" ? "ti ti-building-fortress" : "ti ti-home-spark",
      size: "large",
    });

  const createMutation = mutation.create<CreateFlowResult | undefined, void>({
    mutation: async () => {
      const provider = await openProviderDialog();
      if (!provider) return undefined;

      const payload = await openCreateDialog(provider);
      if (!payload) return undefined;

      const confirmed = await prompts.confirm(
        <div class="flex flex-col gap-4 text-sm">
          <p>{messages().confirmNewAccount}</p>
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
            {buildPayloadSummary(payload, messages()).map(([label, value]) => (
              <>
                <dt class="text-dimmed">{label}</dt>
                <dd class={label === messages().email ? "font-mono" : ""}>{value}</dd>
              </>
            ))}
          </dl>
          <Show when={payload.provider === "ipa"}>
            <NoticeCard tone="info" icon={false}>
              {messages().ipaAccessDependsOnGroups}
            </NoticeCard>
          </Show>
        </div>,
        {
          title: messages().confirmAccountCreation,
          icon: "ti ti-user-check",
          confirmText: messages().createAccount,
          size: "large",
        },
      );

      if (!confirmed) return undefined;

      const res = await apiClient.users.$post({ json: payload });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().createAccountFailed);
      }

      const data = CreateUserResponseSchema.parse(await res.json());
      return { payload, data };
    },
    onSuccess: async (result) => {
      if (!result) return;
      await buildSuccessDialog(result.payload, result.data, messages(), locale());
    },
    onError: (error) => prompts.error(error instanceof Error ? error.message : messages().createAccountFailed),
  });

  onMount(() => {
    if (!props.autoOpen || opened) return;
    opened = true;
    void createMutation.mutate(undefined);
  });

  return (
    <Show when={!props.hideButton}>
      <Button
        size="sm"
        variant="subtle"
        class={props.buttonClass}
        onClick={() => void createMutation.mutate(undefined)}
        disabled={createMutation.loading()}
      >
        <i class={createMutation.loading() ? "ti ti-loader-2 animate-spin" : (props.buttonIcon ?? "ti ti-plus")} />
        <span>{createMutation.loading() ? messages().working : (props.buttonLabel ?? messages().newUser)}</span>
      </Button>
    </Show>
  );
}
