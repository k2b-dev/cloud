import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  confirmDiscardIfDirty,
  NoticeCard,
  NumberInput,
  prompts,
  Select,
  SettingsField,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { PermissionEditor } from "@k2b/cloud/access/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ConfigurableFolderRole, Mailbox } from "../../contracts";
import type { MailboxSettingsContext } from "../../settings-context";
import { readApiError } from "./api-response";
import MailCalendarSettings from "./MailCalendarSettings";
import MailComposeSettings from "./MailComposeSettings";
import { MailConnectionSettings } from "./MailConnectionSettings";
import MailFolderSettings from "./MailFolderSettings";
import { MailIdentitySettings } from "./MailIdentitySettings";
import MailOrganizationSettings from "./MailOrganizationSettings";
import { readMailUserPreferences, writeMailUserPreferences } from "./MailSettingsStore";
import { mailSettingsMessages } from "./mail-settings-messages";

const normalizeInitialTab = (tab: string | undefined, canWrite: boolean, canAdmin: boolean, hasCalendar: boolean): string => {
  const aliases: Record<string, string> = {
    preferences: "writing",
    compose: "writing",
    general: "mailbox",
    connections: "delivery",
    identities: "delivery",
  };
  const requested = aliases[tab ?? ""] ?? tab;
  const allowed = new Set([
    "reading",
    "organization",
    ...(canWrite ? ["writing"] : []),
    ...(canAdmin ? ["mailbox", "delivery", "folders", "access", "danger", ...(hasCalendar ? ["calendar"] : [])] : []),
  ]);
  if (requested && allowed.has(requested)) return requested;
  return canAdmin ? "mailbox" : canWrite ? "writing" : "reading";
};

