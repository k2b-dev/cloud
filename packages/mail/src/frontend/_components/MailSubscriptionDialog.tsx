import { documentNavigate } from "@k2b/ssr/nav";
import { mutation as mutations, query } from "@k2b/stdlib/solid";
import {
  Button,
  DataTable,
  type DataTableColumn,
  Dropdown,
  type DropdownItem,
  dialogCore,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogFixedOptions,
  panelDialogWidePanelClass,
  prompts,
  StatusBadge,
  toast,
  useLocale,
} from "@k2b/ui";
import { createLiveWebSocket } from "@k2b/cloud/browser/live";
import { createMemo, createSignal, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type {
  MailingListDispositionResult,
  MailSubscriptionPage,
  MailSubscriptionSummary,
  UnsubscribeMailingListResult,
} from "../../contracts";
import { MAIL_LIVE_WS_TYPE, type MailLiveClientMessage, type MailLiveServerMessage, parseMailLiveServerMessage } from "../../live-events";
import { assertCursorProgress } from "../pagination";
import { readApiError } from "./api-response";
import { createMailLiveInvalidationHub, type MailLiveInvalidation } from "./mail-live-invalidation-hub";
import { mailSettingsMessages } from "./mail-settings-messages";

type Messages = ReturnType<typeof mailSettingsMessages.resolve>["t"];

const statusLabel = (status: MailSubscriptionSummary["status"], messages: Messages): string | null =>
  status === "active"
    ? null
    : status === "requesting"
      ? messages.requesting
      : status === "unsubscribe_requested"
        ? messages.unsubscribeRequested
        : messages.requestFailed;

const statusTone = (status: MailSubscriptionSummary["status"]): "error" | "ok" | "warning" | "neutral" =>
  status === "failed" ? "error" : status === "unsubscribe_requested" ? "ok" : status === "requesting" ? "warning" : "neutral";

const formatDate = (value: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

const mergePages = (pages: readonly MailSubscriptionPage[]): MailSubscriptionSummary[] => {
  const merged = new Map<string, MailSubscriptionSummary>();
  for (const page of pages) for (const item of page.items) merged.set(item.listKey, item);
  return [...merged.values()];
};

const columns = (messages: Messages): DataTableColumn<MailSubscriptionSummary>[] => [
  { id: "list", header: messages.mailingList, value: "name", cellClass: "min-w-52" },
  { id: "messages", header: messages.messages, value: "messageCount", cellClass: "w-28" },
  { id: "latest", header: messages.latestMessage, value: "lastMessageAt", cellClass: "min-w-56" },
  { id: "actions", header: <span class="sr-only">{messages.actions}</span>, value: "listKey", cellClass: "w-44", headerClass: "w-44" },
];

const mailingListDialogOptions = {
  panelClassName: `${panelDialogWidePanelClass} is-fixed`,
  contentClassName: panelDialogFixedOptions.contentClassName,
};

function MailSubscriptionDialog(props: { mailboxId: string; canWrite: boolean; initialListKey: string | null; close: () => void }) {
  const locale = useLocale();
  const messages = createMemo(() => mailSettingsMessages.resolve([locale()]).t);
  const [pendingAction, setPendingAction] = createSignal<string | null>(null);
  const [liveTransportDegraded, setLiveTransportDegraded] = createSignal(false);
  const [liveSnapshotDegraded, setLiveSnapshotDegraded] = createSignal(false);
  const liveDegraded = createMemo(() => liveTransportDegraded() || liveSnapshotDegraded());
  let markLiveApplied: (cursor: string | null | undefined) => void = () => undefined;
  let liveTransportTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const liveHub = createMailLiveInvalidationHub({
    delayMs: 150,
    isBlocked: () => false,
    onApplied: (cursor) => {
      setLiveSnapshotDegraded(false);
      markLiveApplied(cursor);
    },
    onFailed: () => setLiveSnapshotDegraded(true),
  });

  const subscriptions = query.createInfinite<string, MailSubscriptionPage, string, MailLiveInvalidation>({
    source: () => `${props.mailboxId}:${props.initialListKey ?? ""}`,
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].subscriptions.$get(
        {
          param: { mailboxId: props.mailboxId },
          query: { limit: "50", cursor, listKey: cursor === undefined ? (props.initialListKey ?? undefined) : undefined },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadMailingLists));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "mailing lists");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
    subscribe: ({ invalidate }) => liveHub.register({ matches: () => true, invalidate }),
  });
  const items = createMemo(() => mergePages(subscriptions.pages()));

  const unsubscribe = mutations.create<{ item: MailSubscriptionSummary; result: UnsubscribeMailingListResult }, MailSubscriptionSummary>({
    mutation: async (item, { abortSignal }) => {
      if (item.unsubscribe?.kind !== "one_click") throw new Error(messages().oneClickUnavailable);
      const response = await apiClient.mailboxes[":mailboxId"].subscriptions.unsubscribe.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: { listKey: item.listKey, href: item.unsubscribe.href },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedUnsubscribe));
      return { item, result: await response.json() };
    },
    onSuccess: ({ item, result }) => {
      toast.success(messages().unsubscribeRequestedFor({ name: item.name }));
      void subscriptions
        .invalidate({ cursor: null, conversationIds: null })
        .catch((error) => toast.error(error instanceof Error ? error.message : messages().mailingListsRefreshFailed));
    },
    onError: (error) => {
      toast.error(error.message);
      void subscriptions
        .invalidate({ cursor: null, conversationIds: null })
        .catch((error) => toast.error(error instanceof Error ? error.message : messages().mailingListsRefreshFailed));
    },
  });

  const dispose = mutations.create<
    { item: MailSubscriptionSummary; disposition: "archive" | "trash"; result: MailingListDispositionResult },
    { item: MailSubscriptionSummary; disposition: "archive" | "trash"; idempotencyKey: string }
  >({
    mutation: async ({ item, disposition, idempotencyKey }, { abortSignal }) => {
      const response = await apiClient.mailboxes[":mailboxId"].subscriptions.disposition.$post(
        {
          param: { mailboxId: props.mailboxId },
          json: { listKey: item.listKey, disposition, idempotencyKey },
        },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedDisposition({ disposition })));
      return { item, disposition, result: await response.json() };
    },
    onSuccess: ({ item, result }) => {
      toast.success(
        result.commandCount === 0
          ? messages().noMessagesNeededMoving({ name: item.name })
          : messages().messageMovesQueued({ count: result.commandCount }),
      );
      if (result.truncated) toast(messages().moreMessagesRemain, { title: messages().first500Queued });
    },
    onError: (error) => toast.error(error.message),
  });

  const requestUnsubscribe = async (item: MailSubscriptionSummary) => {
    if (!item.unsubscribe || !props.canWrite || pendingAction()) return;
    const reservation = `unsubscribe:${item.listKey}`;
    setPendingAction(reservation);
    try {
      const confirmed = await prompts.confirm(
        item.unsubscribe.kind === "one_click"
          ? messages().oneClickUnsubscribeDescription({ name: item.name })
          : item.unsubscribe.kind === "web"
            ? messages().webUnsubscribeDescription({ name: item.name })
            : messages().emailUnsubscribeDescription({ name: item.name }),
        {
          title: messages().unsubscribeFrom({ name: item.name }),
          icon: "ti ti-mail-off",
          confirmText: item.unsubscribe.kind === "one_click" ? messages().unsubscribe : messages().continue,
        },
      );
      if (!confirmed || disposed) return;
      if (item.unsubscribe.kind === "one_click") await unsubscribe.mutate(item);
      else if (item.unsubscribe.kind === "email") window.location.href = item.unsubscribe.href;
      else window.open(item.unsubscribe.href, "_blank", "noopener,noreferrer");
    } finally {
      if (!disposed && pendingAction() === reservation) setPendingAction(null);
    }
  };

  const requestDisposition = async (item: MailSubscriptionSummary, disposition: "archive" | "trash") => {
    if (!props.canWrite || pendingAction()) return;
    const reservation = `${disposition}:${item.listKey}`;
    setPendingAction(reservation);
    try {
      const confirmed = await prompts.confirm(messages().dispositionDescription({ disposition, name: item.name }), {
        title: disposition === "archive" ? messages().archiveExistingMessages : messages().trashExistingMessages,
        icon: disposition === "archive" ? "ti ti-archive" : "ti ti-trash",
        variant: disposition === "trash" ? "danger" : undefined,
        confirmText: disposition === "archive" ? messages().archiveMessages : messages().moveToTrash,
      });
      if (!disposed && confirmed) await dispose.mutate({ item, disposition, idempotencyKey: crypto.randomUUID() });
    } finally {
      if (!disposed && pendingAction() === reservation) setPendingAction(null);
    }
  };

  const rowActions = (item: MailSubscriptionSummary): DropdownItem[] => {
    const actions: DropdownItem[] = [];
    if (item.postHref) actions.push({ label: messages().writeToList, icon: "ti ti-send", href: item.postHref });
    if (item.archiveHref) actions.push({ label: messages().listArchive, icon: "ti ti-world", href: item.archiveHref, external: true });
    if (props.canWrite && item.status === "unsubscribe_requested") {
      actions.push({ label: messages().archiveExisting, icon: "ti ti-archive", action: () => void requestDisposition(item, "archive") });
      actions.push({
        label: messages().moveExistingToTrash,
        icon: "ti ti-trash",
        variant: "danger",
        action: () => void requestDisposition(item, "trash"),
      });
    }
    return actions;
  };

  onMount(() => {
    const live = createLiveWebSocket<MailLiveServerMessage>({
      url: "/api/mail/ws",
      initialCursor: null,
      activity: "visible",
      subscribe: (cursor) =>
        ({
          type: MAIL_LIVE_WS_TYPE.subscribe,
          payload: { mailboxId: props.mailboxId, fromCursor: cursor },
        }) satisfies MailLiveClientMessage,
      parse: (raw) => {
        const message = parseMailLiveServerMessage(raw);
        if (!message) throw new Error(messages().invalidLiveMessage);
        return message;
      },
      onStatus: (status) => {
        if (liveTransportTimer) clearTimeout(liveTransportTimer);
        liveTransportTimer = null;
        if (status === "reconnecting") {
          if (!liveTransportDegraded()) {
            liveTransportTimer = setTimeout(() => {
              liveTransportTimer = null;
              if (!disposed) setLiveTransportDegraded(true);
            }, 2_000);
          }
          return;
        }
        if (status === "open" || status === "paused" || status === "closed") setLiveTransportDegraded(false);
      },
      onMessage: (message, controls) => {
        if (message.payload.mailboxId && message.payload.mailboxId !== props.mailboxId) {
          controls.terminate({ code: "resource_mismatch", message: messages().liveResourceChanged });
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.ready || message.type === MAIL_LIVE_WS_TYPE.event) {
          liveHub.schedule({
            cursor: message.payload.cursor,
            conversationId: message.type === MAIL_LIVE_WS_TYPE.event ? message.payload.event.conversationId : null,
          });
          return;
        }
        if (message.type === MAIL_LIVE_WS_TYPE.revoked) {
          controls.terminate({ code: message.payload.code, message: message.payload.message });
        }
      },
      classifyClose: ({ code, reason }) =>
        code === 1008 ? { code: reason || "access_denied", message: messages().mailboxAccessChanged } : null,
      onFatal: (error) => {
        if (error.code === "login_required") {
          const current = `${window.location.pathname}${window.location.search}`;
          documentNavigate(`/auth/login?redirectTo=${encodeURIComponent(current)}`, { replace: true });
        } else documentNavigate("/app/mail", { replace: true });
      },
    });
    markLiveApplied = live.markApplied;
    live.connect();
    onCleanup(() => {
      live.dispose();
      markLiveApplied = () => undefined;
    });
  });

  onCleanup(() => {
    disposed = true;
    if (liveTransportTimer) clearTimeout(liveTransportTimer);
    liveHub.dispose();
    unsubscribe.abort();
    dispose.abort();
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={messages().mailingLists}
        subtitle={messages().mailingListsSubtitle}
        icon="ti ti-news"
        actions={
          <Show when={liveDegraded()}>
            <span class="inline-flex items-center gap-1 text-xs text-dimmed" title={messages().liveUpdatesPaused}>
              <i class="ti ti-cloud-off" aria-hidden="true" /> {messages().updatesPaused}
            </span>
          </Show>
        }
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey={`mailing-lists:${props.mailboxId}`}>
        <Show
          when={subscriptions.pages().length > 0}
          fallback={
            <Show
              when={subscriptions.error()}
              fallback={<Placeholder state="loading" variant="panel" title={messages().loadingMailingLists} />}
            >
              {(error) => (
                <Placeholder
                  state="error"
                  variant="panel"
                  title={messages().couldNotLoadMailingLists}
                  description={error().message}
                  action={
                    <Button variant="secondary" size="sm" type="button" onClick={() => void subscriptions.refresh()}>
                      <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
                    </Button>
                  }
                />
              )}
            </Show>
          }
        >
          <div class="flex flex-col gap-2">
            <Show when={subscriptions.error()}>
              {(error) => (
                <NoticeCard tone="warning" icon={false}>
                  {error().message}
                  <Button variant="ghost" size="xs" type="button" class="ml-2" onClick={() => void subscriptions.refresh()}>
                    {messages().retry}
                  </Button>
                </NoticeCard>
              )}
            </Show>
            <DataTable
              rows={items()}
              columns={columns(messages())}
              getRowId={(item) => item.listKey}
              selectedRowId={props.initialListKey}
              density="compact"
              surface="paper"
              stickyHeader={false}
              ariaLabel={messages().mailingLists}
              class="overflow-x-auto"
              tableClass={items().length > 0 ? "w-full min-w-[44rem] text-xs" : "w-full text-xs"}
              empty={
                <Placeholder
                  icon="ti ti-news-off"
                  title={messages().noMailingListsFound}
                  description={messages().noMailingListsDescription}
                />
              }
              renderCell={({ row, col, render }) => {
                if (col.id === "list") {
                  return (
                    <span class="block min-w-0">
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate font-medium text-primary">{row.name}</span>
                        <Show when={statusLabel(row.status, messages())}>
                          {(label) => (
                            <StatusBadge tone={statusTone(row.status)} label={label()} title={row.unsubscribeErrorCode ?? undefined} />
                          )}
                        </Show>
                      </span>
                      <Show when={row.name.toLowerCase() !== row.address.toLowerCase()}>
                        <span class="block truncate text-dimmed">{row.address}</span>
                      </Show>
                    </span>
                  );
                }
                if (col.id === "messages") {
                  return (
                    <span class="block whitespace-nowrap">
                      <span class="block text-primary">{messages().recentCount({ count: row.recentMessageCount })}</span>
                      <span class="block text-dimmed">
                        {messages().messageAndConversationCount({ messages: row.messageCount, conversations: row.conversationCount })}
                      </span>
                    </span>
                  );
                }
                if (col.id === "latest") {
                  return (
                    <span class="block min-w-0">
                      <span class="block truncate text-primary">{row.lastSubject || messages().noSubject}</span>
                      <time class="block whitespace-nowrap text-dimmed" datetime={row.lastMessageAt}>
                        {formatDate(row.lastMessageAt, locale())}
                      </time>
                    </span>
                  );
                }
                if (col.id === "actions") {
                  const actions = rowActions(row);
                  const canUnsubscribe = props.canWrite && row.unsubscribe && row.status !== "unsubscribe_requested";
                  return (
                    <span class="flex items-center justify-end gap-1">
                      <Show when={canUnsubscribe}>
                        <Button
                          variant="secondary"
                          size="sm"
                          type="button"
                          disabled={Boolean(pendingAction()) || Boolean(subscriptions.error())}
                          onClick={() => void requestUnsubscribe(row)}
                        >
                          {row.status === "failed" ? messages().retry : messages().unsubscribe}
                        </Button>
                      </Show>
                      <Show when={actions.length > 0} fallback={!canUnsubscribe ? <span class="text-dimmed">—</span> : undefined}>
                        <Dropdown.Root
                          position="bottom-left"
                          items={actions}
                          disabled={Boolean(pendingAction()) || Boolean(subscriptions.error())}
                        >
                          <Dropdown.Trigger
                            iconOnly
                            size="sm"
                            type="button"
                            variant="ghost"
                            label={messages().moreActionsFor({ name: row.name })}
                          >
                            <i class="ti ti-dots" aria-hidden="true" />
                          </Dropdown.Trigger>
                        </Dropdown.Root>
                      </Show>
                    </span>
                  );
                }
                return render(col.value instanceof Function ? col.value(row) : col.value ? row[col.value] : undefined);
              }}
            />
            <Show when={subscriptions.hasMore()}>
              <div class="flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  disabled={subscriptions.loadingMore() || Boolean(subscriptions.error())}
                  onClick={() => void subscriptions.loadMore()}
                >
                  <i class={`ti ${subscriptions.loadingMore() ? "ti-loader-2 animate-spin" : "ti-chevron-down"}`} aria-hidden="true" />
                  {messages().loadMore}
                </Button>
              </div>
            </Show>
          </div>
        </Show>
      </PanelDialog.Body>
    </PanelDialog>
  );
}

export const openMailSubscriptionDialog = (params: { mailboxId: string; canWrite: boolean; initialListKey?: string | null }) =>
  dialogCore.open<void>(
    (close) => (
      <MailSubscriptionDialog
        mailboxId={params.mailboxId}
        canWrite={params.canWrite}
        initialListKey={params.initialListKey ?? null}
        close={() => close()}
      />
    ),
    mailingListDialogOptions,
  );
