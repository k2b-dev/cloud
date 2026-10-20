import { listenPopState, navigate, navigateTo } from "@k2b/ssr/nav";
import { type DateContext, dates } from "@k2b/stdlib";
import { detailPanel, query as queries } from "@k2b/stdlib/solid";
import { AppWorkspace, Button, Placeholder, useLocale, ViewTabs } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../api/client";
import type { MailContactDirectory } from "../contact-directory-settings";
import type { Mailbox, MailFocusPage, MailFocusView } from "../contracts";
import type { MailConversationDetailData } from "../service/workspace";
import { readApiError } from "./_components/api-response";
import MailDetailsPanel from "./_components/MailDetailsPanel";
import MailSidebar from "./_components/MailSidebar";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { createMailboxPreferences } from "./_components/mail-mailbox-preferences";
import { openViewTabsInPlace } from "./_components/mail-view-tabs";
import { mailOverviewMessages } from "./mail-overview-messages";
import { assertCursorProgress } from "./pagination";

type MailboxWithPermission = Mailbox & { permission: "read" | "write" | "admin"; receivingAddress: string | null };
type MailFocusSelection = { mailboxId: string; conversationId: string };
/** The first page of every view and the counts they share, as the server renders the overview. */
type MailFocusOverview = {
  pages: Record<MailFocusView, Pick<MailFocusPage, "items" | "nextCursor">>;
  counts: MailFocusPage["counts"];
  mailboxCounts: MailFocusPage["mailboxCounts"];
};
/** A Focus page and the hidden mailboxes it leaves out. */
type MailFocusViewPage = MailFocusPage & { excludedMailboxIds: string[] };

const FOCUS_PAGE_SIZE = 50;
/** F2: Fokus's Detail is a column only while Main keeps this width beside it. */
const MAIL_FOCUS_MAIN_MIN = 420;

