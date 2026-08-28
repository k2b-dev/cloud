import { mutation, query, timed } from "@k2b/stdlib/solid";
import { Button, dialogCore, PanelDialog, panelDialogOptions, prompts, Switch, TextInput, toast, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import {
  type ConversationReferencePreview,
  DEFAULT_CONVERSATION_REFERENCE_PATTERN,
  type PutConversationReferenceConfiguration,
} from "../../contracts";
import type { ConversationReferenceConfiguration } from "../../service/conversation-reference";
import { readApiError } from "./api-response";
import MailTemplateHelpDisclosure, { MailTemplateToken } from "./MailTemplateHelpDisclosure";
import { mailSettingsMessages } from "./mail-settings-messages";

type MailReferenceConfigurationDraft = PutConversationReferenceConfiguration;

export const referenceConfigurationDraft = (configuration: ConversationReferenceConfiguration | null): MailReferenceConfigurationDraft => ({
  expectedRevision: configuration?.revision ?? null,
  pattern: configuration?.pattern ?? DEFAULT_CONVERSATION_REFERENCE_PATTERN,
  enabled: configuration?.enabled ?? true,
  includeInReplySubjects: configuration?.includeInReplySubjects ?? true,
});

export function MailReferenceConfigurationFields(props: {
  mailboxId: string;
  value: () => MailReferenceConfigurationDraft;
  onChange: (value: MailReferenceConfigurationDraft) => void;
  compact?: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const update = <K extends keyof MailReferenceConfigurationDraft>(key: K, value: MailReferenceConfigurationDraft[K]) =>
    props.onChange({ ...props.value(), [key]: value });
  const [previewSource, setPreviewSource] = createSignal(props.value().pattern.trim());
  const previewQuery = query.create<string, { pattern: string; preview: ConversationReferencePreview }>({
    source: previewSource,
    enabled: () => Boolean(previewSource()),
    load: async (pattern, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["reference-number-configuration"].preview.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: { pattern },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().referencePreviewFailed));
      return { pattern, preview: await response.json() };
    },
  });
  const previewDebounce = timed.debounce(setPreviewSource, 200);
  const preview = () => {
    const current = previewQuery.data();
    return current?.pattern === props.value().pattern.trim() ? current.preview : null;
  };
  const previewPending = () => previewDebounce.isPending() || previewQuery.loading() || previewQuery.refreshing();
  createEffect(() => {
    const pattern = props.value().pattern.trim();
    previewDebounce.debouncedFn(pattern);
  });

  return (
    <div class="flex flex-col gap-3">
      <TextInput
        label={messages().numberFormat}
        description={messages().numberFormatDescription}
        value={() => props.value().pattern}
        onValueChange={(value) => update("pattern", value)}
        monospace
        required
      />
      <MailTemplateHelpDisclosure title={messages().formatPlaceholders}>
        <div class="flex flex-col gap-3 text-xs">
          <section class="flex flex-col gap-1.5">
            <h4 class="font-semibold text-primary">{messages().recommended}</h4>
            <p class="flex flex-wrap items-center gap-1.5">
              <MailTemplateToken value="{{ short_id }}" />
              <span>{messages().shortIdDescription}</span>
            </p>
          </section>
          <div class="grid gap-3 sm:grid-cols-2">
            <section class="flex flex-col gap-1.5">
              <h4 class="font-semibold text-primary">{messages().otherIdentifiers}</h4>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ uuid }}" />
                <span>{messages().uuidDescription}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ uuid_v7 }}" />
                <span>{messages().uuidV7Description}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ ulid }}" />
                <span>{messages().ulidDescription}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ sequence }}" />
                <span>{messages().sequenceDescription}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ sequence | pad_start: 6 }}" />
                <span>{messages().paddedSequenceDescription}</span>
              </p>
            </section>
            <section class="flex flex-col gap-1.5">
              <h4 class="font-semibold text-primary">{messages().allocationDateUtc}</h4>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ year }}" />
                <span>{messages().fourDigitYear}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ month }}" />
                <span>{messages().twoDigitMonth}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ month_name }}" />
                <span>{messages().englishMonthName}</span>
              </p>
              <p class="flex flex-wrap items-center gap-1.5">
                <MailTemplateToken value="{{ day }}" />
                <span>{messages().twoDigitDay}</span>
              </p>
            </section>
          </div>
        </div>
      </MailTemplateHelpDisclosure>
      <p class="flex items-center gap-2 text-xs text-dimmed">
        <i class={`ti ${previewPending() ? "ti-loader-2 animate-spin" : "ti-eye"} shrink-0`} aria-hidden="true" />
        <Show
          when={preview()}
          fallback={
            <span>{previewPending() ? messages().renderingPreview : (previewQuery.error()?.message ?? messages().enterValidFormat)}</span>
          }
        >
          {(value) => (
            <>
              {messages().preview}: <code>{value().value}</code>
            </>
          )}
        </Show>
      </p>
      <Show when={!props.compact}>
        <Switch
          label={messages().allowAutomationReferences}
          value={() => props.value().enabled}
          onValueChange={(value) => update("enabled", value)}
        />
        <p class="-mt-2 text-xs text-dimmed">{messages().disableAllocationsDescription}</p>
        <Switch
          label={messages().includeReferenceInReplies}
          value={() => props.value().includeInReplySubjects}
          onValueChange={(value) => update("includeInReplySubjects", value)}
        />
        <p class="-mt-2 text-xs text-dimmed">{messages().replyReferenceDescription}</p>
      </Show>
    </div>
  );
}

