import { type LinkNavigateEvent, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Placeholder, prompts, ScrollArea, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { CancelScheduledSendInput, CancelScheduledSendResult, ScheduledSendPage } from "../../contracts";
import { readApiError } from "./api-response";
import { mailDraftHref } from "./mail-compose-route";
import { mailConversationUiMessages } from "./mail-conversation-ui-messages";

const recipients = (item: ScheduledSendPage["items"][number], t: ReturnType<typeof mailConversationUiMessages.resolve>["t"]): string => {
  const all = [...item.to, ...item.cc, ...item.bcc];
  if (all.length === 0) return t.noRecipients;
  const first = all[0]!;
  const label = first.name || first.address;
  return all.length === 1 ? label : t.moreRecipients({ first: label, count: all.length - 1 });
};

const chooseDisposition = (t: ReturnType<typeof mailConversationUiMessages.resolve>["t"]) =>
  prompts.dialog<CancelScheduledSendInput["disposition"] | null>(
    (close) => (
      <div class="flex flex-col gap-4">
        <p class="text-sm text-secondary">{t.cancelScheduledDescription}</p>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
            {t.keepScheduled}
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={() => close("discard")}>
            <i class="ti ti-trash" aria-hidden="true" /> {t.discardMessage}
          </Button>
          <Button size="sm" type="button" onClick={() => close("draft")}>
            <i class="ti ti-file-pencil" aria-hidden="true" /> {t.keepAsDraft}
          </Button>
        </div>
      </div>
    ),
    { title: t.cancelScheduledTitle, icon: "ti ti-calendar-cancel", size: "medium" },
  );

export default function MailScheduledView(props: {
  mailboxId: string;
  page: ScheduledSendPage;
  error: string | null;
  dateConfig: DateContext;
  canWrite: boolean;
  loading: boolean;
  onNavigate: (event: LinkNavigateEvent) => void | Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const locale = useLocale();
  const t = createMemo(() => mailConversationUiMessages.resolve([locale()]).t);
  const [cancellingId, setCancellingId] = createSignal<string | null>(null);
  const cancel = mutation.create<
    {
      result: CancelScheduledSendResult;
      disposition: CancelScheduledSendInput["disposition"];
      refreshError: Error | null;
    } | null,
    string
  >({
    onBefore: (scheduledSendId) => setCancellingId(scheduledSendId),
    mutation: async (scheduledSendId, { abortSignal }) => {
      const disposition = await chooseDisposition(t());
      if (!disposition || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"].cancel.$post(
        {
          param: { mailboxId: props.mailboxId, scheduledSendId },
          json: { disposition },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, t().cancelScheduledFailed));
      const result: CancelScheduledSendResult = await response.json();
      let refreshError: Error | null = null;
      if (result.disposition !== "draft") {
        try {
          await props.onRefresh();
        } catch (error) {
          refreshError = error instanceof Error ? error : new Error(String(error));
        }
      }
      return { result, disposition, refreshError };
    },
    onSuccess: (value) => {
      if (!value) return;
      const { result, disposition, refreshError } = value;
      toast.success(disposition === "draft" ? t().cancelledDraftRestored : t().scheduledDiscarded);
      if (result.disposition === "draft") {
        navigateTo(mailDraftHref(props.mailboxId, result.draftId, `/app/mail/${props.mailboxId}?scheduled=1`));
        return;
      }
      if (refreshError) {
        void prompts.error(refreshError.message, { title: t().cancelledRefreshFailed });
      }
    },
    onError: (error) => prompts.error(error.message),
    onFinally: () => setCancellingId(null),
  });
  onCleanup(cancel.abort);

  return (
    <section class="flex h-full min-h-0 flex-1 flex-col overflow-hidden" aria-busy={props.loading}>
      <header class="flex shrink-0 items-center gap-3 px-4 py-3">
        <span class="flex h-8 w-8 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
          <i class="ti ti-calendar-time" aria-hidden="true" />
        </span>
        <div class="min-w-0 flex-1">
          <h1 class="text-base font-semibold text-primary">{t().scheduled}</h1>
          <p class="text-xs text-dimmed">{t().waitingForDelivery({ count: props.page.total })}</p>
        </div>
      </header>
      <ScrollArea class="flex-1 p-3">
        <Show
          when={!props.error}
          fallback={<Placeholder icon="ti ti-alert-circle" title={t().scheduledUnavailable} description={props.error!} />}
        >
          <Show
            when={props.page.items.length > 0}
            fallback={<Placeholder icon="ti ti-calendar-check" title={t().noScheduled} description={t().noScheduledDescription} />}
          >
            <div class="flex flex-col gap-2">
              <For each={props.page.items}>
                {(item) => (
                  <article class="paper flex min-w-0 items-start gap-3 p-3">
                    <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] text-secondary">
                      <i class="ti ti-clock" aria-hidden="true" />
                    </span>
                    <div class="min-w-0 flex-1">
                      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{item.subject || t().noSubject}</h2>
                        <time class="shrink-0 text-sm font-medium text-primary" dateTime={item.scheduledAt}>
                          {dates.formatDateTime(item.scheduledAt, props.dateConfig)}
                        </time>
                      </div>
                      <p class="mt-0.5 truncate text-xs text-secondary">
                        {t().to} {recipients(item, t())}
                      </p>
                      <p class="mt-2 line-clamp-2 text-sm leading-5 text-secondary">{item.bodyPreview || t().noMessageBody}</p>
                      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dimmed">
                        <span>
                          <i class="ti ti-user mr-1" aria-hidden="true" />
                          {t().scheduledBy({ name: item.scheduledBy.displayName })}
                        </span>
                        <span title={dates.formatDateTime(item.createdAt, props.dateConfig)}>
                          {t().created({ value: dates.formatDateTimeRelative(item.createdAt, props.dateConfig) })}
                        </span>
                        <Show when={item.lastError}>
                          {(error) => (
                            <span class="text-red-600" title={error()}>
                              <i class="ti ti-alert-circle mr-1" aria-hidden="true" />
                              {item.nextAttemptAt
                                ? t().retryAt({ value: dates.formatDateTime(item.nextAttemptAt, props.dateConfig) })
                                : t().retryPending}
                            </span>
                          )}
                        </Show>
                      </div>
                    </div>
                    <Show when={props.canWrite}>
                      <Button
                        variant="secondary"
                        size="sm"
                        type="button"
                        class="shrink-0"
                        disabled={Boolean(cancellingId())}
                        onClick={() => void cancel.mutate(item.id)}
                      >
                        <i
                          class={`ti ${cancellingId() === item.id ? "ti-loader-2 animate-spin" : "ti-calendar-cancel"}`}
                          aria-hidden="true"
                        />
                        {t().cancel}
                      </Button>
                    </Show>
                  </article>
                )}
              </For>
              <Show when={props.page.nextCursor}>
                {(cursor) => (
                  <ButtonLink
                    href={`/app/mail/${props.mailboxId}?scheduled=1&cursor=${encodeURIComponent(cursor())}`}
                    variant="secondary"
                    size="sm"
                    class="self-center"
                    navigation="enhanced"
                    onNavigate={props.onNavigate}
                    scroll="preserve"
                  >
                    {t().loadMore}
                  </ButtonLink>
                )}
              </Show>
            </div>
          </Show>
        </Show>
      </ScrollArea>
    </section>
  );
}