const primaryParticipant = (summary: string, fallback: string): string => summary.split(/\s[·,]\s/u)[0]?.trim() || fallback;
function MailOverviewView(props: {
  mailboxes: MailboxWithPermission[];
  /** Null when the server could not read Focus; `initialFocusError` then says why. */
  initialFocus: MailFocusOverview | null;
  initialFocusError: string | null;
  initialView: MailFocusView;
  initialSelection: MailFocusSelection | null;
  initialDetail: MailConversationDetailData | null;
  initialPinnedMailboxIds: string[];
  initialHiddenMailboxIds: string[];
  currentUserEmail: string | null;
  contactDirectory: MailContactDirectory;
  dateConfig: DateContext;
}) {
  const locale = useLocale();
  const messages = createMemo(() => mailOverviewMessages.resolve([locale()]).t);
  const formatCount = (count: number) => count.toLocaleString(locale());
  const [view, setView] = createSignal<MailFocusView>(props.initialView);
  const mailboxPreferences = createMailboxPreferences({
    pinnedMailboxIds: props.initialPinnedMailboxIds,
    hiddenMailboxIds: props.initialHiddenMailboxIds,
  });
  const hiddenMailboxIds = mailboxPreferences.hiddenMailboxIds;
  const [initialFocusError, setInitialFocusError] = createSignal(props.initialFocusError);
  const mailboxIsHidden = mailboxPreferences.isHidden;
  // Counts are the same in every view's page, so the newest page any view loaded supplies them.
  const [latestCounts, setLatestCounts] = createSignal({
    counts: props.initialFocus?.counts ?? { mine: 0, unassigned: 0, waiting: 0, all: 0 },
    mailboxCounts: props.initialFocus?.mailboxCounts ?? [],
  });
  // Each view keeps its own pages. The server renders the first page of every view, so switching
  // shows rows at once; the view then refreshes them in place. Only the shown view loads.
  // Focus leaves out every stored hidden mailbox, as on the server, including one beyond the
  // listed mailboxes; the server ignores IDs of mailboxes that are gone or unreadable.
  const createFocusQuery = (focusView: MailFocusView) =>
    queries.createInfinite<string[], MailFocusViewPage, string>({
      source: hiddenMailboxIds,
      isSameSource: (left, right) => left.join() === right.join(),
      enabled: () => view() === focusView && !initialFocusError(),
      initial: props.initialFocus
        ? {
            source: props.initialHiddenMailboxIds,
            pages: [
              {
                ...props.initialFocus.pages[focusView],
                counts: props.initialFocus.counts,
                mailboxCounts: props.initialFocus.mailboxCounts,
                excludedMailboxIds: props.initialHiddenMailboxIds,
              },
            ],
          }
        : undefined,
      loadPage: async (excludedMailboxIds, { cursor, abortSignal }) => {
        const response = await apiClient.overview.conversations.$get(
          {
            query: {
              view: focusView,
              limit: String(FOCUS_PAGE_SIZE),
              cursor,
              excludeMailboxIds: excludedMailboxIds.join(",") || undefined,
            },
          },
          { init: { signal: abortSignal } },
        );
        if (!response.ok) throw new Error(await readApiError(response, messages().failedLoadFocus));
        const page = await response.json();
        // A response that arrived as its view was left or its mailboxes changed is no longer current.
        abortSignal.throwIfAborted();
        assertCursorProgress(cursor, page.nextCursor, "mail-focus");
        setInitialFocusError(null);
        setLatestCounts({ counts: page.counts, mailboxCounts: page.mailboxCounts });
        return { ...page, excludedMailboxIds };
      },
      getNextCursor: (page) => page.nextCursor,
    });
  const focusQueries: Record<MailFocusView, ReturnType<typeof createFocusQuery>> = {
    mine: createFocusQuery("mine"),
    unassigned: createFocusQuery("unassigned"),
    waiting: createFocusQuery("waiting"),
    all: createFocusQuery("all"),
  };
  const focusResults = () => focusQueries[view()];
  /** Shows a view: its rows at once when it has any, refreshed in place. */
  const showView = (next: MailFocusView) => {
    setView(next);
    if (focusQueries[next].pages().length > 0) void focusQueries[next].invalidate().catch(() => undefined);
  };
  // Rows of a mailbox hidden a moment ago leave before the refreshed page arrives.
  const focusItems = createMemo(() =>
    focusResults()
      .pages()
      .flatMap((page) => page.items)
      .filter((item) => !mailboxIsHidden(item.mailboxId)),
  );
  const counts = () => latestCounts().counts;
  const mailboxCounts = () => latestCounts().mailboxCounts;
  const canWriteMailbox = (mailboxId: string) => {
    const permission = props.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.permission;
    return permission === "write" || permission === "admin";
  };
  /** False where the person sees only the conversations assigned to them. */
  const mailboxWide = (mailboxId: string) => props.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.accessScope !== "assigned";
  const focusTabs = () =>
    (
      [
        ["mine", messages().forMe],
        ["unassigned", messages().unassigned],
        ["waiting", messages().waiting],
        ["all", messages().allActive],
      ] as const
    ).map(([id, label]) => ({ id, label, href: id === "mine" ? "/app/mail" : `/app/mail?view=${id}`, count: formatCount(counts()[id]) }));
  // Focus switches views in place, keeping each view's loaded rows; the tabs stay links for a new tab or a reload.
  openViewTabsInPlace(focusTabs, (href) => {
    const parsed = new URL(href, window.location.origin).searchParams.get("view");
    selectView(parsed === "unassigned" || parsed === "waiting" || parsed === "all" ? parsed : "mine");
  });
  // As many loading rows as the view will show, up to one page. A view expected to be empty gets one
  // row in a box of the empty state's height.
  const expectedRows = () => Math.min(counts()[view()], FOCUS_PAGE_SIZE);
  const skeletonRows = () => Array.from({ length: expectedRows() || 1 });
  const focusError = () => focusResults().error()?.message ?? initialFocusError();
  // The empty state is the answer of a finished read for the mailboxes shown now. While the view
  // refreshes, that answer stays only as long as the counts agree; after a mailbox was hidden or
  // shown, or when the count says the view has rows, the view shows its rows loading instead.
  const focusEmpty = () => {
    const results = focusResults();
    const page = results.pages()[0];
    if (!page || page.excludedMailboxIds.join() !== hiddenMailboxIds().join()) return false;
    return counts()[view()] === 0 || !(results.stale() || results.refreshing());
  };
  const [selection, setSelection] = createSignal<MailFocusSelection | null>(props.initialSelection);
  // Fokus has no reader: from 48 rem a chosen conversation opens its Detail, as a column while Main keeps 420 px and
  // otherwise as the drawer. A click on a phone opens the reader instead; a selection in the URL keeps its Detail
  // (the sheet on a phone) before and after the island mounts.
  const [wideLayout, setWideLayout] = createSignal(true);
  const detailOpen = () => selection() !== null;
  const closeDetail = () => {
    setSelection(null);
    updateSelectionUrl(null);
  };
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
        { param: { mailboxId, conversationId }, query: {} },
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
    setInitialFocusError(null);
    showView(next);
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
    void focusResults().refresh();
  };

  onMount(() => {
    const tablet = window.matchMedia("(min-width: 48rem)");
    const followViewport = () => setWideLayout(tablet.matches);
    followViewport();
    tablet.addEventListener("change", followViewport);
    onCleanup(() => tablet.removeEventListener("change", followViewport));
    const stop = listenPopState(({ url }) => {
      const parsed = url.searchParams.get("view");
      showView(parsed === "unassigned" || parsed === "waiting" || parsed === "all" ? parsed : "mine");
      const mailboxId = url.searchParams.get("mailbox");
      const conversationId = url.searchParams.get("conversation");
      setSelection(mailboxId && conversationId ? { mailboxId, conversationId } : null);
    });
    onCleanup(() => {
      stop();
    });
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
      {/* A view without a finished read shows its rows still loading, never the empty state. */}
      <Show when={!focusError() && focusItems().length === 0 && !focusEmpty()}>
        <div class="mail-focus-list mail-focus-skeleton" classList={{ "min-h-56": expectedRows() === 0 }} role="status" aria-busy="true">
          <span class="sr-only">{messages().loadingFocus}</span>
          <For each={skeletonRows()}>
            {() => (
              <div class="mail-list-entry mail-focus-row" data-lines="4" aria-hidden="true">
                <span class="mail-list-row">
                  <span class="mail-row-dot" />
                  <span class="mail-row-lines">
                    <span class="mail-row-from">
                      <span class="mail-focus-skeleton-shape" style={{ width: "8rem" }} />
                    </span>
                    <span class="mail-row-subject-line">
                      <span class="mail-focus-skeleton-shape" style={{ width: "60%" }} />
                    </span>
                    <span class="mail-list-preview">
                      <span class="mail-focus-skeleton-shape" style={{ width: "85%" }} />
                    </span>
                    <span class="mail-row-extra">
                      <span class="mail-focus-skeleton-shape" style={{ width: "10rem" }} />
                    </span>
                  </span>
                </span>
              </div>
            )}
          </For>
        </div>
      </Show>
      <Show when={!focusError() && focusItems().length === 0 && focusEmpty()}>
        <Placeholder
          title={
            view() === "mine"
              ? messages().nothingForMe
              : view() === "unassigned"
                ? messages().nothingUnassigned
                : view() === "waiting"
                  ? messages().nothingWaiting
                  : messages().nothingActive
          }
          description={messages().noMatchingConversations}
          icon="ti ti-circle-check"
          class="min-h-56"
        />
      </Show>
      <Show when={!focusError() && focusItems().length > 0}>
        <div class="mail-focus-list" aria-live="polite">
          <For each={focusItems()}>
            {(item) => (
              <a
                href={`/app/mail/${item.mailboxId}?conversation=${item.id}`}
                class="mail-list-entry mail-focus-row"
                classList={{
                  "mail-list-entry-unread": item.unread,
                  "mail-list-entry-active": selection()?.conversationId === item.id && selection()?.mailboxId === item.mailboxId,
                }}
                data-lines="4"
                aria-current={selection()?.conversationId === item.id && selection()?.mailboxId === item.mailboxId ? "true" : undefined}
                onClick={(event) => selectConversation(event, { mailboxId: item.mailboxId, conversationId: item.id })}
              >
                <span class="mail-list-row">
                  <span class="mail-row-dot" aria-hidden="true" />
                  <span class="mail-row-lines">
                    <span class="mail-row-from">
                      <span class="mail-row-sender">{primaryParticipant(item.participantSummary, messages().unknownSender)}</span>
                      <time
                        class="mail-row-time"
                        dateTime={item.latestMessageAt}
                        title={dates.formatDateTime(item.latestMessageAt, props.dateConfig)}
                      >
                        {dates.formatDateTimeRelative(item.latestMessageAt, props.dateConfig)}
                      </time>
                    </span>
                    <span class="mail-row-subject-line">
                      <span class="mail-row-subject">{item.subject || messages().noSubject}</span>
                      <span class="mail-row-marks">
                        <Show when={item.hasAttachments}>
                          <span class="mail-row-mark" role="img" aria-label={messages().attachment}>
                            <i class="ti ti-paperclip" aria-hidden="true" />
                          </span>
                        </Show>
                        <Show when={item.flagged}>
                          <span class="mail-row-mark mail-row-flag" role="img" aria-label={messages().flagged}>
                            <i class="ti ti-flag-filled" aria-hidden="true" />
                          </span>
                        </Show>
                        <Show when={item.assigneeUserIds.length > 0}>
                          <span class="mail-row-mark" role="img" aria-label={messages().assigned}>
                            <i class="ti ti-user-check" aria-hidden="true" />
                          </span>
                        </Show>
                      </span>
                    </span>
                    <span class="mail-list-preview">{item.preview || messages().noPreview}</span>
                    <span class="mail-row-extra">
                      <span class="mail-row-mailbox">
                        <i class="ti ti-inbox" aria-hidden="true" />
                        <span class="mail-row-mailbox-name">{item.mailboxName}</span>
                      </span>
                      <Show when={item.workStatus === "waiting"}>
                        <span class="mail-row-waiting">
                          <i class="ti ti-hourglass" aria-hidden="true" />
                          {messages().waiting}
                        </span>
                      </Show>
                    </span>
                  </span>
                </span>
              </a>
            )}
          </For>
          <Show when={focusResults().hasMore()}>
            <Button
              variant="secondary"
              size="sm"
              class="self-center"
              disabled={focusResults().loadingMore()}
              onClick={() => void focusResults().loadMore()}
            >
              <i class={focusResults().loadingMore() ? "ti ti-loader-2 animate-spin" : "ti ti-chevron-down"} aria-hidden="true" />{" "}
              {messages().loadMore}
            </Button>
          </Show>
        </div>
      </Show>
    </>
  );

  return (
    <AppWorkspace mobileSurface="flush" flat class="mail-focus-workspace">
      <h1 class="sr-only">Mail</h1>
      <MailSidebar
        currentUserEmail={props.currentUserEmail}
        contactDirectory={props.contactDirectory}
        mailboxes={props.mailboxes}
        preferences={mailboxPreferences}
        counts={mailboxCounts()}
        canCreate
        open={null}
        mobile="stacked"
        onMailboxHidden={(mailboxId) => {
          if (selection()?.mailboxId !== mailboxId) return;
          setSelection(null);
          updateSelectionUrl(null);
        }}
      />
      <AppWorkspace.Head
        views={<ViewTabs label={messages().focusView} items={focusTabs()} current={view()} />}
        primary={{ label: messages().compose, icon: "ti ti-pencil", href: "/app/mail/compose" }}
      />
      <AppWorkspace.Content>
        <AppWorkspace.Main
          class="mail-focus-main"
          width="content"
          minWidth={MAIL_FOCUS_MAIN_MIN}
          aria-busy={focusResults().loading() || focusResults().refreshing()}
        >
          <div class="mail-overview-page">
            <div class="mail-overview-list">{focusPanel()}</div>
          </div>
        </AppWorkspace.Main>

        <AppWorkspace.Detail id="mail-focus-detail" open={detailOpen()} onClose={closeDetail} width="lg" resizable={false}>
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
                      mailboxWide={mailboxWide(selected().mailboxId)}
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
                      onCollaborationChange={() => void focusResults().invalidate()}
                      onConversationTagsChange={() => undefined}
                      onClose={closeDetail}
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

export default function MailOverview(props: Parameters<typeof MailOverviewView>[0]) {
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailOverviewView {...props} />
    </MailContactDirectoryProvider>
  );
}