export function MailReferenceConfigurationForm(props: {
  mailboxId: string;
  configuration: ConversationReferenceConfiguration | null;
  onSaved: (configuration: ConversationReferenceConfiguration) => void;
  compact?: boolean;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [draft, setDraft] = createSignal(referenceConfigurationDraft(props.configuration));
  const save = mutation.create<ConversationReferenceConfiguration, void>({
    mutation: async (_input, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"]["reference-number-configuration"].$put(
        {
          param: { mailboxId: props.mailboxId },
          json: {
            ...draft(),
            pattern: draft().pattern.trim(),
            enabled: props.compact ? true : draft().enabled,
          },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveReferenceSettings));
      return response.json();
    },
    onSuccess: (configuration) => {
      props.onSaved(configuration);
      toast.success(messages().referenceSettingsSaved);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => save.abort());

  return (
    <div class="flex flex-col gap-3">
      <MailReferenceConfigurationFields mailboxId={props.mailboxId} value={draft} onChange={setDraft} compact={props.compact} />
      <div class="flex justify-end">
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={save.loading() || !draft().pattern.trim()}
          onClick={() => save.mutate()}
        >
          <i class={`ti ${save.loading() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
          {messages().saveReferenceFormat}
        </Button>
      </div>
    </div>
  );
}

function ReferenceConfigurationEditor(props: {
  mailboxId: string;
  configuration: ConversationReferenceConfiguration | null;
  close: () => void;
  onSaved: (configuration: ConversationReferenceConfiguration) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().referenceNumbers}
        subtitle={messages().referenceNumbersSubtitle}
        icon="ti ti-hash"
        close={props.close}
      />
      <PanelDialog.Body>
        <PanelDialog.Section title={messages().numberFormat} subtitle={messages().referenceNumberRule} icon="ti ti-hash">
          <MailReferenceConfigurationForm
            mailboxId={props.mailboxId}
            configuration={props.configuration}
            onSaved={(configuration) => {
              props.onSaved(configuration);
              props.close();
            }}
          />
        </PanelDialog.Section>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export function MailReferenceConfigurationCard(props: {
  mailboxId: string;
  configuration: ConversationReferenceConfiguration | null;
  onConfigurationChange: (configuration: ConversationReferenceConfiguration) => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const openEditor = () =>
    dialogCore.open<void>(
      (close) => (
        <ReferenceConfigurationEditor
          mailboxId={props.mailboxId}
          configuration={props.configuration}
          close={() => close()}
          onSaved={props.onConfigurationChange}
        />
      ),
      panelDialogOptions,
    );
  return (
    <section class="paper p-4">
      <div class="flex flex-wrap items-start gap-3">
        <span class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center">
          <i class="ti ti-hash" aria-hidden="true" />
        </span>
        <div class="min-w-64 flex-1">
          <h2 class="text-sm font-semibold text-primary">
            {props.configuration?.enabled ? messages().referenceNumbersAvailable : messages().referenceNumbersNotConfigured}
          </h2>
          <p class="mt-0.5 text-xs text-dimmed">
            {props.configuration
              ? messages().referencePattern({ pattern: props.configuration.pattern })
              : messages().configureReferenceDescription}
          </p>
        </div>
        <Button variant="secondary" size="sm" type="button" class="shrink-0" onClick={() => void openEditor()}>
          <i class="ti ti-settings" aria-hidden="true" /> {props.configuration ? messages().configure : messages().setUp}
        </Button>
      </div>
    </section>
  );
}
