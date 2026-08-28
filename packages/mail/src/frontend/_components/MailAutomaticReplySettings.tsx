import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  dialogCore,
  IconButton,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  panelDialogWorkspaceOptions,
  prompts,
  SegmentedControl,
  Select,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { AutomaticReplyInactiveBehavior, AutomaticReplyPreview, SenderIdentity } from "../../contracts";
import { validateResponseScheduleDefinition } from "../../response-schedule-validation";
import type { AutomaticReplyConfiguration, AutomaticReplySetup } from "../../service/automatic-reply-configuration";
import type { ConversationReferenceConfiguration } from "../../service/conversation-reference";
import type { ResponseScheduleDefinition } from "../../service/response-schedule";
import { readApiError } from "./api-response";
import { MailReferenceConfigurationFields, referenceConfigurationDraft } from "./MailResponsePolicySettings";
import MailResponseScheduleFields, { responseScheduleSummary } from "./MailResponseScheduleFields";
import MailTemplateHelpDisclosure, { MailTemplateToken } from "./MailTemplateHelpDisclosure";
import { waitForMailPageTransition } from "./mail-page-transition";
import { mailRemainingMessages } from "./mail-remaining-messages";

type AutomaticReplyDraft = {
  name: string;
  enabled: boolean;
  senderIdentityId: string;
  subject: string;
  body: string;
  format: "plain" | "markdown";
  ensureReference: boolean;
  minimumIntervalHours: number;
  inactiveBehavior: AutomaticReplyInactiveBehavior;
  schedule: ResponseScheduleDefinition;
};

const AUTOMATIC_REPLY_VARIABLE_GROUPS = [
  {
    id: "message",
    variables: [
      "inputs.message.id",
      "inputs.message.conversationId",
      "inputs.message.subject",
      "inputs.message.body",
      "inputs.message.bodyText",
      "inputs.message.bodyHtml",
      "inputs.message.fromAddress",
      "inputs.message.fromDomain",
      "inputs.message.sender.0.role",
      "inputs.message.sender.0.name",
      "inputs.message.sender.0.email",
      "inputs.message.recipients.0.role",
      "inputs.message.recipients.0.name",
      "inputs.message.recipients.0.email",
      "inputs.message.attachments.0.id",
      "inputs.message.attachments.0.filename",
      "inputs.message.attachments.0.contentType",
      "inputs.message.attachments.0.disposition",
      "inputs.message.attachments.0.contentId",
      "inputs.message.attachments.0.sizeBytes",
      "inputs.message.hasAttachments",
      "inputs.message.folderId",
      "inputs.message.flags",
      "inputs.message.keywords",
      "inputs.message.direction",
      "inputs.message.internalDate",
      "inputs.message.receivedAt",
    ],
  },
  {
    id: "conversation",
    variables: [
      "inputs.conversation.id",
      "inputs.conversation.subject",
      "inputs.conversation.assigneeUserId",
      "inputs.conversation.workStatus",
      "inputs.conversation.latestMessageAt",
    ],
  },
  {
    id: "execution",
    variables: [
      "context.mailboxId",
      "context.actor.userId",
      "context.actor.serviceAccountId",
      "context.actor.groupIds",
      "context.occurredAt",
    ],
  },
] as const;

const REFERENCE_VARIABLES = [
  "reference.id",
  "reference.value",
  "reference.created",
  "reference.conversationId",
  "reference.conversationRevision",
] as const;

const liquidExpression = (value: string): string => `{{ ${value} }}`;

function AutomaticReplyVariableHelp(props: { referenceEnabled: () => boolean }) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const groupLabel = (id: string) =>
    ({ message: messages().message, conversation: messages().conversation, execution: messages().execution })[id];
  return (
    <MailTemplateHelpDisclosure title={messages().availableTemplateVariables}>
      <div class="grid gap-4 md:grid-cols-2">
        <For each={AUTOMATIC_REPLY_VARIABLE_GROUPS}>
          {(group) => (
            <section>
              <h4 class="text-xs font-semibold text-primary">{groupLabel(group.id)}</h4>
              <div class="mt-1 flex flex-wrap gap-1.5">
                <For each={group.variables}>{(variable) => <MailTemplateToken value={liquidExpression(variable)} />}</For>
              </div>
            </section>
          )}
        </For>
        <section>
          <h4 class="text-xs font-semibold text-primary">{messages().referenceNumber}</h4>
          <p class="mt-0.5 text-xs text-dimmed">
            {props.referenceEnabled() ? messages().referenceAvailable : messages().referenceAvailableAfterEnable}
          </p>
          <div class="mt-1 flex flex-wrap gap-1.5">
            <For each={REFERENCE_VARIABLES}>
              {(variable) => <MailTemplateToken value={liquidExpression(variable)} muted={!props.referenceEnabled()} />}
            </For>
          </div>
        </section>
      </div>
    </MailTemplateHelpDisclosure>
  );
}

