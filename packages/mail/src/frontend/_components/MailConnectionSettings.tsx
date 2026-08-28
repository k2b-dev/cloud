import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  Dropdown,
  dialogCore,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  prompts,
  Select,
  StatusBadge,
  type StatusTone,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailOAuthProviderId, ProviderConnection, ProviderConnectionDetails, SenderIdentity } from "../../contracts";
import type { DiscoveredMailConfiguration } from "../../service/onboarding-discovery";
import { readApiError } from "./api-response";
import { connectionEditorDialogOptions, type ProviderSettingsProps } from "./mail-provider-settings-shared";
import { deriveDefaultSenderSetupState } from "./mail-provider-setup";
import { mailSettingsMessages } from "./mail-settings-messages";

const connectionStatusTone = (status: ProviderConnection["status"]): StatusTone => {
  if (status === "active") return "ok";
  if (status === "degraded") return "warning";
  return "error";
};

export function MailConnectionSettings(props: ProviderSettingsProps) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const connectionStateLabel = (state: ProviderConnection["status"] | "pending" | "verifying" | "expiring" | "reconnect_required") => {
    if (state === "active") return messages().statusActive;
    if (state === "degraded") return messages().statusDegraded;
    if (state === "revoked") return messages().statusRevoked;
    if (state === "pending") return messages().statusPending;
    if (state === "verifying") return messages().statusVerifying;
    if (state === "expiring") return messages().statusExpiring;
    return messages().statusReconnectRequired;
  };
  const [editing, setEditing] = createSignal(false);
  const [replacingConnectionId, setReplacingConnectionId] = createSignal<string | null>(null);
  const [name, setName] = createSignal(props.mailbox.name);
  const [email, setEmail] = createSignal(props.currentUserEmail ?? "");
  const [username, setUsername] = createSignal(props.currentUserEmail ?? "");
  const [imapHost, setImapHost] = createSignal("");
  const [imapPort, setImapPort] = createSignal(993);
  const [imapTls, setImapTls] = createSignal<"implicit" | "starttls">("implicit");
  const [smtpHost, setSmtpHost] = createSignal("");
  const [smtpPort, setSmtpPort] = createSignal(587);
  const [smtpTls, setSmtpTls] = createSignal<"implicit" | "starttls">("starttls");
  const [auth, setAuth] = createSignal<"password" | "oauth2">("password");
  const [secret, setSecret] = createSignal("");
  const [createSender, setCreateSender] = createSignal(true);
  const [savesSentAutomatically, setSavesSentAutomatically] = createSignal(false);
  const [discoverySource, setDiscoverySource] = createSignal<string | null>(null);
  const [oauthProviderId, setOAuthProviderId] = createSignal<MailOAuthProviderId | null>(null);
  const [editorBaseline, setEditorBaseline] = createSignal("");
  let closeConnectionDialog: (() => void) | null = null;
  const currentConnection = createMemo(() => props.admin.connections.find((connection) => connection.status !== "revoked"));
  const currentBinding = createMemo(() => {
    const connection = currentConnection();
    return connection
      ? props.admin.bindings.find((binding) => binding.connectionId === connection.id && binding.state !== "revoked")
      : undefined;
  });
  const senderSetupState = createMemo(() => deriveDefaultSenderSetupState(currentConnection(), currentBinding(), props.admin.identities));
  const senderSetupPrompt = createMemo(() => {
    const state = senderSetupState();
    return state.kind === "optional" || state.kind === "needs-verification" ? state : null;
  });
  const editorValue = () =>
    JSON.stringify({
      replacingConnectionId: replacingConnectionId(),
      name: name(),
      email: email(),
      username: username(),
      imapHost: imapHost(),
      imapPort: imapPort(),
      imapTls: imapTls(),
      smtpHost: smtpHost(),
      smtpPort: smtpPort(),
      smtpTls: smtpTls(),
      auth: auth(),
      secret: secret(),
      createSender: createSender(),
      savesSentAutomatically: savesSentAutomatically(),
    });
  const editorDirty = () => editing() && editorValue() !== editorBaseline();
  const captureEditorBaseline = () => setEditorBaseline(editorValue());
  const closeEditor = async () => {
    if (!(await confirmDiscardIfDirty(editorDirty))) return;
    closeConnectionDialog?.();
    closeConnectionDialog = null;
    setEditing(false);
  };

  const resetEditor = () => {
    setReplacingConnectionId(null);
    setName(props.mailbox.name);
    setEmail(props.currentUserEmail ?? "");
    setUsername(props.currentUserEmail ?? "");
    setImapHost("");
    setImapPort(993);
    setImapTls("implicit");
    setSmtpHost("");
    setSmtpPort(587);
    setSmtpTls("starttls");
    setAuth("password");
    setSecret("");
    setCreateSender(true);
    setSavesSentAutomatically(false);
    setDiscoverySource(null);
    setOAuthProviderId(null);
    captureEditorBaseline();
  };

  const prepareEdit = () => {
    const connection = currentConnection();
    if (!connection) return;
    setReplacingConnectionId(connection.id);
    setName(connection.name);
    setEmail(connection.email);
    setUsername(connection.username);
    setImapHost(connection.imap.host);
    setImapPort(connection.imap.port);
    setImapTls(connection.imap.tlsMode);
    setSmtpHost(connection.smtp.host);
    setSmtpPort(connection.smtp.port);
    setSmtpTls(connection.smtp.tlsMode);
    setAuth(connection.secret.kind);
    setSecret("");
    setCreateSender(false);
    setSavesSentAutomatically(false);
    setDiscoverySource(null);
    setOAuthProviderId(connection.oauth?.providerId ?? null);
    captureEditorBaseline();
  };

  const discover = mutation.create<DiscoveredMailConfiguration[], void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["provider-discovery"].$get(
        {
          param: { mailboxId: props.mailbox.id },
          query: { email: email().trim() },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedDiscoverProviderSettings));
      return response.json();
    },
    onSuccess: (candidates) => {
      const candidate = candidates[0];
      if (!candidate) {
        setDiscoverySource(null);
        return void toast(messages().noProviderConfiguration, {
          title: messages().noSettingsFound,
        });
      }
      setUsername(candidate.username);
      setImapHost(candidate.imap.host);
      setImapPort(candidate.imap.port);
      setImapTls(candidate.imap.tlsMode);
      setSmtpHost(candidate.smtp.host);
      setSmtpPort(candidate.smtp.port);
      setSmtpTls(candidate.smtp.tlsMode);
      setAuth(candidate.authentication.includes("password") ? "password" : "oauth2");
      setOAuthProviderId(candidate.oauthProviderId);
      setDiscoverySource(candidate.source.replaceAll("_", " "));
      toast.success(messages().providerSettingsFound);
    },
    onError: (error) => prompts.error(error.message),
  });

  const canSubmit = createMemo(
    () =>
      Boolean(name().trim() && email().trim() && username().trim() && imapHost().trim() && smtpHost().trim() && secret()) &&
      imapPort() >= 1 &&
      imapPort() <= 65_535 &&
      smtpPort() >= 1 &&
      smtpPort() <= 65_535,
  );

  const canStartOAuth = createMemo(
    () =>
      Boolean(name().trim() && email().trim() && username().trim() && imapHost().trim() && smtpHost().trim()) &&
      imapPort() >= 1 &&
      imapPort() <= 65_535 &&
      smtpPort() >= 1 &&
      smtpPort() <= 65_535,
  );

  const startOAuth = mutation.create<
    void,
    { providerId: MailOAuthProviderId; connectionId?: string; connection?: ProviderConnectionDetails }
  >({
    mutation: async ({ providerId, connectionId, connection }, { abortSignal }) => {
      const json = connectionId
        ? ({ operation: "reconnect", providerId, connectionId, ...(connection ? { connection } : {}) } as const)
        : ({
            operation: "create",
            providerId,
            createSender: createSender(),
            savesSentAutomatically: savesSentAutomatically(),
            connection: {
              name: name().trim(),
              email: email().trim(),
              username: username().trim(),
              imap: { host: imapHost().trim(), port: imapPort(), tlsMode: imapTls() },
              smtp: { host: smtpHost().trim(), port: smtpPort(), tlsMode: smtpTls() },
            },
          } as const);
      const response = await apiClient.mailboxes[":mailboxId"].oauth.start.$post(
        { param: { mailboxId: props.mailbox.id }, json },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedStartOAuth));
      const result = await response.json();
      if (abortSignal.aborted) return;
      window.location.assign(result.authorizationUrl);
    },
    onError: (error) => prompts.error(error.message),
  });

  const requestDefaultSenderSetup = async (bindingId: string, abortSignal?: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"]["sender-identities"].default.setup.$post(
      {
        param: { mailboxId: props.mailbox.id },
        json: { bindingId, savesSentAutomatically: savesSentAutomatically() },
      },
      { init: { signal: abortSignal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, messages().defaultIdentitySetupFailed));
    return response.json();
  };

  const attachConnection = async (
    connectionId: string,
    setupSenderAfterAttach: boolean,
    abortSignal?: AbortSignal,
  ): Promise<{ senderCreated: boolean; setupError: string | null }> => {
    const bindingResponse = await apiClient.mailboxes[":mailboxId"].bindings.$post(
      {
        param: { mailboxId: props.mailbox.id },
        json: { connectionId },
      },
      { init: { signal: abortSignal } },
    );
    if (!bindingResponse.ok) {
      const reason = await readApiError(bindingResponse, messages().folderDiscoveryFailed);
      return {
        senderCreated: false,
        setupError: messages().incomingSetupNeedsAttention({ reason }),
      };
    }
    const binding = await bindingResponse.json();
    if (!setupSenderAfterAttach) return { senderCreated: false, setupError: null };
    try {
      await requestDefaultSenderSetup(binding.id, abortSignal);
      return { senderCreated: true, setupError: null };
    } catch (error) {
      return {
        senderCreated: false,
        setupError: messages().sendingSetupNeedsAttention({
          reason: error instanceof Error ? error.message : messages().defaultIdentitySetupFailed,
        }),
      };
    }
  };

  const connect = mutation.create<{ senderCreated: boolean; setupError: string | null; replaced: boolean }, void>({
    mutation: async (_input, { abortSignal }) => {
      const input = {
        name: name().trim(),
        email: email().trim(),
        username: username().trim(),
        imap: { host: imapHost().trim(), port: imapPort(), tlsMode: imapTls() },
        smtp: { host: smtpHost().trim(), port: smtpPort(), tlsMode: smtpTls() },
        secret:
          auth() === "oauth2" ? { kind: "oauth2" as const, accessToken: secret() } : { kind: "password" as const, password: secret() },
      };
      const replacementId = replacingConnectionId();
      const connectionResponse = replacementId
        ? await apiClient.mailboxes[":mailboxId"].connections[":connectionId"].$put(
            {
              param: { mailboxId: props.mailbox.id, connectionId: replacementId },
              json: input,
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"].connections.$post(
            {
              param: { mailboxId: props.mailbox.id },
              json: input,
            },
            { init: { signal: abortSignal } },
          );
      if (!connectionResponse.ok) throw new Error(await readApiError(connectionResponse, messages().providerVerificationFailed));
      const created = await connectionResponse.json();
      if (replacementId) return { senderCreated: false, setupError: null, replaced: true };
      return { ...(await attachConnection(created.connection.id, createSender(), abortSignal)), replaced: false };
    },
    onSuccess: (result) => {
      if (!result.setupError) {
        toast.success(
          result.replaced
            ? messages().connectedAccountUpdated
            : result.senderCreated
              ? messages().providerAndIdentityConnected
              : messages().providerConnected,
        );
      }
      closeConnectionDialog?.();
      closeConnectionDialog = null;
      setEditing(false);
      setEditorBaseline("");
      setReplacingConnectionId(null);
      props.onWorkspaceChange();
      void props.onReload();
      if (result.setupError) void prompts.error(result.setupError);
    },
    onError: (error) => {
      void props.onReload();
      prompts.error(error.message);
    },
  });

  const revoke = mutation.create<boolean, string>({
    mutation: async (connectionId, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().removeProviderConnectionDescription, {
        title: messages().removeProviderConnection,
        confirmText: messages().removeConnection,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return false;
      const response = await apiClient.mailboxes[":mailboxId"].connections[":connectionId"].$delete(
        { param: { mailboxId: props.mailbox.id, connectionId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRemoveProviderConnection));
      return true;
    },
    onSuccess: async (revoked) => {
      if (!revoked) return;
      toast.success(messages().providerConnectionRemoved);
      props.onWorkspaceChange();
      await props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });

  const finishSetup = mutation.create<{ senderCreated: boolean; setupError: string | null }, string>({
    mutation: (connectionId, { abortSignal }) => attachConnection(connectionId, false, abortSignal),
    onSuccess: (result) => {
      if (!result.setupError) toast.success(result.senderCreated ? messages().providerAndIdentityConnected : messages().providerConnected);
      props.onWorkspaceChange();
      void props.onReload();
      if (result.setupError) void prompts.error(result.setupError);
    },
    onError: (error) => prompts.error(error.message),
  });

  const setupSender = mutation.create<SenderIdentity, string>({
    mutation: (bindingId, { abortSignal }) => requestDefaultSenderSetup(bindingId, abortSignal),
    onSuccess: (identity) => {
      toast.success(messages().readyToSend({ address: identity.fromAddress }));
      props.onWorkspaceChange();
      void props.onReload();
    },
    onError: (error) => prompts.error(messages().receivingRemainsActive({ reason: error.message })),
  });
  onCleanup(() => {
    discover.abort();
    startOAuth.abort();
    connect.abort();
    revoke.abort();
    finishSetup.abort();
    setupSender.abort();
  });

  const openConnectionEditor = async () => {
    setEditing(true);
    try {
      await dialogCore.open<void>((close) => {
        closeConnectionDialog = () => close();
        return (
          <PanelDialog>
            <PanelDialog.Header
              title={replacingConnectionId() ? messages().editConnectedAccount : messages().connectAccount}
              subtitle={messages().verifyMailBeforeSaving}
              icon="ti ti-server-cog"
              close={() => void closeEditor()}
            />
            <PanelDialog.Body>
              <PanelDialog.Section title={messages().account} subtitle={messages().accountSubtitle} icon="ti ti-at">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextInput
                    label={messages().label}
                    description={messages().accountLabelDescription}
                    value={name}
                    onValueChange={setName}
                    required
                  />
                  <div class="flex items-end gap-2">
                    <div class="min-w-0 flex-1">
                      <TextInput
                        label={messages().emailAddress}
                        description={messages().providerEmailDescription}
                        type="email"
                        value={email}
                        onValueChange={setEmail}
                        required
                      />
                    </div>
                    <Button
                      variant="input"
                      size="sm"
                      type="button"
                      class="shrink-0"
                      disabled={!email().trim() || discover.loading()}
                      onClick={() => discover.mutate()}
                    >
                      <i class={`ti ${discover.loading() ? "ti-loader-2 animate-spin" : "ti-wand"}`} aria-hidden="true" />
                      {messages().findSettings}
                    </Button>
                  </div>
                </div>
                <Show when={discoverySource()}>
                  {(source) => (
                    <NoticeCard tone="success" icon={false} role="status">
                      {messages().settingsFilledFrom({ source: source() })}
                    </NoticeCard>
                  )}
                </Show>
                <TextInput
                  label={messages().username}
                  description={messages().usernameDescription}
                  value={username}
                  onValueChange={setUsername}
                  required
                />
              </PanelDialog.Section>

              <PanelDialog.Section title={messages().serverSettings} subtitle={messages().serverSettingsDescription} icon="ti ti-server">
                <div>
                  <p class="mb-1 text-xs font-semibold text-primary">{messages().incomingMail}</p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_11rem]">
                    <TextInput
                      label={messages().imapHost}
                      placeholder="imap.example.com"
                      value={imapHost}
                      onValueChange={setImapHost}
                      required
                    />
                    <NumberInput
                      label={messages().port}
                      value={imapPort}
                      onValueChange={(value) => setImapPort(value ?? 993)}
                      min={1}
                      max={65_535}
                    />
                    <Select
                      label="TLS"
                      value={imapTls}
                      onValueChange={(value) => setImapTls(value === "starttls" ? "starttls" : "implicit")}
                      options={[
                        { id: "implicit", label: "Implicit TLS" },
                        { id: "starttls", label: "STARTTLS" },
                      ]}
                    />
                  </div>
                </div>
                <div>
                  <p class="mb-1 text-xs font-semibold text-primary">{messages().outgoingMail}</p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_11rem]">
                    <TextInput
                      label={messages().smtpHost}
                      placeholder="smtp.example.com"
                      value={smtpHost}
                      onValueChange={setSmtpHost}
                      required
                    />
                    <NumberInput
                      label={messages().port}
                      value={smtpPort}
                      onValueChange={(value) => setSmtpPort(value ?? 587)}
                      min={1}
                      max={65_535}
                    />
                    <Select
                      label="TLS"
                      value={smtpTls}
                      onValueChange={(value) => setSmtpTls(value === "implicit" ? "implicit" : "starttls")}
                      options={[
                        { id: "starttls", label: "STARTTLS" },
                        { id: "implicit", label: "Implicit TLS" },
                      ]}
                    />
                  </div>
                </div>
              </PanelDialog.Section>

              <PanelDialog.Section
                title={messages().authentication}
                subtitle={replacingConnectionId() ? messages().replaceCredentialDescription : messages().credentialDescription}
                icon="ti ti-key"
              >
                <Show when={oauthProviderId()}>
                  {(providerId) => (
                    <Button
                      size="sm"
                      type="button"
                      class="self-start"
                      disabled={!canStartOAuth() || startOAuth.loading()}
                      onClick={() =>
                        startOAuth.mutate({
                          providerId: providerId(),
                          connectionId: replacingConnectionId() ?? undefined,
                          connection: replacingConnectionId()
                            ? {
                                name: name().trim(),
                                email: email().trim(),
                                username: username().trim(),
                                imap: { host: imapHost().trim(), port: imapPort(), tlsMode: imapTls() },
                                smtp: { host: smtpHost().trim(), port: smtpPort(), tlsMode: smtpTls() },
                              }
                            : undefined,
                        })
                      }
                    >
                      <i class={startOAuth.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-login-2"} aria-hidden="true" />
                      {messages().continueWith({ provider: providerId() === "google" ? "Google" : "Microsoft" })}
                    </Button>
                  )}
                </Show>
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    label={messages().authentication}
                    description={messages().authenticationDescription}
                    value={auth}
                    onValueChange={(value) => setAuth(value === "oauth2" ? "oauth2" : "password")}
                    options={[
                      { id: "password", label: messages().password },
                      { id: "oauth2", label: messages().oauthAccessToken },
                    ]}
                  />
                  <TextInput
                    label={auth() === "oauth2" ? messages().accessToken : messages().password}
                    description={messages().secretDescription}
                    value={secret}
                    onValueChange={setSecret}
                    password
                    required
                    autocomplete="off"
                  />
                </div>
                <Show when={!replacingConnectionId()}>
                  <div class="flex flex-col gap-2">
                    <CheckboxCard
                      label={messages().useAddressForSending}
                      description={messages().useAddressForSendingDescription}
                      icon="ti ti-at"
                      value={createSender}
                      onValueChange={setCreateSender}
                    />
                    <Show when={createSender()}>
                      <CheckboxCard
                        label={messages().providerSavesSent}
                        description={messages().providerSavesSentDescription}
                        value={savesSentAutomatically}
                        onValueChange={setSavesSentAutomatically}
                      />
                    </Show>
                  </div>
                </Show>
              </PanelDialog.Section>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <span />
              <div class="flex items-center gap-2">
                <Button variant="ghost" size="sm" type="button" disabled={connect.loading()} onClick={() => void closeEditor()}>
                  {messages().cancel}
                </Button>
                <Button size="sm" type="button" disabled={!canSubmit() || connect.loading()} onClick={() => connect.mutate()}>
                  <i class={connect.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plug-connected"} aria-hidden="true" />
                  {replacingConnectionId() ? messages().verifyAndSave : messages().verifyAndConnect}
                </Button>
              </div>
            </PanelDialog.Footer>
          </PanelDialog>
        );
      }, connectionEditorDialogOptions);
    } finally {
      closeConnectionDialog = null;
      setEditing(false);
    }
  };

  return (
    <div class="flex flex-col gap-2">
      <Show
        when={currentConnection()}
        fallback={
          <Placeholder
            title={messages().noConnectedAccount}
            description={messages().noConnectedAccountDescription}
            icon="ti ti-plug-off"
            action={
              <Button
                size="sm"
                type="button"
                disabled={props.reloading}
                onClick={() => {
                  resetEditor();
                  void openConnectionEditor();
                }}
              >
                <i class="ti ti-plus" aria-hidden="true" />
                {messages().connectAccount}
              </Button>
            }
          />
        }
      >
        {(connection) => (
          <div class="group flex min-h-14 items-center gap-3 rounded-[var(--ui-radius-control)] px-2 py-2 hover:bg-[var(--ui-hover)]">
            <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center">
              <i class="ti ti-server text-secondary" aria-hidden="true" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-primary">{connection().name}</span>
              <span class="block truncate text-xs text-dimmed">
                {connection().email} · {connection().imap.host}
                <Show when={connection().oauth}> {` · ${connectionStateLabel(connection().oauth!.state)}`}</Show>
                <Show when={currentBinding()}>
                  {" "}
                  {` · ${messages().mailboxBindingState({ state: connectionStateLabel(currentBinding()!.state) })}`}
                </Show>
              </span>
            </span>
            <StatusBadge
              class="capitalize"
              tone={connectionStatusTone(connection().status)}
              label={connectionStateLabel(connection().status)}
            />
            <Show when={!currentBinding()}>
              <Button
                variant="secondary"
                size="sm"
                type="button"
                disabled={finishSetup.loading() || props.reloading}
                onClick={() => finishSetup.mutate(connection().id)}
              >
                <i class={finishSetup.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plug-connected"} aria-hidden="true" />
                {messages().finishSetup}
              </Button>
            </Show>
            <Dropdown.Root
              position="bottom-left"
              items={[
                {
                  label: messages().editAccount,
                  icon: "ti ti-pencil",
                  action: () => {
                    prepareEdit();
                    void openConnectionEditor();
                  },
                },
                ...(connection().oauth
                  ? [
                      {
                        label: messages().reconnectAccount,
                        icon: "ti ti-refresh",
                        action: () =>
                          startOAuth.mutate({
                            providerId: connection().oauth!.providerId,
                            connectionId: connection().id,
                          }),
                      },
                    ]
                  : []),
                {
                  sectionLabel: messages().dangerZone,
                  items: [
                    {
                      label: messages().removeAccount,
                      icon: "ti ti-trash",
                      variant: "danger" as const,
                      action: () => revoke.mutate(connection().id),
                    },
                  ],
                },
              ]}
            >
              <Dropdown.Trigger
                iconOnly
                type="button"
                variant="ghost"
                class="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100"
                label={messages().connectedAccountActions}
                disabled={props.reloading || revoke.loading() || startOAuth.loading()}
              >
                <i class="ti ti-dots" aria-hidden="true" />
              </Dropdown.Trigger>
            </Dropdown.Root>
          </div>
        )}
      </Show>
      <Show when={senderSetupPrompt()}>
        {(state) => (
          <Placeholder
            align="left"
            state={state().kind === "needs-verification" ? "error" : "empty"}
            icon={state().kind === "needs-verification" ? "ti ti-alert-circle" : "ti ti-send-off"}
            title={state().kind === "needs-verification" ? messages().sendingNeedsVerification : messages().sendingNotConfigured}
            description={
              state().kind === "needs-verification" ? messages().retrySendingSetupDescription : messages().receivingOnlyDescription
            }
            action={
              <div class="flex flex-wrap items-center gap-2">
                <CheckboxCard
                  label={messages().providerSavesSent}
                  description={messages().providerSavesSentDescription}
                  value={savesSentAutomatically}
                  onValueChange={setSavesSentAutomatically}
                  disabled={setupSender.loading()}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={!currentBinding() || setupSender.loading() || props.reloading}
                  onClick={() => {
                    const binding = currentBinding();
                    if (binding) setupSender.mutate(binding.id);
                  }}
                >
                  <i class={setupSender.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-send"} aria-hidden="true" />
                  {messages().setUpSending}
                </Button>
              </div>
            }
          />
        )}
      </Show>
    </div>
  );
}
