import { listenPopState, navigate, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { detailPanel, mutation as mutations, query as queries } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  IconButton,
  PanelHeader,
  Paper,
  Placeholder,
  prompts,
  SegmentedControl,
  Tag,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { DeletedMailbox, DeletedMailboxPage, Mailbox, MailFocusPage, MailFocusView } from "../contracts";
import type { MailConversationDetailData } from "../service/workspace";
import { readApiError } from "./_components/api-response";
import { openMailboxHealthDialog } from "./_components/MailboxHealthDialog";
import { openMailboxSettingsDialog } from "./_components/MailboxSettingsDialog";
import MailDetailsPanel from "./_components/MailDetailsPanel";
import { mailboxOverviewSubtitle } from "./_components/mail-health-presentation";
import { readMailWorkspacePreferences, writeMailWorkspacePreferences } from "./_components/mail-workspace-preferences";
import { mailOverviewMessages } from "./mail-overview-messages";
import { assertCursorProgress } from "./pagination";

type MailboxWithPermission = Mailbox & { permission: "read" | "write" | "admin"; receivingAddress: string | null };
type MailFocusSelection = { mailboxId: string; conversationId: string };
type MailboxOverviewItem = {
  id: string;
  href: string;
  name: string;
  subtitle: string;
  unread: number;
  needsAction: number;
};

/** The object list needs room for a title and an address; the overview does not resize. */
const OVERVIEW_LAYOUT = { version: 2 as const, sidebarWidth: 304 };

const primaryParticipant = (summary: string, fallback: string): string => summary.split(/\s[·,]\s/u)[0]?.trim() || fallback;
const participantInitials = (summary: string): string => {
  const words =
    summary
      .split(/\s[·,]\s/u)[0]
      ?.trim()
      .split(/\s+/u)
      .filter(Boolean) ?? [];
  return (
    words
      .slice(0, 2)
      .map((word) => word[0]?.toLocaleUpperCase())
      .join("") || "M"
  );
};
const avatarTone = (summary: string): string =>
  String([...primaryParticipant(summary, "")].reduce((total, character) => total + character.codePointAt(0)!, 0) % 5);

export default function MailOverview(props: {
  mailboxes: MailboxWithPermission[];
  initialFocus: MailFocusPage;
  initialFocusError: string | null;
  initialView: MailFocusView;
  initialSelection: MailFocusSelection | null;
  initialDetail: MailConversationDetailData | null;
  initialPinnedMailboxIds: string[];
  currentUserEmail: string | null;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const formatCount = (count: number) => count.toLocaleString(locale());
  const [view, setView] = createSignal<MailFocusView>(props.initialView);
  const [pinnedMailboxIds, setPinnedMailboxIds] = createSignal(props.initialPinnedMailboxIds);
  const [pinAnnouncement, setPinAnnouncement] = createSignal("");
  const [initialFocusError, setInitialFocusError] = createSignal(props.initialFocusError);
  const focusResults = queries.createInfinite<MailFocusView, MailFocusPage, string>({
    source: view,
    initial: { source: props.initialView, pages: [props.initialFocus] },
    loadPage: async (source, { cursor, abortSignal }) => {
      const response = await apiClient.overview.conversations.$get(
        { query: { view: source, limit: "50", cursor } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadFocus));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "mail-focus");
      setInitialFocusError(null);
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const focusItems = createMemo(() => focusResults.pages().flatMap((page) => page.items));
  const counts = () => focusResults.pages()[0]?.counts ?? props.initialFocus.counts;
  const mailboxCounts = () => focusResults.pages()[0]?.mailboxCounts ?? props.initialFocus.mailboxCounts;
  const mailboxCountsById = createMemo(() => new Map(mailboxCounts().map((item) => [item.mailboxId, item])));
  const mailboxOverviewItems = createMemo<MailboxOverviewItem[]>(() =>
    props.mailboxes.map((mailbox) => {
      const mailboxStats = mailboxCountsById().get(mailbox.id) ?? { unread: 0, needsAction: 0 };
      return {
        id: mailbox.id,
        href: `/app/mail/${mailbox.id}?view=needs_action`,
        name: mailbox.name,
        subtitle: mailboxOverviewSubtitle(mailbox, locale()),
        unread: mailboxStats.unread,
        needsAction: mailboxStats.needsAction,
      };
    }),
  );
  const orderedMailboxOverviewItems = createMemo(() => {
    return [...mailboxOverviewItems()].sort((left, right) => {
      const leftIndex = pinnedMailboxIds().indexOf(left.id);
      const rightIndex = pinnedMailboxIds().indexOf(right.id);
      if (leftIndex === -1 && rightIndex === -1) return 0;
      if (leftIndex === -1) return 1;
      if (rightIndex === -1) return -1;
      return leftIndex - rightIndex;
    });
  });
  const mailboxIsPinned = (mailboxId: string) => pinnedMailboxIds().includes(mailboxId);
  const toggleMailboxPin = (mailbox: MailboxOverviewItem) => {
    setPinnedMailboxIds((current) => {
      const pinned = current.includes(mailbox.id);
      const next = pinned ? current.filter((id) => id !== mailbox.id) : [mailbox.id, ...current];
      writeMailWorkspacePreferences({
        ...readMailWorkspacePreferences(document.cookie),
        pinnedMailboxIds: next,
      });
      setPinAnnouncement(pinned ? messages().unpinned({ name: mailbox.name }) : messages().pinned({ name: mailbox.name }));
      return next;
    });
  };
  const canWriteMailbox = (mailboxId: string) => {
    const permission = props.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.permission;
    return permission === "write" || permission === "admin";
  };
  const focusDescription = () => {
    const count = counts()[view()];
    if (view() === "mine") return messages().focusDescriptionMine({ count });
    if (view() === "unassigned") return messages().focusDescriptionUnassigned({ count });
    if (view() === "waiting") return messages().focusDescriptionWaiting({ count });
    return messages().focusDescriptionAll({ count });
  };
  const focusViewOptions = () => [
    { value: "mine" as const, label: focusViewLabel(messages().forMe, counts().mine) },
    { value: "unassigned" as const, label: focusViewLabel(messages().unassigned, counts().unassigned) },
    { value: "waiting" as const, label: focusViewLabel(messages().waiting, counts().waiting) },
    { value: "all" as const, label: focusViewLabel(messages().allActive, counts().all) },
  ];
  const focusViewLabel = (label: string, count: number) => (
    <>
      {label} <span class="mail-focus-tab-count">{count}</span>
    </>
  );
  const focusError = () => focusResults.error()?.message ?? initialFocusError();
  const [selection, setSelection] = createSignal<MailFocusSelection | null>(props.initialSelection);
  const [wideLayout, setWideLayout] = createSignal(false);
  const detailOpen = () => wideLayout() && selection() !== null;
  const selectionSource = () => {
    const current = selection();
    return current ? `${current.mailboxId}/${current.conversationId}` : null;
  };
  const detailResult = queries.create<string | null, MailConversationDetailData>({
    source: selectionSource,
    initial:
      props.initialDetail && props.initialSelection
        ? { source: `${props.initialSelection.mailboxId}/${props.initialSelection.conversationId}`, data: props.initialDetail }
        : undefined,
    enabled: detailOpen,
    load: async (source, { abortSignal }) => {
      if (!source) throw new Error(messages().selectConversationDetails);
      const [mailboxId, conversationId] = source.split("/");
      if (!mailboxId || !conversationId) throw new Error(messages().invalidConversationSelection);
      const response = await apiClient.mailboxes[":mailboxId"]["workspace-detail"][":conversationId"].$get(
        { param: { mailboxId, conversationId } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadConversationDetails));
      return response.json();
    },
  });

  const updateSelectionUrl = (next: MailFocusSelection | null) => {
    const url = new URL(window.location.href);
    if (next) {
      url.searchParams.set("mailbox", next.mailboxId);
      url.searchParams.set("conversation", next.conversationId);
    } else {
      url.searchParams.delete("mailbox");
      url.searchParams.delete("conversation");
    }
    navigate(`${url.pathname}${url.search}`, { scroll: "preserve" });
  };

  const selectConversation = (event: MouseEvent & { currentTarget: HTMLAnchorElement }, item: MailFocusSelection) => {
    if (!wideLayout() || !detailPanel.shouldHandleClick(event, event.currentTarget)) return;
    event.preventDefault();
    setSelection(item);
    updateSelectionUrl(item);
  };

  const selectView = (next: MailFocusView) => {
    setView(next);
    setInitialFocusError(null);
    setSelection(null);
    const url = new URL(window.location.href);
    if (next === "mine") url.searchParams.delete("view");
    else url.searchParams.set("view", next);
    url.searchParams.delete("mailbox");
    url.searchParams.delete("conversation");
    navigate(`${url.pathname}${url.search}`, { scroll: "preserve" });
  };

  const retryFocus = () => {
    setInitialFocusError(null);
    void focusResults.refresh();
  };

  const [deletedOpen, setDeletedOpen] = createSignal(false);
  const deletedResults = queries.createInfinite<string, DeletedMailboxPage, string>({
    source: () => "deleted-mailboxes",
    enabled: deletedOpen,
    loadPage: async (_source, { cursor, abortSignal }) => {
      const response = await apiClient.mailboxes.deleted.$get({ query: { limit: "100", cursor } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadDeletedMailboxes));
      const page = await response.json();
      assertCursorProgress(cursor, page.nextCursor, "deleted-mailbox");
      return page;
    },
    getNextCursor: (page) => page.nextCursor,
  });
  const deletedMailboxes = createMemo(() => {
    const merged = new Map<string, DeletedMailbox & { permission: "admin" }>();
    for (const page of deletedResults.pages()) for (const mailbox of page.items) merged.set(mailbox.id, mailbox);
    return [...merged.values()];
  });

  const createMailbox = mutations.create<Mailbox | null, void>({
    mutation: async (_input, { abortSignal }) => {
      const values = await prompts.form({
        title: messages().newMailbox,
        icon: "ti ti-mail-plus",
        fields: {
          name: { type: "text", label: messages().name, description: messages().nameDescription, required: true },
          description: {
            type: "text",
            label: messages().description,
            description: messages().descriptionDescription,
            multiline: true,
            lines: 3,
          },
        },
        confirmText: messages().createMailbox,
      });
      if (!values || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes.$post(
        { json: { name: values.name, description: values.description || null } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedCreateMailbox));
      return response.json();
    },
    onSuccess: (mailbox) => {
      if (!mailbox) return;
      toast.success(messages().mailboxCreated);
      void openMailboxSettingsDialog({ mailboxId: mailbox.id, currentUserEmail: props.currentUserEmail, initialTab: "delivery" }).then(
        (result) => navigateTo(result.deleted ? "/app/mail" : `/app/mail/${mailbox.id}`),
      );
    },
    onError: (error) => prompts.error(error.message),
  });

  const restoreMailbox = mutations.create<Mailbox | null, string>({
    mutation: async (mailboxId, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().restoreWarning, {
        title: messages().restoreMailbox,
        confirmText: messages().restoreMailbox,
      });
      if (!confirmed || abortSignal.aborted) return null;
      const response = await apiClient.mailboxes[":mailboxId"].restore.$post({ param: { mailboxId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRestoreMailbox));
      return response.json();
    },
    onSuccess: (mailbox) => {
      if (!mailbox) return;
      void deletedResults.refresh();
      toast.success(messages().mailboxRestored);
      void openMailboxHealthDialog({ mailboxId: mailbox.id }).then(() => navigateTo(`/app/mail/${mailbox.id}`));
    },
    onError: (error) => prompts.error(error.message),
  });

  onMount(() => {
    const media = window.matchMedia("(min-width: 64rem)");
    const updateWideLayout = () => setWideLayout(media.matches);
    updateWideLayout();
    media.addEventListener("change", updateWideLayout);
    const stop = listenPopState(({ url }) => {
      const parsed = url.searchParams.get("view");
      setView(parsed === "unassigned" || parsed === "waiting" || parsed === "all" ? parsed : "mine");
      const mailboxId = url.searchParams.get("mailbox");
      const conversationId = url.searchParams.get("conversation");
      setSelection(mailboxId && conversationId ? { mailboxId, conversationId } : null);
    });
    onCleanup(() => {
      media.removeEventListener("change", updateWideLayout);
      stop();
    });
  });
  onCleanup(() => {
    createMailbox.abort();
    restoreMailbox.abort();
  });

  const focusPanel = () => (
    <>
      <Show when={focusError()}>
        {(error) => (
          <Placeholder
            state="error"
            title={messages().couldNotLoadFocus}
            description={error()}
            class="min-h-56"
            action={
              <Button variant="secondary" size="sm" onClick={retryFocus}>
                <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
              </Button>
            }
          />
        )}
      </Show>
      <Show when={!focusError() && focusItems().length === 0}>
        <Placeholder
          state={focusResults.loading() ? "loading" : "empty"}
          title={
            focusResults.loading()
              ? messages().loadingFocus
              : view() === "mine"
                ? messages().nothingForMe
                : view() === "unassigned"
                  ? messages().nothingUnassigned
                  : view() === "waiting"
                    ? messages().nothingWaiting
                    : messages().nothingActive
          }
          description={focusResults.loading() ? messages().loadingFocusDescription : messages().noMatchingConversations}
          icon={focusResults.loading() ? undefined : "ti ti-circle-check"}
          class="min-h-56"
        />
      </Show>
      <Show when={!focusError() && focusItems().length > 0}>
        <div class="mail-focus-list" aria-live="polite">
          <For each={focusItems()}>
            {(item) => (
              <a
                href={`/app/mail/${item.mailboxId}?conversation=${item.id}`}
                class="mail-focus-row group"
                classList={{ "is-selected": selection()?.conversationId === item.id && selection()?.mailboxId === item.mailboxId }}
                aria-current={selection()?.conversationId === item.id && selection()?.mailboxId === item.mailboxId ? "true" : undefined}
                onClick={(event) => selectConversation(event, { mailboxId: item.mailboxId, conversationId: item.id })}
              >
                <span class="mail-focus-unread-slot" aria-hidden="true">
                  <Show when={item.unread}>
                    <span class="mail-focus-unread-dot" />
                  </Show>
                </span>
                <span class="mail-focus-avatar" data-tone={avatarTone(item.participantSummary)} aria-hidden="true">
                  {participantInitials(item.participantSummary)}
                </span>
                <span class="mail-focus-copy">
                  <span class="mail-focus-sender">{primaryParticipant(item.participantSummary, messages().unknownSender)}</span>
                  <span class={`mail-focus-subject ${item.unread ? "mail-focus-subject-unread" : ""}`}>
                    {item.subject || messages().noSubject}
                  </span>
                  <span class="mail-focus-preview">{item.preview || messages().noPreview}</span>
                  <span class="mail-focus-meta">
                    <span>
                      <i class="ti ti-inbox" aria-hidden="true" /> {item.mailboxName}
                    </span>
                    <span class={item.workStatus === "waiting" ? "mail-focus-status-waiting" : "mail-focus-status-action"}>
                      <i class={item.workStatus === "waiting" ? "ti ti-clock" : "ti ti-message-exclamation"} aria-hidden="true" />
                      {item.workStatus === "waiting" ? messages().waiting : messages().needsAction}
                    </span>
                    <Show when={item.flagged}>
                      <span>
                        <i class="ti ti-flag-filled" aria-hidden="true" /> {messages().flagged}
                      </span>
                    </Show>
                    <Show when={item.hasAttachments}>
                      <span>
                        <i class="ti ti-paperclip" aria-hidden="true" /> {messages().attachment}
                      </span>
                    </Show>
                  </span>
                </span>
                <time
                  class="mail-focus-time"
                  dateTime={item.latestMessageAt}
                  title={dates.formatDateTime(item.latestMessageAt, props.dateConfig)}
                >
                  {dates.formatDateTimeRelative(item.latestMessageAt, props.dateConfig)}
                </time>
                <i class="ti ti-chevron-right mail-focus-chevron" aria-hidden="true" />
              </a>
            )}
          </For>
          <Show when={focusResults.hasMore()}>
            <Button
              variant="secondary"
              size="sm"
              class="self-center"
              disabled={focusResults.loadingMore()}
              onClick={() => void focusResults.loadMore()}
            >
              <i class={focusResults.loadingMore() ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"} aria-hidden="true" />{" "}
              {messages().loadMore}
            </Button>
          </Show>
        </div>
      </Show>
    </>
  );

  return (
    <AppWorkspace mobileSurface="flush" class="mail-focus-workspace" resizable={false} layoutState={() => OVERVIEW_LAYOUT}>
      <h1 class="sr-only">Mail</h1>
      <AppWorkspace.Sidebar label={messages().mailboxes} mobile="stacked" resizable={false}>
        <AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarBody scrollPreserveKey={false}>
            <AppWorkspace.SidebarSection title={messages().mailboxes} count={props.mailboxes.length}>
              <For each={orderedMailboxOverviewItems()}>
                {(mailbox) => {
                  const pinned = () => mailboxIsPinned(mailbox.id);
                  return (
                    <AppWorkspace.SidebarItem
                      variant="object"
                      href={mailbox.href}
                      title={`${mailbox.name} · ${mailbox.subtitle}`}
                      description={mailbox.subtitle}
                      class="mail-overview-mailbox"
                      data={{ pinned: pinned() ? "true" : undefined }}
                      actions={
                        <AppWorkspace.SidebarItemActions visibility="hover">
                          <IconButton
                            label={
                              pinned() ? messages().unpinMailbox({ name: mailbox.name }) : messages().pinMailbox({ name: mailbox.name })
                            }
                            size="xs"
                            variant="text"
                            aria-pressed={pinned()}
                            onClick={() => toggleMailboxPin(mailbox)}
                          >
                            <i class={`ti ${pinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
                          </IconButton>
                        </AppWorkspace.SidebarItemActions>
                      }
                    >
                      <AppWorkspace.SidebarItemIcon icon={pinned() ? "ti ti-flag" : "ti ti-mail"} />
                      <AppWorkspace.SidebarItemLabel>{mailbox.name}</AppWorkspace.SidebarItemLabel>
                      <AppWorkspace.SidebarItemMeta>
                        <span class="mail-overview-unread" data-zero={mailbox.unread === 0 ? "true" : undefined}>
                          <span aria-hidden="true">{formatCount(mailbox.unread)}</span>
                          <span class="sr-only">{messages().unreadCount({ count: mailbox.unread })}</span>
                        </span>
                        <Show when={mailbox.needsAction > 0}>
                          <span class="mail-overview-needs-action">
                            <span aria-hidden="true">{formatCount(mailbox.needsAction)}</span>
                            <span class="sr-only">{messages().needsActionCount({ count: mailbox.needsAction })}</span>
                          </span>
                        </Show>
                      </AppWorkspace.SidebarItemMeta>
                    </AppWorkspace.SidebarItem>
                  );
                }}
              </For>
            </AppWorkspace.SidebarSection>
            <span class="sr-only" aria-live="polite">
              {pinAnnouncement()}
            </span>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter class="mail-overview-sidebar-footer">
            <Button
              variant="text"
              size="sm"
              class="mail-overview-quiet-action"
              loading={createMailbox.loading()}
              loadingLabel={messages().creatingMailbox}
              onClick={() => createMailbox.mutate()}
            >
              <i class="ti ti-mail-plus" aria-hidden="true" /> {messages().newMailbox}
            </Button>
            <Button
              variant="text"
              size="sm"
              class="mail-overview-quiet-action"
              aria-expanded={deletedOpen()}
              aria-controls="mail-deleted-mailboxes"
              onClick={() => setDeletedOpen((open) => !open)}
            >
              <i class="ti ti-trash" aria-hidden="true" /> {messages().recentlyDeletedMailboxes}
            </Button>
            <Show when={deletedOpen()}>
              <div id="mail-deleted-mailboxes" class="mail-focus-deleted" role="group" aria-label={messages().recentlyDeletedMailboxes}>
                <Show when={deletedResults.error()}>
                  {(error) => (
                    <Placeholder
                      state="error"
                      title={messages().failedLoadDeletedMailboxes}
                      description={error().message}
                      action={
                        <Button variant="secondary" size="sm" onClick={() => void deletedResults.refresh()}>
                          {messages().retry}
                        </Button>
                      }
                    />
                  )}
                </Show>
                <Show when={!deletedResults.error() && deletedMailboxes().length === 0}>
                  <Placeholder
                    state={deletedResults.loading() ? "loading" : "empty"}
                    title={deletedResults.loading() ? messages().loadingDeletedMailboxes : messages().noDeletedMailboxes}
                  />
                </Show>
                <For each={deletedMailboxes()}>
                  {(mailbox) => (
                    <Button
                      variant="ghost"
                      size="xs"
                      loading={restoreMailbox.loading()}
                      loadingLabel={messages().restoringMailbox({ name: mailbox.name })}
                      onClick={() => restoreMailbox.mutate(mailbox.id)}
                    >
                      <i class="ti ti-restore" aria-hidden="true" /> {messages().restoreNamedMailbox({ name: mailbox.name })}
                    </Button>
                  )}
                </For>
                <Show when={deletedResults.hasMore()}>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={deletedResults.loadingMore()}
                    onClick={() => void deletedResults.loadMore()}
                  >
                    {messages().loadMore}
                  </Button>
                </Show>
              </div>
            </Show>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>
      <AppWorkspace.Content>
        <AppWorkspace.Main class="mail-focus-main" aria-busy={focusResults.loading() || focusResults.refreshing()}>
          <div class="mail-overview-page">
            <PanelHeader
              as="h2"
              size="lg"
              title={messages().focus}
              subtitle={`${focusDescription()} · ${messages().allMailboxes}`}
              actions={
                <ButtonLink href="/app/mail/compose" class="mail-compose-action">
                  <i class="ti ti-pencil" aria-hidden="true" /> {messages().compose}
                </ButtonLink>
              }
            />
            <div class="mail-overview-toolbar">
              <SegmentedControl<MailFocusView>
                class="mail-overview-views"
                size="sm"
                ariaLabel={messages().focusView}
                value={view}
                onValueChange={selectView}
                options={focusViewOptions()}
              />
              <Tag icon="ti ti-inbox" size="lg" class="mail-overview-scope">
                {messages().allMailboxes}
              </Tag>
            </div>
            <Paper class="mail-overview-list">{focusPanel()}</Paper>
          </div>
        </AppWorkspace.Main>

        <AppWorkspace.Detail id="mail-focus-detail" open={detailOpen()} width="lg" resizable={false}>
          <Show
            when={selection()}
            fallback={
              <Placeholder
                state="empty"
                title={messages().selectConversation}
                description={messages().selectConversationDescription}
                icon="ti ti-message-circle"
                class="h-full"
              />
            }
          >
            {(selected) => (
              <Show
                when={detailResult.data()?.conversationId === selected().conversationId ? detailResult.data() : null}
                fallback={
                  <Placeholder
                    state={detailResult.error() ? "error" : "loading"}
                    title={detailResult.error() ? messages().couldNotLoadConversationDetails : messages().loadingConversationDetails}
                    description={detailResult.error()?.message}
                    class="h-full"
                    action={
                      detailResult.error() ? (
                        <Button variant="secondary" size="sm" onClick={() => void detailResult.refresh()}>
                          <i class="ti ti-refresh" aria-hidden="true" /> {messages().retry}
                        </Button>
                      ) : undefined
                    }
                  />
                }
              >
                {(detail) => (
                  <Show
                    when={detail().collaborationState && detail().conversationLocalTags}
                    fallback={
                      <Placeholder
                        state="error"
                        title={messages().conversationDetailsUnavailable}
                        description={detail().collaborationError ?? messages().refreshConversation}
                        class="h-full"
                      />
                    }
                  >
                    <MailDetailsPanel
                      mailboxId={selected().mailboxId}
                      conversationId={selected().conversationId}
                      active={detailOpen()}
                      canWrite={canWriteMailbox(selected().mailboxId)}
                      initialState={detail().collaborationState!}
                      initialLocalTags={detail().localTags}
                      initialConversationLocalTags={detail().conversationLocalTags!}
                      initialComments={detail().comments}
                      initialCommentsCursor={detail().commentsCursor}
                      assignableUsers={detail().assignableUsers}
                      presence={[]}
                      activity={detail().activity}
                      initialReminder={detail().reminder}
                      detailErrors={detail().detailErrors}
                      conversationDrafts={detail().conversationDrafts}
                      conversationHref={`/app/mail/${selected().mailboxId}?conversation=${selected().conversationId}`}
                      conversationSummary={detail().conversationSummary}
                      messages={detail().detailMessages}
                      subject={detail().selectedSubject}
                      requestUrl={`/app/mail?${new URLSearchParams({ view: view(), mailbox: selected().mailboxId, conversation: selected().conversationId })}`}
                      dateConfig={props.dateConfig}
                      onCollaborationChange={() => void focusResults.invalidate()}
                      onConversationTagsChange={() => undefined}
                      onClose={() => {
                        setSelection(null);
                        updateSelectionUrl(null);
                      }}
                      onOpenHref={(href) => navigateTo(href)}
                      onReconcile={() => detailResult.refresh()}
                    />
                  </Show>
                )}
              </Show>
            )}
          </Show>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