export type AutomaticReplyPresetId = "out-of-office" | "office-hours" | "reference-acknowledgement" | "custom";

export const isAutomaticReplyPresetId = (value: string | null | undefined): value is AutomaticReplyPresetId =>
  value === "out-of-office" || value === "office-hours" || value === "reference-acknowledgement" || value === "custom";

type AutomaticReplyPreset = {
  id: AutomaticReplyPresetId;
  title: string;
  description: string;
  icon: string;
  build: (timeZone: string, senderIdentityId: string) => AutomaticReplyDraft;
};

const localDate = (): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
};

const fullWeek = () =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday: weekday as 1 | 2 | 3 | 4 | 5 | 6 | 7,
    start: "00:00",
    end: "24:00",
  }));

const workingWeek = () =>
  [1, 2, 3, 4, 5].map((weekday) => ({
    weekday: weekday as 1 | 2 | 3 | 4 | 5,
    start: "09:00",
    end: "17:00",
  }));

const automaticReplyPresets = (locale: string): AutomaticReplyPreset[] => {
  const messages = mailRemainingMessages.resolve([locale]).t;
  return [
    {
      id: "out-of-office",
      title: messages.outOfOffice,
      description: messages.outOfOfficePresetDescription,
      icon: "ti ti-beach",
      build: (timeZone, senderIdentityId) => ({
        name: messages.outOfOffice,
        enabled: true,
        senderIdentityId,
        subject: "Re: {{ inputs.message.subject }}",
        body: messages.outOfOfficeBody,
        format: "markdown",
        ensureReference: false,
        minimumIntervalHours: 96,
        inactiveBehavior: "skip",
        schedule: {
          mode: "windows",
          timeZone,
          activeRanges: [{ from: localDate(), to: localDate() }],
          weeklyWindows: fullWeek(),
          exceptions: [],
        },
      }),
    },
    {
      id: "office-hours",
      title: messages.officeHoursAcknowledgement,
      description: messages.officeHoursPresetDescription,
      icon: "ti ti-building",
      build: (timeZone, senderIdentityId) => ({
        name: messages.officeHoursAcknowledgement,
        enabled: true,
        senderIdentityId,
        subject: "Re: {{ inputs.message.subject }}",
        body: messages.officeHoursBody,
        format: "markdown",
        ensureReference: false,
        minimumIntervalHours: 24,
        inactiveBehavior: "defer",
        schedule: { mode: "windows", timeZone, activeRanges: [], weeklyWindows: workingWeek(), exceptions: [] },
      }),
    },
    {
      id: "reference-acknowledgement",
      title: messages.referenceAcknowledgement,
      description: messages.referencePresetDescription,
      icon: "ti ti-hash",
      build: (timeZone, senderIdentityId) => ({
        name: messages.referenceAcknowledgement,
        enabled: true,
        senderIdentityId,
        subject: "Re: {{ inputs.message.subject }}",
        body: messages.referenceBody,
        format: "markdown",
        ensureReference: true,
        minimumIntervalHours: 24,
        inactiveBehavior: "defer",
        schedule: { mode: "always" },
      }),
    },
    {
      id: "custom",
      title: messages.customAutomaticReply,
      description: messages.customAutomaticReplyDescription,
      icon: "ti ti-adjustments",
      build: (timeZone, senderIdentityId) => ({
        name: messages.automaticReply,
        enabled: true,
        senderIdentityId,
        subject: "Re: {{ inputs.message.subject }}",
        body: messages.automaticReplyDefaultBody,
        format: "markdown",
        ensureReference: false,
        minimumIntervalHours: 24,
        inactiveBehavior: "skip",
        schedule: { mode: "windows", timeZone, activeRanges: [], weeklyWindows: workingWeek(), exceptions: [] },
      }),
    },
  ];
};