export default function MailboxSettings(props: {
  context: MailboxSettingsContext;
  initialTab?: string;
  currentUserEmail: string | null;
  reloading: boolean;
  onReload: () => Promise<void>;
  onContextChange: (update: (context: MailboxSettingsContext) => MailboxSettingsContext) => void;
  onWorkspaceChange: () => void;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const canWrite = () => props.context.permission === "write" || props.context.permission === "admin";
  const canAdmin = () => props.context.permission === "admin";
  const admin = () => props.context.admin!;
  const initialPreferences = readMailUserPreferences(props.context.mailbox.id);
  const [savedReadingFormat, setSavedReadingFormat] = createSignal(initialPreferences.readingFormat);
  const [savedComposeFormat, setSavedComposeFormat] = createSignal(initialPreferences.composeFormat);
  const [savedUndoSeconds, setSavedUndoSeconds] = createSignal(initialPreferences.undoSeconds);
  const [readingFormat, setReadingFormat] = createSignal(initialPreferences.readingFormat);
  const [composeFormat, setComposeFormat] = createSignal(initialPreferences.composeFormat);
  const [undoSeconds, setUndoSeconds] = createSignal(initialPreferences.undoSeconds);
  const [name, setName] = createSignal(props.context.mailbox.name);
  const [description, setDescription] = createSignal(props.context.mailbox.description ?? "");
  const [internalDomains, setInternalDomains] = createSignal(props.context.mailbox.composeSafety.internalDomains.join(", "));
  const [largeRecipientThreshold, setLargeRecipientThreshold] = createSignal(props.context.mailbox.composeSafety.largeRecipientThreshold);
  const [automaticReplyManagementPermission, setAutomaticReplyManagementPermission] = createSignal<
    Mailbox["automaticReplyManagementPermission"]
  >(props.context.mailbox.automaticReplyManagementPermission);
  const [activeTab, setActiveTab] = createSignal(
    normalizeInitialTab(props.initialTab, canWrite(), canAdmin(), props.context.integrations.spacesCalendar),
  );
  const [childDirtyStates, setChildDirtyStates] = createSignal<Record<string, boolean>>({});
  const [navigationPending, setNavigationPending] = createSignal(false);
  const healthPresentation = createMemo(() => {
    const health = props.context.mailbox.health;
    if (health === "active") return null;
    if (health === "paused")
      return { title: messages().healthPausedTitle, message: messages().healthPausedMessage, tone: "warning" as const };
    if (health === "degraded") {
      const timedOut =
        props.context.mailbox.healthReason?.toLowerCase().includes("failed to establish connection in required time") === true;
      return timedOut
        ? { title: messages().healthSlowTitle, message: messages().healthSlowMessage, tone: "warning" as const }
        : { title: messages().healthDegradedTitle, message: messages().healthDegradedMessage, tone: "warning" as const };
    }
    if (health === "auth_required")
      return { title: messages().healthAuthTitle, message: messages().healthAuthMessage, tone: "warning" as const };
    if (health === "connection_required" || health === "disconnected") {
      return {
        title: messages().healthConnectTitle,
        message: health === "connection_required" ? messages().healthConnectionRequiredMessage : messages().healthDisconnectedMessage,
        tone: "warning" as const,
      };
    }
    if (health === "verifying")
      return { title: messages().healthVerifyingTitle, message: messages().healthVerifyingMessage, tone: "info" as const };
    if (health === "bootstrapping")
      return { title: messages().healthBootstrappingTitle, message: messages().healthBootstrappingMessage, tone: "info" as const };
    return { title: messages().healthReconnectingTitle, message: messages().healthReconnectingMessage, tone: "info" as const };
  });
  const mailboxDetailsDirty = createMemo(
    () => name().trim() !== props.context.mailbox.name || description().trim() !== (props.context.mailbox.description ?? ""),
  );
  const sendingSafeguardsDirty = createMemo(
    () =>
      internalDomains() !== props.context.mailbox.composeSafety.internalDomains.join(", ") ||
      largeRecipientThreshold() !== props.context.mailbox.composeSafety.largeRecipientThreshold,
  );
  const readingChangeCount = () => (readingFormat() === savedReadingFormat() ? 0 : 1);
  const writingChangeCount = () => Number(composeFormat() !== savedComposeFormat()) + Number(undoSeconds() !== savedUndoSeconds());
  const mailboxChangeCount = () =>
    Number(name().trim() !== props.context.mailbox.name) +
    Number(description().trim() !== (props.context.mailbox.description ?? "")) +
    Number(internalDomains() !== props.context.mailbox.composeSafety.internalDomains.join(", ")) +
    Number(largeRecipientThreshold() !== props.context.mailbox.composeSafety.largeRecipientThreshold);
  const accessChangeCount = () =>
    automaticReplyManagementPermission() === props.context.mailbox.automaticReplyManagementPermission ? 0 : 1;

  const ownDirty = createMemo(() => {
    if (activeTab() === "reading") {
      return readingFormat() !== savedReadingFormat();
    }
    if (activeTab() === "writing") {
      return composeFormat() !== savedComposeFormat() || undoSeconds() !== savedUndoSeconds();
    }
    if (activeTab() === "mailbox") {
      return mailboxDetailsDirty() || sendingSafeguardsDirty();
    }
    if (activeTab() === "access") {
      return automaticReplyManagementPermission() !== props.context.mailbox.automaticReplyManagementPermission;
    }
    return false;
  });
  const setChildDirty = (key: string, dirty: boolean) =>
    setChildDirtyStates((current) => (current[key] === dirty ? current : { ...current, [key]: dirty }));
  const hasUnsavedChanges = () => ownDirty() || Object.values(childDirtyStates()).some(Boolean);

  const resetActiveTab = () => {
    if (activeTab() === "reading") {
      setReadingFormat(savedReadingFormat());
    } else if (activeTab() === "writing") {
      setComposeFormat(savedComposeFormat());
      setUndoSeconds(savedUndoSeconds());
    } else if (activeTab() === "mailbox") {
      setName(props.context.mailbox.name);
      setDescription(props.context.mailbox.description ?? "");
      setInternalDomains(props.context.mailbox.composeSafety.internalDomains.join(", "));
      setLargeRecipientThreshold(props.context.mailbox.composeSafety.largeRecipientThreshold);
    } else if (activeTab() === "access") {
      setAutomaticReplyManagementPermission(props.context.mailbox.automaticReplyManagementPermission);
    }
    setChildDirtyStates({});
  };

  const requestTabChange = async (nextTab: string) => {
    if (nextTab === activeTab() || navigationPending()) return;
    setNavigationPending(true);
    try {
      if (!(await confirmDiscardIfDirty(hasUnsavedChanges))) return;
      resetActiveTab();
      setActiveTab(nextTab);
    } finally {
      setNavigationPending(false);
    }
  };

  const requestClose = async () => {
    if (navigationPending()) return;
    setNavigationPending(true);
    try {
      if (await confirmDiscardIfDirty(hasUnsavedChanges)) props.onClose();
    } finally {
      setNavigationPending(false);
    }
  };

  const saveReadingPreferences = mutation.create<void, void>({
    mutation: async () => {
      writeMailUserPreferences(props.context.mailbox.id, {
        composeFormat: composeFormat(),
        readingFormat: readingFormat(),
        undoSeconds: undoSeconds(),
      });
    },
    onSuccess: () => {
      setSavedReadingFormat(readingFormat());
      toast.success(messages().readingPreferenceSaved);
    },
    onError: (error) => prompts.error(error.message),
  });

  const saveWritingPreferences = mutation.create<void, void>({
    mutation: async () => {
      writeMailUserPreferences(props.context.mailbox.id, {
        composeFormat: composeFormat(),
        readingFormat: readingFormat(),
        undoSeconds: undoSeconds(),
      });
    },
    onSuccess: () => {
      setSavedComposeFormat(composeFormat());
      setSavedUndoSeconds(undoSeconds());
      toast.success(messages().writingPreferencesSaved);
    },
    onError: (error) => prompts.error(error.message),
  });

  const saveMailboxSettings = mutation.create<Mailbox, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].$patch(
        {
          param: { mailboxId: props.context.mailbox.id },
          json: {
            name: name().trim(),
            description: description().trim() || null,
            composeSafety: {
              internalDomains: [
                ...new Set(
                  internalDomains()
                    .split(/[,\s]+/u)
                    .map((domain) => domain.trim().toLowerCase())
                    .filter(Boolean),
                ),
              ],
              largeRecipientThreshold: largeRecipientThreshold(),
            },
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateMailboxSettings));
      return response.json();
    },
    onSuccess: (mailbox) => {
      setName(mailbox.name);
      setDescription(mailbox.description ?? "");
      setInternalDomains(mailbox.composeSafety.internalDomains.join(", "));
      setLargeRecipientThreshold(mailbox.composeSafety.largeRecipientThreshold);
      props.onContextChange((context) => ({ ...context, mailbox }));
      toast.success(messages().mailboxSettingsSaved);
      props.onWorkspaceChange();
    },
    onError: (error) => prompts.error(error.message),
  });

  const updateFolderRole = mutation.create<
    { role: ConfigurableFolderRole; folderId: string },
    { role: ConfigurableFolderRole; folderId: string }
  >({
    mutation: async (input, { abortSignal }) => {
      const route = apiClient.mailboxes[":mailboxId"]["folder-roles"][":role"];
      const param = { mailboxId: props.context.mailbox.id, role: input.role };
      const response = input.folderId
        ? await route.$put({ param, json: { folderId: input.folderId } }, { init: { signal: abortSignal } })
        : await route.$delete({ param }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateFolderRole));
      return input;
    },
    onSuccess: ({ role, folderId }) => {
      props.onContextChange((context) =>
        context.admin
          ? {
              ...context,
              admin: {
                ...context.admin,
                folders: context.admin.folders.map((folder) => ({
                  ...folder,
                  configuredRole: folder.id === folderId ? role : folder.configuredRole === role ? null : folder.configuredRole,
                })),
              },
            }
          : context,
      );
      toast.success(messages().folderRoleUpdated);
      props.onWorkspaceChange();
    },
    onError: (error) => prompts.error(error.message),
  });

  const setFolderVisibility = (folderId: string, showInSidebar: boolean) => {
    props.onContextChange((context) =>
      context.admin
        ? {
            ...context,
            admin: {
              ...context.admin,
              folders: context.admin.folders.map((folder) => (folder.id === folderId ? { ...folder, showInSidebar } : folder)),
            },
          }
        : context,
    );
  };

  const saveAutomaticReplyAccess = mutation.create<Mailbox, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].$patch(
        {
          param: { mailboxId: props.context.mailbox.id },
          json: { automaticReplyManagementPermission: automaticReplyManagementPermission() },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateAutomaticReplyAccess));
      return response.json();
    },
    onSuccess: (mailbox) => {
      props.onContextChange((context) => ({ ...context, mailbox }));
      toast.success(messages().automaticReplyAccessUpdated);
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteMailbox = mutation.create<boolean, void>({
    mutation: async (_input, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().recentlyDeletedDescription, {
        title: messages().moveMailboxToRecentlyDeleted,
        confirmText: messages().moveToRecentlyDeleted,
        variant: "danger",
      });
      if (!confirmed || abortSignal.aborted) return false;
      const response = await apiClient.mailboxes[":mailboxId"].$delete(
        { param: { mailboxId: props.context.mailbox.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedMoveToRecentlyDeleted));
      return true;
    },
    onSuccess: (deleted) => {
      if (deleted) props.onDeleted();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    saveReadingPreferences.abort();
    saveWritingPreferences.abort();
    saveMailboxSettings.abort();
    updateFolderRole.abort();
    saveAutomaticReplyAccess.abort();
    deleteMailbox.abort();
  });

  return (
    <SettingsModal
      title={messages().mailboxSettings}
      activeTab={activeTab()}
      onTabChange={(tab) => void requestTabChange(tab)}
      onClose={() => void requestClose()}
      closeLabel={messages().closeSettings}
    >
      <SettingsModal.Group title={messages().personal}>
        <SettingsModal.Tab id="reading" title={messages().reading} icon="ti ti-mail-opened" description={messages().readingDescription}>
          <SettingsGroup title={messages().messageDisplay} description={messages().messageDisplayDescription}>
            <SettingsField
              label={messages().defaultMessageFormat}
              description={messages().browserOnlyPreference}
              error={() => undefined}
              changed={() => readingChangeCount() > 0}
            >
              {(control) => (
                <Select
                  aria-label={messages().defaultMessageFormat}
                  aria-describedby={control.describedBy()}
                  value={readingFormat}
                  onValueChange={(value) => setReadingFormat(value === "html" || value === "plain" ? value : "automatic")}
                  options={[
                    {
                      id: "automatic",
                      label: messages().automaticRecommended,
                      description: messages().automaticFormatDescription,
                      icon: "ti ti-adjustments-horizontal",
                    },
                    { id: "html", label: "HTML", description: messages().htmlFormatDescription, icon: "ti ti-code" },
                    { id: "plain", label: messages().plainText, description: messages().plainTextDescription, icon: "ti ti-align-left" },
                  ]}
                />
              )}
            </SettingsField>
            <p class="text-xs text-dimmed">{messages().messageSafetyDescription}</p>
          </SettingsGroup>
          <SettingsModal.Footer>
            <SettingsPanelFooter
              changeCount={readingChangeCount}
              loading={saveReadingPreferences.loading}
              onDiscard={() => setReadingFormat(savedReadingFormat())}
              onSave={() => saveReadingPreferences.mutate()}
            />
          </SettingsModal.Footer>
        </SettingsModal.Tab>
      </SettingsModal.Group>

      <Show when={canWrite() && props.context.compose}>
        {(compose) => (
          <SettingsModal.Group title={messages().compose}>
            <SettingsModal.Tab id="writing" title={messages().writing} icon="ti ti-pencil" description={messages().writingDescription}>
              <div class="flex flex-col gap-8">
                <SettingsGroup title={messages().myWritingDefaults} description={messages().browserOnlyDefaults}>
                  <SettingsField
                    label={messages().composeFormat}
                    description={messages().composeFormatDescription}
                    error={() => undefined}
                    changed={() => composeFormat() !== savedComposeFormat()}
                  >
                    {(control) => (
                      <Select
                        aria-label={messages().composeFormat}
                        aria-describedby={control.describedBy()}
                        value={composeFormat}
                        onValueChange={(value) => setComposeFormat(value === "plain" ? "plain" : "markdown")}
                        options={[
                          { id: "markdown", label: "Markdown", icon: "ti ti-markdown" },
                          { id: "plain", label: messages().plainText, icon: "ti ti-align-left" },
                        ]}
                      />
                    )}
                  </SettingsField>
                  <SettingsField
                    label={messages().undoSendWindow}
                    description={messages().undoSendDescription}
                    error={() => undefined}
                    changed={() => undoSeconds() !== savedUndoSeconds()}
                  >
                    {(control) => (
                      <NumberInput
                        aria-label={messages().undoSendWindow}
                        aria-describedby={control.describedBy()}
                        value={undoSeconds}
                        onValueChange={(value) => setUndoSeconds(value ?? 0)}
                        min={0}
                        max={60}
                        allowNegative={false}
                        suffix={messages().seconds}
                      />
                    )}
                  </SettingsField>
                </SettingsGroup>
                <MailComposeSettings
                  mailboxId={props.context.mailbox.id}
                  permission={props.context.permission === "admin" ? "admin" : "write"}
                  initialTemplates={compose().templates}
                  initialDefaults={compose().defaults}
                  initialStyle={compose().style}
                  identities={compose().identities}
                  onTemplatesChange={(templates) =>
                    props.onContextChange((context) =>
                      context.compose ? { ...context, compose: { ...context.compose, templates } } : context,
                    )
                  }
                />
              </div>
              <SettingsModal.Footer>
                <SettingsPanelFooter
                  changeCount={writingChangeCount}
                  loading={saveWritingPreferences.loading}
                  onDiscard={() => {
                    setComposeFormat(savedComposeFormat());
                    setUndoSeconds(savedUndoSeconds());
                  }}
                  onSave={() => saveWritingPreferences.mutate()}
                />
              </SettingsModal.Footer>
            </SettingsModal.Tab>
          </SettingsModal.Group>
        )}
      </Show>

      <SettingsModal.Group title={messages().mailbox}>
        <Show when={canAdmin() && props.context.admin}>
          <SettingsModal.Tab id="mailbox" title={messages().general} icon="ti ti-id" description={messages().mailboxGeneralDescription}>
            <SettingsGroup title={messages().identity} description={messages().identityDescription}>
              <SettingsField
                label={messages().name}
                description={messages().mailboxNameDescription}
                error={() => (!name().trim() ? messages().nameRequired : undefined)}
                changed={() => name().trim() !== props.context.mailbox.name}
              >
                {(control) => (
                  <TextInput
                    aria-label={messages().name}
                    aria-describedby={control.describedBy()}
                    value={name}
                    onValueChange={setName}
                    required
                    disabled={saveMailboxSettings.loading() || props.reloading}
                  />
                )}
              </SettingsField>
              <SettingsField
                label={messages().description}
                description={messages().optionalCollaboratorContext}
                error={() => undefined}
                changed={() => description().trim() !== (props.context.mailbox.description ?? "")}
              >
                {(control) => (
                  <TextInput
                    aria-label={messages().description}
                    aria-describedby={control.describedBy()}
                    value={description}
                    onValueChange={setDescription}
                    multiline
                    lines={3}
                    disabled={saveMailboxSettings.loading() || props.reloading}
                  />
                )}
              </SettingsField>
            </SettingsGroup>
            <SettingsGroup title={messages().sendingSafeguards} description={messages().sendingSafeguardsDescription}>
              <SettingsField
                label={messages().internalEmailDomains}
                description={messages().internalEmailDomainsDescription}
                error={() => undefined}
                changed={() => internalDomains() !== props.context.mailbox.composeSafety.internalDomains.join(", ")}
              >
                {(control) => (
                  <TextInput
                    aria-label={messages().internalEmailDomains}
                    aria-describedby={control.describedBy()}
                    value={internalDomains}
                    onValueChange={setInternalDomains}
                    placeholder="example.org, subsidiary.example"
                    disabled={saveMailboxSettings.loading() || props.reloading}
                  />
                )}
              </SettingsField>
              <SettingsField
                label={messages().largeRecipientWarning}
                description={messages().largeRecipientWarningDescription}
                error={() => undefined}
                changed={() => largeRecipientThreshold() !== props.context.mailbox.composeSafety.largeRecipientThreshold}
              >
                {(control) => (
                  <NumberInput
                    aria-label={messages().largeRecipientWarning}
                    aria-describedby={control.describedBy()}
                    value={largeRecipientThreshold}
                    onValueChange={(value) => setLargeRecipientThreshold(value ?? 20)}
                    min={5}
                    max={200}
                    allowNegative={false}
                    suffix={messages().recipients}
                    disabled={saveMailboxSettings.loading() || props.reloading}
                  />
                )}
              </SettingsField>
            </SettingsGroup>
            <SettingsModal.Footer>
              <SettingsPanelFooter
                changeCount={mailboxChangeCount}
                loading={() => saveMailboxSettings.loading() || props.reloading}
                saveDisabled={() => !name().trim()}
                onDiscard={() => {
                  setName(props.context.mailbox.name);
                  setDescription(props.context.mailbox.description ?? "");
                  setInternalDomains(props.context.mailbox.composeSafety.internalDomains.join(", "));
                  setLargeRecipientThreshold(props.context.mailbox.composeSafety.largeRecipientThreshold);
                }}
                onSave={() => saveMailboxSettings.mutate()}
              />
            </SettingsModal.Footer>
          </SettingsModal.Tab>
        </Show>

        <SettingsModal.Tab
          id="organization"
          title={messages().organization}
          icon="ti ti-tags"
          description={messages().organizationDescription}
        >
          <MailOrganizationSettings
            mailboxId={props.context.mailbox.id}
            permission={props.context.permission}
            initial={props.context.organization}
            onDirtyChange={(dirty) => setChildDirty("organization", dirty)}
            onWorkspaceChange={props.onWorkspaceChange}
          />
        </SettingsModal.Tab>
      </SettingsModal.Group>

      <Show when={canAdmin() && props.context.admin}>
        <SettingsModal.Group title={messages().delivery}>
          <SettingsModal.Tab
            id="delivery"
            title={messages().accountsAndIdentities}
            icon="ti ti-send"
            description={messages().accountsAndIdentitiesDescription}
          >
            <div class="flex flex-col gap-8">
              <Show when={healthPresentation()}>
                {(health) => (
                  <NoticeCard tone={health().tone} icon={false} bodyClass="flex items-start gap-2" role="status">
                    <i
                      class={`ti ${health().tone === "warning" ? "ti-alert-triangle" : "ti-info-circle"} mt-0.5 shrink-0`}
                      aria-hidden="true"
                    />
                    <span>
                      <strong class="font-semibold text-primary">{health().title}.</strong> {health().message}
                    </span>
                  </NoticeCard>
                )}
              </Show>
              <SettingsGroup title={messages().connectedAccount} description={messages().connectedAccountDescription}>
                <MailConnectionSettings
                  mailbox={props.context.mailbox}
                  admin={admin()}
                  currentUserEmail={props.currentUserEmail}
                  reloading={props.reloading}
                  onReload={props.onReload}
                  onWorkspaceChange={props.onWorkspaceChange}
                />
              </SettingsGroup>
              <MailIdentitySettings
                mailbox={props.context.mailbox}
                admin={admin()}
                mailboxSignatures={
                  props.context.compose?.templates.filter((template) => template.kind === "signature" && template.scope === "mailbox") ?? []
                }
                currentUserEmail={props.currentUserEmail}
                reloading={props.reloading}
                onDirtyChange={(dirty) => setChildDirty("identity", dirty)}
                onReload={props.onReload}
                onWorkspaceChange={props.onWorkspaceChange}
              />
            </div>
          </SettingsModal.Tab>
          <Show when={props.context.integrations.spacesCalendar}>
            <SettingsModal.Tab
              id="calendar"
              title={messages().calendarInvitations}
              icon="ti ti-calendar-event"
              description={messages().calendarInvitationsDescription}
            >
              <MailCalendarSettings mailboxId={props.context.mailbox.id} onDirtyChange={(dirty) => setChildDirty("calendar", dirty)} />
            </SettingsModal.Tab>
          </Show>

          <SettingsModal.Tab id="folders" title={messages().folders} icon="ti ti-folders" description={messages().foldersDescription}>
            <SettingsGroup title={messages().mailboxFolders} description={messages().mailboxFoldersDescription}>
              <MailFolderSettings
                mailboxId={props.context.mailbox.id}
                folders={admin().folders}
                reloading={props.reloading}
                onReload={props.onReload}
                onWorkspaceChange={props.onWorkspaceChange}
                onFolderVisibilityChange={setFolderVisibility}
                onFolderRoleChange={(role, folderId) => updateFolderRole.mutate({ role, folderId })}
                folderRolePending={updateFolderRole.loading()}
              />
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={messages().sharing}>
          <SettingsModal.Tab id="access" title={messages().access} icon="ti ti-shield" description={messages().accessDescription}>
            <SettingsGroup title={messages().automaticReplies} description={messages().automaticRepliesDescription}>
              <SettingsField
                label={messages().managementAccess}
                description={messages().managementAccessDescription}
                error={() => undefined}
                changed={() => accessChangeCount() > 0}
              >
                {(control) => (
                  <Select
                    aria-label={messages().automaticReplyManagementAccess}
                    aria-describedby={control.describedBy()}
                    icon="ti ti-message-cog"
                    value={automaticReplyManagementPermission}
                    onValueChange={(value) => setAutomaticReplyManagementPermission(value === "write" ? "write" : "admin")}
                    options={[
                      {
                        id: "write",
                        label: messages().writersAndAdministrators,
                        description: messages().writersCanManageReplies,
                        icon: "ti ti-pencil",
                      },
                      {
                        id: "admin",
                        label: messages().administratorsOnly,
                        description: messages().onlyAdministratorsCanManageReplies,
                        icon: "ti ti-shield",
                      },
                    ]}
                  />
                )}
              </SettingsField>
            </SettingsGroup>
            <SettingsGroup title={messages().peopleAndIntegrations} description={messages().permissionChangesImmediate}>
              <PermissionEditor
                initialEntries={admin().accessEntries}
                allowAuthenticated={false}
                allowServiceAccounts
                canEdit
                grantAccess={async (principal, permission) => {
                  const response = await apiClient.mailboxes[":mailboxId"].access.$post({
                    param: { mailboxId: props.context.mailbox.id },
                    json: { principal, permission },
                  });
                  if (!response.ok) throw new Error(await readApiError(response, messages().failedGrantAccess));
                  return response.json();
                }}
                updateAccess={async (accessId, permission) => {
                  const response = await apiClient.mailboxes[":mailboxId"].access[":accessId"].$patch({
                    param: { mailboxId: props.context.mailbox.id, accessId },
                    json: { permission },
                  });
                  if (!response.ok) throw new Error(await readApiError(response, messages().failedUpdateAccess));
                }}
                revokeAccess={async (accessId) => {
                  const response = await apiClient.mailboxes[":mailboxId"].access[":accessId"].$delete({
                    param: { mailboxId: props.context.mailbox.id, accessId },
                  });
                  if (!response.ok) throw new Error(await readApiError(response, messages().failedRevokeAccess));
                }}
              />
            </SettingsGroup>
            <SettingsModal.Footer>
              <SettingsPanelFooter
                changeCount={accessChangeCount}
                loading={saveAutomaticReplyAccess.loading}
                onDiscard={() => setAutomaticReplyManagementPermission(props.context.mailbox.automaticReplyManagementPermission)}
                onSave={() => saveAutomaticReplyAccess.mutate()}
              />
            </SettingsModal.Footer>
          </SettingsModal.Tab>
        </SettingsModal.Group>

        <SettingsModal.Group title={messages().lifecycle}>
          <SettingsModal.Tab
            id="danger"
            title={messages().dangerZone}
            icon="ti ti-alert-triangle"
            description={messages().dangerZoneDescription}
            tone="danger"
          >
            <SettingsGroup title={messages().moveToRecentlyDeleted} description={messages().recentlyDeletedGroupDescription}>
              <SettingsGroup.Action>
                <Button variant="danger" size="sm" type="button" onClick={() => deleteMailbox.mutate()} disabled={deleteMailbox.loading()}>
                  <i class={`ti ${deleteMailbox.loading() ? "ti-loader-2 animate-spin" : "ti-trash"}`} aria-hidden="true" />
                  {messages().moveToRecentlyDeleted}
                </Button>
              </SettingsGroup.Action>
            </SettingsGroup>
          </SettingsModal.Tab>
        </SettingsModal.Group>
      </Show>
    </SettingsModal>
  );
}
