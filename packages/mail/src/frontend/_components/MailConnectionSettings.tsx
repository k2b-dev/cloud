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
} from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailOAuthProviderId, ProviderConnection, ProviderConnectionDetails, SenderIdentity } from "../../contracts";
import type { DiscoveredMailConfiguration } from "../../service/onboarding-discovery";
import { readApiError } from "./api-response";
import { connectionEditorDialogOptions, type ProviderSettingsProps } from "./mail-provider-settings-shared";
import { deriveDefaultSenderSetupState } from "./mail-provider-setup";

const connectionStatusTone = (status: ProviderConnection["status"]): StatusTone => {
  if (status === "active") return "ok";
  if (status === "degraded") return "warning";
  return "error";
};

export function MailConnectionSettings(props: ProviderSettingsProps) {
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not discover provider settings"));
      return response.json();
    },
    onSuccess: (candidates) => {
      const candidate = candidates[0];
      if (!candidate) {
        setDiscoverySource(null);
        return void toast("No provider configuration was published. Enter the server settings manually.", {
          title: "No settings found",
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
      toast.success("Provider settings found");
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
      if (!response.ok) throw new Error(await readApiError(response, "Could not start browser OAuth"));
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
    if (!response.ok) throw new Error(await readApiError(response, "Default identity setup failed"));
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
      const reason = await readApiError(bindingResponse, "Folder discovery failed");
      return {
        senderCreated: false,
        setupError: `Account connected, but incoming mail setup still needs attention. ${reason}`,
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
        setupError: `Receiving is active, but sending still needs setup. ${error instanceof Error ? error.message : "Default identity setup failed"}`,
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
      if (!connectionResponse.ok) throw new Error(await readApiError(connectionResponse, "Provider verification failed"));
      const created = await connectionResponse.json();
      if (replacementId) return { senderCreated: false, setupError: null, replaced: true };
      return { ...(await attachConnection(created.connection.id, createSender(), abortSignal)), replaced: false };
    },
    onSuccess: (result) => {
      if (!result.setupError) {
        toast.success(
          result.replaced
            ? "Connected account updated"
            : result.senderCreated
              ? "Provider and default identity connected"
              : "Provider connected",
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
      const confirmed = await prompts.confirm(
        "This permanently removes the encrypted credential, disconnects the remote mailbox, and stops provider operations until another connection is configured.",
        { title: "Remove provider connection?", confirmText: "Remove connection", variant: "danger" },
      );
      if (!confirmed || abortSignal.aborted) return false;
      const response = await apiClient.mailboxes[":mailboxId"].connections[":connectionId"].$delete(
        { param: { mailboxId: props.mailbox.id, connectionId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to remove provider connection"));
      return true;
    },
    onSuccess: async (revoked) => {
      if (!revoked) return;
      toast.success("Provider connection removed");
      props.onWorkspaceChange();
      await props.onReload();
    },
    onError: (error) => prompts.error(error.message),
  });

  const finishSetup = mutation.create<{ senderCreated: boolean; setupError: string | null }, string>({
    mutation: (connectionId, { abortSignal }) => attachConnection(connectionId, false, abortSignal),
    onSuccess: (result) => {
      if (!result.setupError) toast.success(result.senderCreated ? "Provider and default identity connected" : "Provider connected");
      props.onWorkspaceChange();
      void props.onReload();
      if (result.setupError) void prompts.error(result.setupError);
    },
    onError: (error) => prompts.error(error.message),
  });

  const setupSender = mutation.create<SenderIdentity, string>({
    mutation: (bindingId, { abortSignal }) => requestDefaultSenderSetup(bindingId, abortSignal),
    onSuccess: (identity) => {
      toast.success(`${identity.fromAddress} is ready to send`);
      props.onWorkspaceChange();
      void props.onReload();
    },
    onError: (error) => prompts.error(`Receiving remains active. ${error.message}`),
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
              title={replacingConnectionId() ? "Edit connected account" : "Connect account"}
              subtitle="Verify incoming and outgoing mail before saving"
              icon="ti ti-server-cog"
              close={() => void closeEditor()}
            />
            <PanelDialog.Body>
              <PanelDialog.Section title="Account" subtitle="The mailbox address and provider login." icon="ti ti-at">
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <TextInput
                    label="Label"
                    description="The private name shown to mailbox administrators."
                    value={name}
                    onValueChange={setName}
                    required
                  />
                  <div class="flex items-end gap-2">
                    <div class="min-w-0 flex-1">
                      <TextInput
                        label="Email address"
                        description="Used to find the provider's server settings."
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
                      Find settings
                    </Button>
                  </div>
                </div>
                <Show when={discoverySource()}>
                  {(source) => (
                    <NoticeCard tone="success" icon={false} role="status">
                      Server settings were filled from {source()}. Review them, then enter the account secret.
                    </NoticeCard>
                  )}
                </Show>
                <TextInput
                  label="Username"
                  description="The login name used for incoming and outgoing mail."
                  value={username}
                  onValueChange={setUsername}
                  required
                />
              </PanelDialog.Section>

              <PanelDialog.Section
                title="Server settings"
                subtitle="Automatic discovery fills these values when the provider publishes them."
                icon="ti ti-server"
              >
                <div>
                  <p class="mb-1 text-xs font-semibold text-primary">Incoming mail</p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_11rem]">
                    <TextInput label="IMAP host" placeholder="imap.example.com" value={imapHost} onValueChange={setImapHost} required />
                    <NumberInput label="Port" value={imapPort} onValueChange={(value) => setImapPort(value ?? 993)} min={1} max={65_535} />
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
                  <p class="mb-1 text-xs font-semibold text-primary">Outgoing mail</p>
                  <div class="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_8rem_11rem]">
                    <TextInput label="SMTP host" placeholder="smtp.example.com" value={smtpHost} onValueChange={setSmtpHost} required />
                    <NumberInput label="Port" value={smtpPort} onValueChange={(value) => setSmtpPort(value ?? 587)} min={1} max={65_535} />
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
                title="Authentication"
                subtitle={
                  replacingConnectionId()
                    ? "Enter the complete credential again. It is verified before the saved account is updated."
                    : "The credential is encrypted after verification and never shown again."
                }
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
                      Continue with {providerId() === "google" ? "Google" : "Microsoft"}
                    </Button>
                  )}
                </Show>
                <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    label="Authentication"
                    description="Choose how Mail signs in to the provider."
                    value={auth}
                    onValueChange={(value) => setAuth(value === "oauth2" ? "oauth2" : "password")}
                    options={[
                      { id: "password", label: "Password" },
                      { id: "oauth2", label: "OAuth2 access token" },
                    ]}
                  />
                  <TextInput
                    label={auth() === "oauth2" ? "Access token" : "Password"}
                    description="Encrypted after verification and never shown again."
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
                      label="Use this address for sending"
                      description="Creates and verifies the default sending identity after incoming mail is connected."
                      icon="ti ti-at"
                      value={createSender}
                      onValueChange={setCreateSender}
                    />
                    <Show when={createSender()}>
                      <CheckboxCard
                        label="Provider saves sent mail automatically"
                        description="Turn this on if your provider already adds sent messages to Sent. Otherwise Mail saves a copy."
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
                  Cancel
                </Button>
                <Button size="sm" type="button" disabled={!canSubmit() || connect.loading()} onClick={() => connect.mutate()}>
                  <i class={connect.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plug-connected"} aria-hidden="true" />
                  {replacingConnectionId() ? "Verify and save" : "Verify and connect"}
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
            title="No connected account"
            description="Connect an IMAP and SMTP account to synchronize mail."
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
                Connect account
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
                <Show when={connection().oauth}> {` · ${connection().oauth?.state.replaceAll("_", " ")}`}</Show>
                <Show when={currentBinding()}> {` · mailbox ${currentBinding()?.state.replaceAll("_", " ")}`}</Show>
              </span>
            </span>
            <StatusBadge
              class="capitalize"
              tone={connectionStatusTone(connection().status)}
              label={connection().status.replaceAll("_", " ")}
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
                Finish setup
              </Button>
            </Show>
            <Dropdown.Root
              position="bottom-left"
              items={[
                {
                  label: "Edit account",
                  icon: "ti ti-pencil",
                  action: () => {
                    prepareEdit();
                    void openConnectionEditor();
                  },
                },
                ...(connection().oauth
                  ? [
                      {
                        label: "Reconnect account",
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
                  sectionLabel: "Danger zone",
                  items: [
                    {
                      label: "Remove account",
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
                label="Connected account actions"
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
            title={state().kind === "needs-verification" ? "Sending needs verification" : "Sending is not configured"}
            description={
              state().kind === "needs-verification"
                ? "Receiving is active. Retry the default identity setup without reconnecting the account."
                : "This account currently receives mail only. You can add the default sending identity at any time."
            }
            action={
              <div class="flex flex-wrap items-center gap-2">
                <CheckboxCard
                  label="Provider saves sent mail automatically"
                  description="Turn this on if your provider already adds sent messages to Sent. Otherwise Mail saves a copy."
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
                  Set up sending
                </Button>
              </div>
            }
          />
        )}
      </Show>
    </div>
  );
}