const isAutomationIdentity = (identity: SenderIdentity): boolean =>
  identity.status === "verified" && identity.authenticationPolicy.automation === "mailbox";

const initialDraft = (
  configuration: AutomaticReplyConfiguration | null,
  identities: SenderIdentity[],
  preset: AutomaticReplyPreset | null,
  locale: string,
): AutomaticReplyDraft => {
  if (configuration) {
    return {
      name: configuration.name,
      enabled: configuration.enabled,
      senderIdentityId: configuration.senderIdentityId,
      subject: configuration.subject,
      body: configuration.body,
      format: configuration.format,
      ensureReference: configuration.ensureReference,
      minimumIntervalHours: configuration.minimumIntervalHours,
      inactiveBehavior: configuration.inactiveBehavior,
      schedule: configuration.schedule,
    };
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return (preset ?? automaticReplyPresets(locale)[3]!).build(timeZone, identities.find(isAutomationIdentity)?.id ?? "");
};

function AutomaticReplyPresetPicker(props: {
  referenceConfigured: boolean;
  canConfigureReference: boolean;
  close: (preset: AutomaticReplyPreset | null) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const presets = createMemo(() => automaticReplyPresets(locale()));
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().newAutomaticReply}
        subtitle={messages().presetPickerDescription}
        icon="ti ti-message-cog"
        close={() => props.close(null)}
      />
      <PanelDialog.Body>
        <div class="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
          <For each={presets()}>
            {(preset) => {
              const unavailable = () =>
                preset.id === "reference-acknowledgement" && !props.referenceConfigured && !props.canConfigureReference;
              return (
                <button
                  type="button"
                  class="paper flex min-h-36 flex-col items-start gap-2 p-4 text-left disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={unavailable()}
                  onClick={() => props.close(preset)}
                >
                  <span class="thumbnail flex h-9 w-9 items-center justify-center">
                    <i class={`${preset.icon} text-base`} aria-hidden="true" />
                  </span>
                  <span class="text-sm font-semibold text-primary">{preset.title}</span>
                  <span class="text-xs leading-relaxed text-dimmed">
                    {unavailable() ? messages().referenceNumbersNeedAdmin : preset.description}
                  </span>
                  <span class="mt-auto inline-flex items-center gap-1 text-xs font-medium text-secondary">
                    {unavailable() ? messages().notConfigured : messages().continue}
                    <Show when={!unavailable()}>
                      <i class="ti ti-arrow-right" aria-hidden="true" />
                    </Show>
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <Button variant="ghost" size="sm" type="button" onClick={() => props.close(null)}>
          {messages().cancel}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function AutomaticReplyEditor(props: {
  mailboxId: string;
  configuration: AutomaticReplyConfiguration | null;
  preset: AutomaticReplyPreset | null;
  identities: SenderIdentity[];
  canEnable: boolean;
  referenceConfiguration: ConversationReferenceConfiguration | null;
  canConfigureReference: boolean;
  onReferenceConfigurationChange?: (configuration: ConversationReferenceConfiguration) => void;
  close: () => void;
  onSaved: (configuration: AutomaticReplyConfiguration) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const initial = initialDraft(props.configuration, props.identities, props.preset, locale());
  const [draft, setDraft] = createSignal({
    ...initial,
    enabled: props.configuration ? initial.enabled : props.canEnable,
  });
  const [contentTab, setContentTab] = createSignal<"write" | "preview">("write");
  const [preview, setPreview] = createSignal<AutomaticReplyPreview | null>(null);
  const [referenceDraft, setReferenceDraft] = createSignal(referenceConfigurationDraft(props.referenceConfiguration));
  const automationIdentities = () => props.identities.filter(isAutomationIdentity);
  const senderAvailable = () => automationIdentities().some((identity) => identity.id === draft().senderIdentityId);
  const senderValidForSave = () =>
    senderAvailable() ||
    Boolean(props.configuration && !draft().enabled && draft().senderIdentityId === props.configuration.senderIdentityId);
  const selectableIdentities = () => {
    const available = automationIdentities();
    const selected = props.identities.find((identity) => identity.id === draft().senderIdentityId);
    return selected && !available.some((identity) => identity.id === selected.id) ? [...available, selected] : available;
  };
  const scheduleErrors = () => {
    const schedule = draft().schedule;
    const errors = validateResponseScheduleDefinition(schedule);
    if (schedule.mode === "always") return errors;
    const hasActiveWindow =
      schedule.weeklyWindows.length > 0 || schedule.exceptions.some((exception) => !exception.closed && exception.windows.length > 0);
    return hasActiveWindow ? errors : [...errors, messages().addActiveResponseWindow];
  };
  const update = <K extends keyof AutomaticReplyDraft>(key: K, value: AutomaticReplyDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const needsInlineReferenceConfiguration = () => draft().ensureReference && !props.referenceConfiguration?.enabled;
  const inlineReferenceConfiguration = () =>
    needsInlineReferenceConfiguration() && props.canConfigureReference
      ? {
          ...referenceDraft(),
          pattern: referenceDraft().pattern.trim(),
          enabled: true,
        }
      : undefined;
  const referenceConfigurationReady = () =>
    !needsInlineReferenceConfiguration() || (props.canConfigureReference && referenceDraft().pattern.trim().length > 0);

  const loadPreview = mutation.create<AutomaticReplyPreview, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["automatic-replies"].preview.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: {
            senderIdentityId: draft().senderIdentityId,
            subject: draft().subject,
            body: draft().body,
            format: draft().format,
            ensureReference: draft().ensureReference,
            referencePattern: draft().ensureReference
              ? needsInlineReferenceConfiguration()
                ? referenceDraft().pattern.trim()
                : (props.referenceConfiguration?.pattern ?? null)
              : null,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedPreparePreview));
      return response.json();
    },
    onSuccess: setPreview,
  });
  const requestPreview = () => {
    loadPreview.abort();
    setPreview(null);
    loadPreview.mutate();
  };

  const save = mutation.create<AutomaticReplySetup, void>({
    mutation: async (_input, { abortSignal }) => {
      const value = draft();
      const response = props.configuration
        ? await apiClient.mailboxes[":mailboxId"]["automatic-replies"][":configurationId"].$patch(
            {
              param: { mailboxId: props.mailboxId, configurationId: props.configuration.id },
              json: {
                automaticReply: { expectedRevision: props.configuration.revision, ...value },
                referenceConfiguration: inlineReferenceConfiguration(),
              },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"]["automatic-replies"].$post(
            {
              param: { mailboxId: props.mailboxId },
              json: {
                automaticReply: value,
                referenceConfiguration: inlineReferenceConfiguration(),
              },
            },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveAutomaticReply));
      return response.json();
    },
    onSuccess: (setup) => {
      if (setup.referenceConfiguration) props.onReferenceConfigurationChange?.(setup.referenceConfiguration);
      props.onSaved(setup.automaticReply);
      toast.success(props.configuration ? messages().automaticReplyUpdated : messages().automaticReplyCreated);
      props.close();
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    loadPreview.abort();
    save.abort();
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.configuration ? messages().editAutomaticReply : messages().newAutomaticReply}
        subtitle={messages().automaticReplyEditorDescription}
        icon="ti ti-message-cog"
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey={`mail-automatic-reply:${props.configuration?.id ?? "new"}`}>
        <PanelDialog.Section
          title={messages().automaticReply}
          subtitle={messages().automaticReplyIdentityDescription}
          icon="ti ti-message-cog"
        >
          <div class="grid gap-2 md:grid-cols-2">
            <TextInput
              label={messages().name}
              description={messages().shownToMailboxAdmins}
              value={() => draft().name}
              onValueChange={(value) => update("name", value)}
              required
            />
            <Select
              label={messages().sender}
              description={messages().automationIdentityDescription}
              icon="ti ti-mail-forward"
              value={() => draft().senderIdentityId}
              selectedLabel={() => {
                const identity = props.identities.find((item) => item.id === draft().senderIdentityId);
                if (!identity) return undefined;
                const unavailable = !automationIdentities().some((item) => item.id === identity.id);
                return `${identity.label}${unavailable ? ` (${messages().unavailableSuffix})` : ""}`;
              }}
              options={selectableIdentities().map((identity) => ({
                id: identity.id,
                label: `${identity.label}${automationIdentities().some((item) => item.id === identity.id) ? "" : ` (${messages().unavailableSuffix})`}`,
                description: `${identity.displayName ? `${identity.displayName} · ` : ""}${identity.fromAddress}`,
                icon: "ti ti-mail",
              }))}
              onValueChange={(value) => update("senderIdentityId", value ?? "")}
              required
            />
          </div>
          <Show when={!senderAvailable()}>
            <p role="alert" class="text-xs text-danger">
              {messages().unavailableAutomationIdentity}
            </p>
          </Show>
          <div>
            <Switch
              label={messages().automaticReplyEnabled}
              value={() => draft().enabled}
              disabled={!props.canEnable && !draft().enabled}
              onValueChange={(value) => update("enabled", value)}
            />
            <p class="mt-0.5 text-xs text-dimmed">
              {props.canEnable ? messages().disabledReplyDescription : messages().anotherReplyActive}
            </p>
          </div>
          <div>
            <Switch
              label={messages().assignReferenceBeforeReplying}
              value={() => draft().ensureReference}
              onValueChange={(value) => update("ensureReference", value)}
            />
            <p class="-mt-1 text-xs text-dimmed">{messages().referenceTemplateDescription}</p>
            <Show when={needsInlineReferenceConfiguration()}>
              <Show
                when={props.canConfigureReference}
                fallback={
                  <NoticeCard tone="warning" icon={false} class="mt-2" bodyClass="flex items-start gap-2">
                    <i class="ti ti-alert-triangle mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{messages().referenceRequiredBeforeSave}</span>
                  </NoticeCard>
                }
              >
                <div class="mt-2 rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] p-3">
                  <div class="mb-3">
                    <h3 class="text-sm font-semibold text-primary">{messages().setUpReferenceNumbers}</h3>
                    <p class="mt-0.5 text-xs text-dimmed">{messages().inlineReferenceDescription}</p>
                  </div>
                  <MailReferenceConfigurationFields
                    mailboxId={props.mailboxId}
                    value={referenceDraft}
                    onChange={setReferenceDraft}
                    compact
                  />
                </div>
              </Show>
            </Show>
          </div>
          <div class="grid gap-2 md:grid-cols-2">
            <Show when={draft().schedule.mode === "windows"}>
              <Select
                label={messages().outsideActiveTimes}
                description={messages().outsideActiveTimesDescription}
                icon="ti ti-calendar-off"
                value={() => draft().inactiveBehavior}
                selectedLabel={() => (draft().inactiveBehavior === "skip" ? messages().doNotReply : messages().replyAtNextActiveTime)}
                options={[
                  { id: "skip", label: messages().doNotReply, description: messages().outsideScheduleIgnored },
                  { id: "defer", label: messages().replyAtNextActiveTime, description: messages().messagesWaitForSchedule },
                ]}
                onValueChange={(value) => update("inactiveBehavior", value as AutomaticReplyInactiveBehavior)}
              />
            </Show>
            <NumberInput
              label={messages().repeatProtection}
              description={messages().repeatProtectionDescription}
              value={() => draft().minimumIntervalHours}
              onValueChange={(value) => update("minimumIntervalHours", value ?? 24)}
              min={0}
              max={8_760}
              suffix={messages().hours}
            />
          </div>
        </PanelDialog.Section>

        <PanelDialog.Section title={messages().responseContent} subtitle={messages().responseContentDescription} icon="ti ti-pencil">
          <TextInput
            label={messages().subject}
            description={messages().originalSubjectTemplateHint}
            value={() => draft().subject}
            onValueChange={(value) => {
              update("subject", value);
              setPreview(null);
            }}
            required
          />
          <AutomaticReplyVariableHelp referenceEnabled={() => draft().ensureReference} />
          <SegmentedControl
            ariaLabel={messages().messageFormat}
            value={() => draft().format}
            onValueChange={(format) => {
              update("format", format);
              setContentTab("write");
              setPreview(null);
            }}
            options={[
              { value: "markdown", label: "Markdown", icon: "ti ti-markdown" },
              { value: "plain", label: messages().plainText, icon: "ti ti-file-text" },
            ]}
          />
          <Show
            when={draft().format === "markdown"}
            fallback={
              <TextInput
                aria-label={messages().automaticReplyMessage}
                value={() => draft().body}
                onValueChange={(value) => update("body", value)}
                multiline
                lines={14}
                spellcheck
              />
            }
          >
            <PanelDialog.Tabs
              ariaLabel={messages().responseContentView}
              value={contentTab}
              onValueChange={(tab) => {
                setContentTab(tab);
                if (tab === "preview") requestPreview();
              }}
              options={[
                { value: "write", label: messages().write, icon: "ti ti-pencil" },
                { value: "preview", label: messages().preview, icon: "ti ti-eye" },
              ]}
            />
            <Show
              when={contentTab() === "write"}
              fallback={
                <div class="min-h-64 overflow-hidden rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] bg-white">
                  <Show
                    when={preview()}
                    fallback={
                      <div class="flex min-h-64 flex-col items-center justify-center gap-2 px-4 text-center text-sm text-dimmed">
                        <span>
                          {loadPreview.loading()
                            ? messages().preparingPreview
                            : (loadPreview.error()?.message ?? messages().previewUnavailable)}
                        </span>
                        <Show when={loadPreview.error()}>
                          <Button variant="secondary" size="sm" type="button" onClick={requestPreview}>
                            {messages().retry}
                          </Button>
                        </Show>
                      </div>
                    }
                  >
                    {(content) => (
                      <>
                        <div class="bg-[var(--ui-surface-subtle)] px-3 py-2 text-sm font-medium text-primary">{content().subject}</div>
                        <iframe
                          title={messages().automaticReplyPreview}
                          sandbox=""
                          class="h-80 w-full border-0 bg-white"
                          srcdoc={content().html}
                        />
                      </>
                    )}
                  </Show>
                </div>
              }
            >
              <TextInput
                aria-label={messages().automaticReplyMessage}
                value={() => draft().body}
                onValueChange={(value) => {
                  update("body", value);
                  setPreview(null);
                }}
                markdown
                lines={14}
                spellcheck
              />
            </Show>
          </Show>
        </PanelDialog.Section>

        <PanelDialog.Section title={messages().activeSchedule} subtitle={messages().activeScheduleDescription} icon="ti ti-calendar-time">
          <MailResponseScheduleFields
            value={() => draft().schedule}
            onChange={(value) => update("schedule", value)}
            errors={scheduleErrors}
          />
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" type="button" onClick={props.close}>
            {messages().cancel}
          </Button>
          <Button
            size="sm"
            type="button"
            disabled={
              save.loading() ||
              !draft().name.trim() ||
              !senderValidForSave() ||
              !draft().subject.trim() ||
              !draft().body.trim() ||
              !referenceConfigurationReady() ||
              scheduleErrors().length > 0
            }
            onClick={() => save.mutate()}
          >
            <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
            {messages().saveAutomaticReply}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export default function MailAutomaticReplySettings(props: {
  mailboxId: string;
  identities: SenderIdentity[];
  initialConfigurations: AutomaticReplyConfiguration[];
  canManage?: boolean;
  onManageIdentities?: () => void;
  onConfigurationsChange?: (configurations: AutomaticReplyConfiguration[]) => void;
  referenceConfiguration?: ConversationReferenceConfiguration | null;
  canConfigureReference?: boolean;
  onReferenceConfigurationChange?: (configuration: ConversationReferenceConfiguration) => void;
  presetRequest?: () => { id: AutomaticReplyPresetId; nonce: number } | null;
  onPresetRequestHandled?: (nonce: number) => void;
  showHeader?: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const [configurations, setConfigurations] = createSignal(props.initialConfigurations);
  const automationIdentities = () => props.identities.filter(isAutomationIdentity);
  const activeConfiguration = () => configurations().find((configuration) => configuration.enabled) ?? null;
  const replace = (configuration: AutomaticReplyConfiguration) => {
    const current = configurations();
    const next = current.some((item) => item.id === configuration.id)
      ? current.map((item) => (item.id === configuration.id ? configuration : item))
      : [...current, configuration];
    setConfigurations(next);
    props.onConfigurationsChange?.(next);
  };
  const open = async (configuration: AutomaticReplyConfiguration | null = null, requestedPreset: AutomaticReplyPreset | null = null) => {
    const preset = configuration
      ? null
      : (requestedPreset ??
        (await dialogCore.open<AutomaticReplyPreset | null>(
          (close) => (
            <AutomaticReplyPresetPicker
              referenceConfigured={Boolean(props.referenceConfiguration?.enabled)}
              canConfigureReference={props.canConfigureReference ?? false}
              close={close}
            />
          ),
          panelDialogOptions,
        )));
    if (!configuration && !preset) return;
    await dialogCore.open<void>(
      (close) => (
        <AutomaticReplyEditor
          mailboxId={props.mailboxId}
          configuration={configuration}
          preset={preset ?? null}
          identities={props.identities}
          canEnable={!activeConfiguration() || activeConfiguration()?.id === configuration?.id}
          referenceConfiguration={props.referenceConfiguration ?? null}
          canConfigureReference={props.canConfigureReference ?? false}
          onReferenceConfigurationChange={props.onReferenceConfigurationChange}
          close={() => close()}
          onSaved={replace}
        />
      ),
      panelDialogWorkspaceOptions,
    );
  };
  let handledPresetRequest = 0;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  createEffect(() => {
    const request = props.presetRequest?.();
    if (!request || request.nonce === handledPresetRequest) return;
    handledPresetRequest = request.nonce;
    void (async () => {
      await waitForMailPageTransition();
      if (disposed) return;
      props.onPresetRequestHandled?.(request.nonce);
      if (automationIdentities().length === 0) return;
      const preset = automaticReplyPresets(locale()).find((candidate) => candidate.id === request.id);
      if (preset) await open(null, preset);
    })();
  });

  return (
    <section>
      <div class="mb-2 flex items-start justify-between gap-3">
        <Show when={props.showHeader !== false}>
          <div>
            <h3 class="text-sm font-semibold text-primary">{messages().automaticReplies}</h3>
            <p class="mt-0.5 text-xs text-dimmed">{messages().automaticRepliesDescription}</p>
          </div>
        </Show>
        <Show when={props.showHeader === false}>
          <span />
        </Show>
        <Show when={props.canManage !== false}>
          <Button size="sm" type="button" class="shrink-0" disabled={automationIdentities().length === 0} onClick={() => void open()}>
            <i class="ti ti-plus" aria-hidden="true" /> {messages().addAutomaticReply}
          </Button>
        </Show>
      </div>
      <Show when={automationIdentities().length === 0}>
        <div class="mb-2">
          <Placeholder
            title={messages().automaticRepliesNeedSender}
            description={configurations().length > 0 ? messages().existingRepliesNeedSender : messages().newRepliesNeedSender}
            icon="ti ti-mail-off"
            action={
              props.onManageIdentities ? (
                <Button variant="secondary" size="sm" type="button" onClick={props.onManageIdentities}>
                  <i class="ti ti-at" aria-hidden="true" /> {messages().manageIdentities}
                </Button>
              ) : undefined
            }
          />
        </div>
      </Show>
      <Show
        when={configurations().length > 0}
        fallback={
          <Placeholder
            title={messages().noAutomaticReplies}
            description={messages().noAutomaticRepliesDescription}
            icon="ti ti-message-cog"
          />
        }
      >
        <div class="flex flex-col gap-2">
          <For each={configurations()}>
            {(configuration) => (
              <div class="flex items-center gap-3 py-2">
                <i class="ti ti-message-cog text-dimmed" aria-hidden="true" />
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium text-primary">{configuration.name}</p>
                  <p class="truncate text-xs text-dimmed">{responseScheduleSummary(configuration.schedule, locale())}</p>
                </div>
                <StatusBadge
                  tone={configuration.enabled ? "ok" : "neutral"}
                  label={configuration.enabled ? messages().enabled : messages().disabled}
                />
                <Show when={props.canManage !== false}>
                  <IconButton
                    type="button"
                    label={messages().editNamed({ name: configuration.name })}
                    onClick={() => void open(configuration)}
                  >
                    <i class="ti ti-pencil" aria-hidden="true" />
                  </IconButton>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}
