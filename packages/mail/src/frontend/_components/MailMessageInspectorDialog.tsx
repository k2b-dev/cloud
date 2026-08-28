import { query } from "@k2b/stdlib/solid";
import {
  Button,
  ButtonLink,
  dialogCore,
  formatFileViewSize,
  IconButtonLink,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogWorkspaceOptions,
  Select,
  Tooltip,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import { apiClient } from "../../api/client";
import { type MessageInspector, type MessageSourcePreview, messageInspectorSchema, messageSourcePreviewSchema } from "../../contracts";
import type { MessageDetail } from "../../service/messages";
import { readApiError } from "./api-response";
import { mailRemainingMessages } from "./mail-remaining-messages";

type InspectorTab = "overview" | "headers" | "source";

const sourceHref = (mailboxId: string, messageId: string): string => `/api/mail/mailboxes/${mailboxId}/messages/${messageId}/source`;

const subscriptionsHref = (mailboxId: string, listKey: string): string =>
  `/app/mail/${mailboxId}?mailingList=${encodeURIComponent(listKey)}`;

function MailMessageInspectorDialog(props: {
  mailboxId: string;
  messages: MessageDetail[];
  initialMessageId: string;
  initialTab: InspectorTab;
  close: () => void;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailRemainingMessages.resolve([locale()]).t);
  const inspectorTabs = createMemo(
    () =>
      [
        { value: "overview", label: messages().overview, icon: "ti ti-info-circle" },
        { value: "headers", label: messages().headers, icon: "ti ti-list-details" },
        { value: "source", label: messages().source, icon: "ti ti-code" },
      ] as const,
  );
  const messageOptionLabel = (message: MessageDetail, index: number): string =>
    `${index + 1}. ${message.subject.trim() || messages().noSubject}`;
  const [selectedMessageId, setSelectedMessageId] = createSignal(props.initialMessageId);
  const [tab, setTab] = createSignal<InspectorTab>(props.initialTab);
  const inspector = query.create<string, MessageInspector>({
    source: selectedMessageId,
    load: async (messageId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"].inspector.$get(
        { param: { mailboxId: props.mailboxId, messageId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotInspectMessage));
      return messageInspectorSchema.parse(await response.json());
    },
  });
  const currentInspector = () => {
    const value = inspector.data();
    return value?.id === selectedMessageId() ? value : undefined;
  };

  const sourcePreview = query.create<string, MessageSourcePreview>({
    source: selectedMessageId,
    enabled: () => tab() === "source" && Boolean(currentInspector()?.source.available),
    load: async (messageId, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].messages[":messageId"]["source-preview"].$get(
        { param: { mailboxId: props.mailboxId, messageId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().couldNotLoadMessageSource));
      return messageSourcePreviewSchema.parse(await response.json());
    },
  });
  const currentSourcePreview = () => {
    const value = sourcePreview.data();
    return value?.messageId === selectedMessageId() ? value : undefined;
  };

  const selectedMessage = () => props.messages.find((message) => message.id === selectedMessageId()) ?? props.messages.at(-1);
  const downloadName = () => `${selectedMessage()?.subject.trim() || "message"}.eml`;

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().messageInspector}
        subtitle={messages().messageInspectorDescription}
        icon="ti ti-file-search"
        actions={
          <Show when={currentInspector()?.source.available}>
            <Tooltip.Anchor content={messages().downloadOriginalMessage}>
              <IconButtonLink
                href={sourceHref(props.mailboxId, selectedMessageId())}
                download={downloadName()}
                label={messages().downloadOriginalMessage}
              >
                <i class="ti ti-download" aria-hidden="true" />
                <span class="sr-only">{messages().downloadOriginalMessage}</span>
              </IconButtonLink>
            </Tooltip.Anchor>
          </Show>
        }
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey={`mail-message-inspector:${selectedMessageId()}:${tab()}`}>
        <div class="flex min-h-full flex-col gap-2">
          <Show when={props.messages.length > 1}>
            <Select
              label={messages().message}
              icon="ti ti-mail"
              value={selectedMessageId}
              options={props.messages.map((message, index) => ({
                id: message.id,
                label: messageOptionLabel(message, index),
                description: message.from.map((address) => address.name || address.address).join(", ") || messages().unknownSender,
              }))}
              onValueChange={setSelectedMessageId}
            />
          </Show>
          <PanelDialog.Tabs options={inspectorTabs()} value={tab} onValueChange={setTab} ariaLabel={messages().messageInspectionView} />

          <Show
            when={currentInspector()}
            fallback={
              <Show
                when={inspector.error()}
                fallback={<Placeholder state="loading" variant="panel" title={messages().loadingMessageDetails} />}
              >
                {(error) => (
                  <Placeholder
                    state="error"
                    variant="panel"
                    title={messages().couldNotInspectMessage}
                    description={error().message}
                    action={
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        disabled={inspector.refreshing()}
                        onClick={() => void inspector.refresh()}
                      >
                        <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
                      </Button>
                    }
                  />
                )}
              </Show>
            }
          >
            {(current) => (
              <>
                <Show when={current().warnings.length > 0}>
                  <NoticeCard tone="warning" icon={false} bodyClass="flex flex-col gap-1" role="status">
                    <For each={current().warnings}>{(warning) => <p>{warning}</p>}</For>
                  </NoticeCard>
                </Show>

                <Show when={tab() === "overview"}>
                  <div class="grid gap-2 lg:grid-cols-2">
                    <section class="detail-section">
                      <p class="detail-section-label">{messages().message}</p>
                      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                        <dt class="text-dimmed">{messages().messageId}</dt>
                        <dd class="break-all font-mono text-secondary">{current().messageId ?? messages().unavailable}</dd>
                        <dt class="text-dimmed">{messages().inReplyTo}</dt>
                        <dd class="break-all font-mono text-secondary">{current().inReplyTo ?? messages().none}</dd>
                        <dt class="text-dimmed">{messages().received}</dt>
                        <dd class="text-primary">{new Date(current().internalDate).toLocaleString(locale())}</dd>
                        <dt class="text-dimmed">{messages().sent}</dt>
                        <dd class="text-primary">
                          {current().sentAt ? new Date(current().sentAt ?? "").toLocaleString(locale()) : messages().unavailable}
                        </dd>
                        <dt class="text-dimmed">{messages().size}</dt>
                        <dd class="text-primary">{formatFileViewSize(current().sizeBytes)}</dd>
                        <dt class="text-dimmed">{messages().contentType}</dt>
                        <dd class="break-all text-primary">{current().contentType ?? messages().unavailable}</dd>
                        <dt class="text-dimmed">{messages().hydration}</dt>
                        <dd class="text-primary">{current().hydrationStatus}</dd>
                      </dl>
                    </section>

                    <section class="detail-section">
                      <p class="detail-section-label">{messages().storedSource}</p>
                      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                        <dt class="text-dimmed">{messages().available}</dt>
                        <dd class="text-primary">{current().source.available ? messages().exactOriginal : messages().no}</dd>
                        <dt class="text-dimmed">{messages().size}</dt>
                        <dd class="text-primary">
                          {current().source.byteLength === null ? messages().unavailable : formatFileViewSize(current().source.byteLength!)}
                        </dd>
                        <dt class="text-dimmed">{messages().mimeParts}</dt>
                        <dd class="text-primary">{current().parts.length}</dd>
                        <dt class="text-dimmed">{messages().attachments}</dt>
                        <dd class="text-primary">{current().attachments.length}</dd>
                        <dt class="text-dimmed">{messages().placements}</dt>
                        <dd class="text-primary">{current().placements.length}</dd>
                      </dl>
                      <Show when={current().source.available}>
                        <ButtonLink
                          variant="secondary"
                          size="sm"
                          class="mt-3 inline-flex"
                          href={sourceHref(props.mailboxId, current().id)}
                          download={downloadName()}
                        >
                          <i class="ti ti-download" aria-hidden="true" /> {messages().downloadEml}
                        </ButtonLink>
                      </Show>
                    </section>
                  </div>

                  <Show when={current().mailingList}>
                    {(list) => (
                      <section class="detail-section">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                          <div class="min-w-0">
                            <p class="detail-section-label">{messages().mailingList}</p>
                            <p class="truncate text-sm font-medium text-primary">{list().name}</p>
                            <Show when={list().name.toLowerCase() !== list().address.toLowerCase()}>
                              <p class="truncate text-xs text-dimmed">{list().address}</p>
                            </Show>
                          </div>
                          <ButtonLink variant="secondary" size="sm" href={subscriptionsHref(props.mailboxId, list().listKey)}>
                            <i class="ti ti-settings" aria-hidden="true" />
                            {messages().manageSubscription}
                          </ButtonLink>
                        </div>
                        <div class="mt-3 flex flex-wrap items-center gap-2">
                          <Show when={list().postHref}>
                            <ButtonLink variant="ghost" size="sm" href={list().postHref!}>
                              <i class="ti ti-send" aria-hidden="true" />
                              {messages().writeToList}
                            </ButtonLink>
                          </Show>
                          <Show when={list().archiveHref}>
                            <ButtonLink variant="ghost" size="sm" href={list().archiveHref!} target="_blank" rel="noopener noreferrer">
                              <i class="ti ti-world" aria-hidden="true" />
                              {messages().listArchive}
                            </ButtonLink>
                          </Show>
                        </div>
                      </section>
                    )}
                  </Show>

                  <Show when={current().spam.flag || current().spam.status || current().spam.score}>
                    <section class="detail-section">
                      <p class="detail-section-label">{messages().spamDiagnostics}</p>
                      <p class="mb-3 text-xs text-dimmed">{messages().spamDiagnosticsDescription}</p>
                      <dl class="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                        <dt class="text-dimmed">{messages().flag}</dt>
                        <dd class="break-all text-primary">{current().spam.flag ?? messages().unavailable}</dd>
                        <dt class="text-dimmed">{messages().status}</dt>
                        <dd class="break-all text-primary">{current().spam.status ?? messages().unavailable}</dd>
                        <dt class="text-dimmed">{messages().score}</dt>
                        <dd class="break-all text-primary">{current().spam.score ?? messages().unavailable}</dd>
                      </dl>
                    </section>
                  </Show>

                  <Show when={current().placements.length > 0}>
                    <section class="detail-section">
                      <p class="detail-section-label">{messages().providerPlacements}</p>
                      <div class="overflow-x-auto">
                        <table class="w-full min-w-[36rem] border-separate border-spacing-x-3 border-spacing-y-1 text-left text-xs">
                          <thead>
                            <tr>
                              <th>{messages().folder}</th>
                              <th>UID</th>
                              <th>{messages().uidValidity}</th>
                              <th>{messages().flags}</th>
                              <th>{messages().providerKeywords}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={current().placements}>
                              {(placement) => (
                                <tr>
                                  <td title={placement.remotePath}>{placement.folderName}</td>
                                  <td class="font-mono">{placement.uid}</td>
                                  <td class="font-mono">{placement.uidValidity}</td>
                                  <td>{placement.flags.join(", ") || messages().none}</td>
                                  <td>{placement.keywords.join(", ") || messages().none}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </Show>

                  <Show when={current().parts.length > 0}>
                    <section class="detail-section">
                      <p class="detail-section-label">{messages().mimeParts}</p>
                      <div class="overflow-x-auto">
                        <table class="w-full min-w-[42rem] border-separate border-spacing-x-3 border-spacing-y-1 text-left text-xs">
                          <thead>
                            <tr>
                              <th>{messages().part}</th>
                              <th>{messages().type}</th>
                              <th>{messages().disposition}</th>
                              <th>{messages().size}</th>
                              <th>{messages().state}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={current().parts}>
                              {(part) => (
                                <tr>
                                  <td class="font-mono">{part.partPath}</td>
                                  <td>{part.contentType}</td>
                                  <td>{part.disposition ?? messages().inline}</td>
                                  <td>{formatFileViewSize(part.sizeBytes)}</td>
                                  <td>{part.hydrationStatus}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </section>
                  </Show>
                </Show>

                <Show when={tab() === "headers"}>
                  <section class="detail-section">
                    <div class="mb-3 flex items-center justify-between gap-2">
                      <p class="detail-section-label mb-0">{messages().allHeaders}</p>
                      <span class="text-xs text-dimmed">{messages().headerFields({ count: current().headers.length })}</span>
                    </div>
                    <Show
                      when={current().headers.length > 0}
                      fallback={<Placeholder state="empty" variant="compact" title={messages().noExactHeaders} />}
                    >
                      <dl class="grid grid-cols-[minmax(7rem,12rem)_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                        <For each={current().headers}>
                          {(header) => (
                            <>
                              <dt class="break-all font-medium text-primary">{header.name}</dt>
                              <dd class="break-all font-mono text-secondary">{header.value}</dd>
                            </>
                          )}
                        </For>
                      </dl>
                    </Show>
                    <Show when={current().rawHeaders}>
                      <details class="mt-4">
                        <summary class="cursor-pointer text-xs font-medium text-secondary">{messages().rawHeaderBlock}</summary>
                        <pre class="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 font-mono text-xs text-secondary">
                          {current().rawHeaders}
                        </pre>
                      </details>
                    </Show>
                  </section>
                </Show>

                <Show when={tab() === "source"}>
                  <Show
                    when={current().source.available}
                    fallback={
                      <Placeholder
                        state="empty"
                        variant="panel"
                        title={messages().originalSourceUnavailable}
                        description={messages().originalSourceUnavailableDescription}
                      />
                    }
                  >
                    <Show
                      when={currentSourcePreview()}
                      fallback={
                        <Show
                          when={sourcePreview.error()}
                          fallback={<Placeholder state="loading" variant="panel" title={messages().loadingSourcePreview} />}
                        >
                          {(error) => (
                            <Placeholder
                              state="error"
                              variant="panel"
                              title={messages().couldNotLoadSourcePreview}
                              description={error().message}
                              action={
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  type="button"
                                  disabled={sourcePreview.refreshing()}
                                  onClick={() => void sourcePreview.refresh()}
                                >
                                  <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
                                </Button>
                              }
                            />
                          )}
                        </Show>
                      }
                    >
                      {(preview) => (
                        <section class="detail-section">
                          <div class="mb-3 flex items-center justify-between gap-2">
                            <div>
                              <p class="detail-section-label mb-0">{messages().exactMessageSource}</p>
                              <p class="text-xs text-dimmed">
                                {messages().showingBytes({
                                  shown: formatFileViewSize(preview().previewByteLength),
                                  total: formatFileViewSize(preview().byteLength),
                                })}
                              </p>
                            </div>
                            <ButtonLink
                              variant="secondary"
                              size="sm"
                              href={sourceHref(props.mailboxId, current().id)}
                              download={downloadName()}
                            >
                              <i class="ti ti-download" aria-hidden="true" /> {messages().downloadEml}
                            </ButtonLink>
                          </div>
                          <Show when={preview().truncated}>
                            <NoticeCard tone="neutral" icon={false} class="mb-3">
                              {messages().sourcePreviewLimited}
                            </NoticeCard>
                          </Show>
                          <pre class="max-h-[32rem] overflow-auto whitespace-pre-wrap break-all rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-3 font-mono text-xs text-secondary">
                            {preview().text}
                          </pre>
                        </section>
                      )}
                    </Show>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </div>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openMailMessageInspector = (params: {
  mailboxId: string;
  messages: MessageDetail[];
  initialMessageId: string;
  initialTab?: InspectorTab;
}) =>
  dialogCore.open<void>(
    (close) => (
      <MailMessageInspectorDialog
        mailboxId={params.mailboxId}
        messages={params.messages}
        initialMessageId={params.initialMessageId}
        initialTab={params.initialTab ?? "overview"}
        close={() => close()}
      />
    ),
    panelDialogWorkspaceOptions,
  );
