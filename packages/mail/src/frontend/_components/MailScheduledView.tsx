import { type LinkNavigateEvent, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { mutation } from "@k2b/stdlib/solid";
import { Button, ButtonLink, Placeholder, prompts, ScrollArea, toast } from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { CancelScheduledSendInput, CancelScheduledSendResult, ScheduledSendPage } from "../../contracts";
import { readApiError } from "./api-response";
import { mailDraftHref } from "./mail-compose-route";

const recipients = (item: ScheduledSendPage["items"][number]): string => {
  const all = [...item.to, ...item.cc, ...item.bcc];
  if (all.length === 0) return "No recipients";
  const first = all[0]!;
  const label = first.name || first.address;
  return all.length === 1 ? label : `${label} and ${all.length - 1} more`;
};

const chooseDisposition = () =>
  prompts.dialog<CancelScheduledSendInput["disposition"] | null>(
    (close) => (
      <div class="flex flex-col gap-4">
        <p class="text-sm text-secondary">
          The scheduled delivery will be stopped immediately. Keep the message as a shared draft to edit it later, or discard it.
        </p>
        <div class="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => close(null)}>
            Keep scheduled
          </Button>
          <Button variant="danger" size="sm" type="button" onClick={() => close("discard")}>
            <i class="ti ti-trash" aria-hidden="true" /> Discard message
          </Button>
          <Button size="sm" type="button" onClick={() => close("draft")}>
            <i class="ti ti-file-pencil" aria-hidden="true" /> Keep as draft
          </Button>
        </div>
      </div>
    ),
    { title: "Cancel scheduled delivery?", icon: "ti ti-calendar-cancel", size: "medium" },
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
      const disposition = await chooseDisposition();
      if (!disposition || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"]["scheduled-sends"][":scheduledSendId"].cancel.$post(
        {
          param: { mailboxId: props.mailboxId, scheduledSendId },
          json: { disposition },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to cancel scheduled delivery"));
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
      toast.success(disposition === "draft" ? "Scheduled delivery cancelled; draft restored" : "Scheduled message discarded");
      if (result.disposition === "draft") {
        navigateTo(mailDraftHref(props.mailboxId, result.draftId, `/app/mail/${props.mailboxId}?scheduled=1`));
        return;
      }
      if (refreshError) {
        void prompts.error(refreshError.message, { title: "Delivery cancelled, but Scheduled could not be refreshed" });
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
          <h1 class="text-base font-semibold text-primary">Scheduled</h1>
          <p class="text-xs text-dimmed">
            {props.page.total === 1 ? "1 message waiting for delivery" : `${props.page.total} messages waiting for delivery`}
          </p>
        </div>
      </header>
      <ScrollArea class="flex-1 p-3">
        <Show
          when={!props.error}
          fallback={<Placeholder icon="ti ti-alert-circle" title="Scheduled messages unavailable" description={props.error!} />}
        >
          <Show
            when={props.page.items.length > 0}
            fallback={
              <Placeholder
                icon="ti ti-calendar-check"
                title="No scheduled messages"
                description="Messages scheduled from the composer will appear here until delivery."
              />
            }
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
                        <h2 class="min-w-0 flex-1 truncate text-sm font-semibold text-primary">{item.subject || "(no subject)"}</h2>
                        <time class="shrink-0 text-sm font-medium text-primary" dateTime={item.scheduledAt}>
                          {dates.formatDateTime(item.scheduledAt, props.dateConfig)}
                        </time>
                      </div>
                      <p class="mt-0.5 truncate text-xs text-secondary">To {recipients(item)}</p>
                      <p class="mt-2 line-clamp-2 text-sm leading-5 text-secondary">{item.bodyPreview || "No message body"}</p>
                      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-dimmed">
                        <span>
                          <i class="ti ti-user mr-1" aria-hidden="true" />
                          Scheduled by {item.scheduledBy.displayName}
                        </span>
                        <span title={dates.formatDateTime(item.createdAt, props.dateConfig)}>
                          Created {dates.formatDateTimeRelative(item.createdAt, props.dateConfig)}
                        </span>
                        <Show when={item.lastError}>
                          {(error) => (
                            <span class="text-red-600" title={error()}>
                              <i class="ti ti-alert-circle mr-1" aria-hidden="true" />
                              {item.nextAttemptAt
                                ? `Retry ${dates.formatDateTime(item.nextAttemptAt, props.dateConfig)}`
                                : "Delivery retry pending"}
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
                        Cancel
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
                    Load more
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
