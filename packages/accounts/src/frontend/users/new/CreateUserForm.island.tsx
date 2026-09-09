import { navigateTo, refreshCurrentPath } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  confirmDiscardIfDirty,
  DescriptionList,
  dialogCore,
  MarkdownView,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  prompts,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { type AccountCategory, type AccountCategoryPolicy, accountCategoryLabel } from "@k2b/cloud/contracts";
import { createEffect, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
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
  categoryPolicy: AccountCategoryPolicy;
  prefill?: PrefillData;
  buttonLabel?: string;
  buttonIcon?: string;
  buttonClass?: string;
  autoOpen?: boolean;
  hideButton?: boolean;
  freeIpaEnabled?: boolean;
};

type AccountsCopy = ReturnType<typeof accountsMessages.resolve>["t"];

export function CreateUserDialog(props: {
  freeIpaEnabled: boolean;
  categoryPolicy: AccountCategoryPolicy;
  prefill?: PrefillData;
  close: (result?: CreateFlowResult) => void;
}) {
  const messages = useAccountsMessages();
  const categories = (["freeipa", "login", "guest"] as const).filter(
    (category) =>
      props.categoryPolicy[category].enabled &&
      (category !== "freeipa" || props.freeIpaEnabled) &&
      (!props.prefill || category === "freeipa"),
  );
  const [category, setCategory] = createSignal<AccountCategory | undefined>();
  const provider = (): ProviderChoice => (category() === "freeipa" ? "ipa" : "local");
  const formId = createUniqueId();
  const [dirty, setDirty] = createSignal(false);
  const [closing, setClosing] = createSignal(false);
  const profile = (): LocalProfile => (category() === "guest" ? "guest" : "user");
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
    if (provider() !== "local" || profile() !== "user") {
      setAdmin(false);
    }
  });

  const createMutation = mutation.create<CreateFlowResult, CreateUserPayload>({
    mutation: async (payload, { abortSignal }) => {
      const res = await apiClient.users.$post({ json: payload }, { init: { signal: abortSignal } });
      if (!res.ok) {
        const data = ErrorResponseSchema.safeParse(await res.json());
        throw new Error(data.success ? data.data.message : messages().createAccountFailed);
      }
      return { payload, data: CreateUserResponseSchema.parse(await res.json()) };
    },
    onSuccess: (result) => props.close(result),
  });
  onCleanup(() => createMutation.abort());
  const requestClose = async () => {
    if (createMutation.loading() || closing()) return;
    setClosing(true);
    try {
      if (await confirmDiscardIfDirty(dirty)) props.close();
    } finally {
      setClosing(false);
    }
  };

  const validate = () => {
    const nextErrors: Record<string, string> = {};
    if (!category()) nextErrors.category = messages().chooseAccountType;
    if (!email().trim()) nextErrors.email = messages().emailRequired;
    if (!givenname().trim()) nextErrors.givenname = messages().firstNameRequired;
    if (!sn().trim()) nextErrors.sn = messages().lastNameRequired;
    setErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = () => {
    if (createMutation.loading() || !validate()) return;

    if (provider() === "ipa") {
      void createMutation.mutate({
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

    void createMutation.mutate({
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
    <PanelDialog>
      <PanelDialog.Header
        title={messages().createNewAccount}
        close={() => void requestClose()}
        closeDisabled={createMutation.loading() || closing()}
      />
      <PanelDialog.Body>
        <form
          id={formId}
          class="flex flex-col gap-5"
          onInput={() => setDirty(true)}
          onSubmit={(event) => {
            event.preventDefault();
            handleSubmit();
          }}
        >
          <Show when={props.prefill}>
            <NoticeCard tone="info">{messages().prefilledRequest}</NoticeCard>
          </Show>
          <Show when={categories.length === 0}>
            <NoticeCard tone="warning">{messages().noAllowedAccountTypes}</NoticeCard>
          </Show>
          <Show when={categories.length > 0}>
            <Select
              label={messages().accountType}
              value={() => category() ?? null}
              required
              placeholder={messages().chooseAccountType}
              error={() => errors().category}
              options={categories.map((value) => ({
                value,
                label: value === "freeipa" ? "FreeIPA" : value === "guest" ? "Guest" : props.categoryPolicy.login.label,
                description:
                  value === "freeipa"
                    ? messages().freeIpaTypeDescription
                    : value === "guest"
                      ? messages().guestTypeDescription
                      : messages().loginTypeDescription,
              }))}
              onValueChange={(value) => {
                if (value === "freeipa" || value === "guest" || value === "login") {
                  setCategory(value);
                  setErrors((previous) => ({ ...previous, category: "" }));
                  setDirty(true);
                }
              }}
              description={messages().accountTypeHelp}
              disabled={createMutation.loading()}
            />
          </Show>
          <div class="grid gap-4 sm:grid-cols-2">
            <TextInput
              label={messages().firstName}
              required
              maxLength={120}
              autocomplete="given-name"
              value={givenname}
              onValueChange={setGivenname}
              error={() => errors().givenname}
              disabled={createMutation.loading()}
            />
            <TextInput
              label={messages().lastName}
              required
              maxLength={120}
              autocomplete="family-name"
              value={sn}
              onValueChange={setSn}
              error={() => errors().sn}
              disabled={createMutation.loading()}
            />
          </div>
          <TextInput
            label={messages().email}
            type="email"
            autocomplete="email"
            required
            value={email}
            onValueChange={setEmail}
            error={() => errors().email}
            placeholder="name@example.com"
            disabled={createMutation.loading()}
          />
          <TextInput
            label={messages().displayName}
            description={messages().displayNameHelp}
            maxLength={160}
            value={displayName}
            onValueChange={(value) => {
              setDisplayNameTouched(true);
              setDisplayName(value);
            }}
            disabled={createMutation.loading()}
          />
          <Show when={category() === "login"}>
            <Show when={profile() === "user"}>
              <Checkbox
                label={messages().grantAdminAccess}
                description={messages().adminAccessDescription}
                value={admin}
                onValueChange={(value) => {
                  setAdmin(value);
                  setDirty(true);
                }}
                disabled={createMutation.loading()}
              />
            </Show>
          </Show>

          <Checkbox
            label={messages().sendWelcomeAutomatically}
            description={
              category() ? (provider() === "ipa" ? messages().ipaWelcomeDescription : messages().localWelcomeDescription) : undefined
            }
            value={autoSendNotification}
            onValueChange={(value) => {
              setAutoSendNotification(value);
              setDirty(true);
            }}
            disabled={createMutation.loading()}
          />
          <Show when={category()}>
            <NoticeCard tone="info" bodyClass="flex flex-col gap-2">
              <p class="font-medium">{messages().creationOutcome}</p>
              <Show
                when={provider() === "ipa"}
                fallback={
                  <>
                    <p>{messages().localLoginHelp({ loginLabel: props.categoryPolicy.login.label })}</p>
                    <p>{autoSendNotification() ? messages().localDeliveryHelp : messages().localNoDeliveryHelp}</p>
                  </>
                }
              >
                <p>{messages().ipaAccessAfterCreation}</p>
                <p>{messages().ipaPasswordHelp}</p>
                <p>{autoSendNotification() ? messages().ipaDeliveryHelp : messages().ipaNoDeliveryHelp}</p>
              </Show>
            </NoticeCard>
          </Show>
          <Show when={createMutation.error()}>
            {(error) => (
              <NoticeCard tone="danger" role="alert">
                {error().message}
              </NoticeCard>
            )}
          </Show>
        </form>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" onClick={() => void requestClose()} disabled={createMutation.loading() || closing()}>
          {messages().cancel}
        </Button>
        <Button type="submit" form={formId} disabled={!category()} loading={createMutation.loading()} loadingLabel={messages().working}>
          {messages().createAccount}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

const buildSuccessDialog = (payload: CreateUserPayload, data: CreateUserResponse, t: AccountsCopy, locale: string, loginLabel: string) => {
  const isIpa = payload.provider === "ipa";
  const notificationMessage = data.notificationSent ? (isIpa ? t.ipaWelcomeSent : t.localWelcomeSent) : t.welcomeNotSent;

  return prompts.dialog<"view">(
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

        <DescriptionList
          columns={2}
          items={[
            { term: "UID", description: data.uid },
            {
              term: t.accountType,
              description: accountCategoryLabel(
                { provider: payload.provider, profile: payload.provider === "local" ? payload.profile : "user" },
                loginLabel,
              ),
            },
            ...(data.accountExpires ? [{ term: t.accountExpires, description: dates.formatDate(data.accountExpires, { locale }) }] : []),
          ]}
        />

        <Show when={data.creationNotice?.markdown}>
          <NoticeCard tone="info" icon={false} bodyClass="flex flex-col gap-3">
            <MarkdownView markdown={data.creationNotice?.markdown ?? ""} />
          </NoticeCard>
        </Show>
        <Show when={data.creationNotice?.failed}>
          <NoticeCard tone="warning">{t.creationNoticeFailed}</NoticeCard>
        </Show>

        <div class="flex justify-end gap-3">
          <Button size="sm" variant="secondary" onClick={() => close()}>
            {t.close}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              close("view");
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

  const [opening, setOpening] = createSignal(false);
  const openCreate = async () => {
    if (opening()) return;
    setOpening(true);
    try {
      const result = await dialogCore.open<CreateFlowResult>(
        (close) => (
          <CreateUserDialog freeIpaEnabled={freeIpaEnabled} categoryPolicy={props.categoryPolicy} prefill={props.prefill} close={close} />
        ),
        {
          ...panelDialogOptions,
          cancelBehavior: "ignore",
          initialFocus: (dialog) => dialog.querySelector<HTMLElement>('[role="combobox"]') ?? dialog.querySelector("input"),
        },
      );
      if (result) {
        const action = await buildSuccessDialog(result.payload, result.data, messages(), locale(), props.categoryPolicy.login.label);
        if (action === "view") navigateTo(`/app/accounts/users/${result.data.id}`);
        else if (props.autoOpen) navigateTo("/app/accounts/users");
        else refreshCurrentPath();
      }
    } finally {
      setOpening(false);
    }
  };

  onMount(() => {
    if (!props.autoOpen || opened) return;
    opened = true;
    void openCreate();
  });

  return (
    <Show when={!props.hideButton}>
      <Button size="sm" variant="primary" class={props.buttonClass} onClick={() => void openCreate()} disabled={opening()}>
        <i class={opening() ? "ti ti-loader-2 animate-spin" : (props.buttonIcon ?? "ti ti-plus")} />
        <span>{opening() ? messages().working : (props.buttonLabel ?? messages().newUser)}</span>
      </Button>
    </Show>
  );
}
