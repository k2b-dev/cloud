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
import type { MailContactDirectory } from "../contact-directory-settings";
import {
  type DeletedMailbox,
  type DeletedMailboxPage,
  MAX_MAILBOX_PREFERENCES,
  type Mailbox,
  type MailFocusPage,
  type MailFocusView,
} from "../contracts";
import type { MailConversationDetailData } from "../service/workspace";
import { readApiError } from "./_components/api-response";
import MailDetailsPanel from "./_components/MailDetailsPanel";
import { MailContactDirectoryProvider } from "./_components/mail-contact-directory-context";
import { mailboxOverviewSubtitle } from "./_components/mail-health-presentation";
import { mailOverviewMessages } from "./mail-overview-messages";
import { assertCursorProgress } from "./pagination";

type MailboxWithPermission = Mailbox & { permission: "read" | "write" | "admin"; receivingAddress: string | null };
type MailFocusSelection = { mailboxId: string; conversationId: string };
type FocusSource = { view: MailFocusView; excludedMailboxIds: string[] };
type MailboxOverviewItem = { id: string; href: string; name: string; subtitle: string };

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

/** Follow-up dialogs load with the action that opens them, not with the overview. */
type SettingsDialog = typeof import("./_components/MailboxSettingsDialog");
type HealthDialog = typeof import("./_components/MailboxHealthDialog");

function MailOverviewView(props: {
  mailboxes: MailboxWithPermission[];
  initialFocus: MailFocusPage;
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
  const [pinnedMailboxIds, setPinnedMailboxIds] = createSignal(props.initialPinnedMailboxIds);
  const [hiddenMailboxIds, setHiddenMailboxIds] = createSignal(props.initialHiddenMailboxIds);
  const [mailboxAnnouncement, setMailboxAnnouncement] = createSignal("");
  const [initialFocusError, setInitialFocusError] = createSignal(props.initialFocusError);
  const mailboxIsHidden = (mailboxId: string) => hiddenMailboxIds().includes(mailboxId);
  // Focus leaves out every stored hidden mailbox, as on the server, including one beyond the
  // listed mailboxes; the server ignores IDs of mailboxes that are gone or unreadable.
  const focusSource = (): FocusSource => ({ view: view(), excludedMailboxIds: hiddenMailboxIds() });
  const focusResults = queries.createInfinite<FocusSource, MailFocusPage, string>({
    source: focusSource,
    isSameSource: (left, right) => left.view === right.view && left.excludedMailboxIds.join() === right.excludedMailboxIds.join(),
    initial: { source: focusSource(), pages: [props.initialFocus] },
    loadPage: async (source, { cursor, abortSignal }) => {
      const excludeMailboxIds = source.excludedMailboxIds.join(",") || undefined;
      const response = await apiClient.overview.conversations.$get(
        { query: { view: source.view, limit: "50", cursor, excludeMailboxIds } },
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
  // Rows of a mailbox hidden a moment ago leave before the refreshed page arrives.
  const focusItems = createMemo(() =>
    focusResults
      .pages()
      .flatMap((page) => page.items)
      .filter((item) => !mailboxIsHidden(item.mailboxId)),
  );
  const counts = () => focusResults.pages()[0]?.counts ?? props.initialFocus.counts;
  const mailboxCounts = () => focusResults.pages()[0]?.mailboxCounts ?? props.initialFocus.mailboxCounts;
  const mailboxCountsById = createMemo(() => new Map(mailboxCounts().map((item) => [item.mailboxId, item])));
  // Counts stay out of the items: a refreshed Focus page then updates the rows in place
  // instead of recreating them, which would drop keyboard focus.
  const mailboxOverviewItems = createMemo<MailboxOverviewItem[]>(() =>
    props.mailboxes.map((mailbox) => ({
      id: mailbox.id,
      href: `/app/mail/${mailbox.id}?view=needs_action`,
      name: mailbox.name,
      subtitle: mailboxOverviewSubtitle(mailbox, locale()),
    })),
  );
  const mailboxStats = (mailboxId: string) => mailboxCountsById().get(mailboxId) ?? { unread: 0, needsAction: 0 };
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
  const visibleMailboxItems = createMemo(() => orderedMailboxOverviewItems().filter((mailbox) => !mailboxIsHidden(mailbox.id)));
  const hiddenMailboxItems = createMemo(() => orderedMailboxOverviewItems().filter((mailbox) => mailboxIsHidden(mailbox.id)));
  const mailboxIsPinned = (mailboxId: string) => pinnedMailboxIds().includes(mailboxId);
  const mailboxRowElement = (mailboxId: string | undefined) =>
    mailboxId ? document.querySelector<HTMLElement>(`.mail-overview-mailbox[data-mailbox="${mailboxId}"]`) : null;
  const mailboxLink = (mailboxId: string | undefined) => mailboxRowElement(mailboxId)?.querySelector<HTMLElement>("a") ?? null;
  const mailboxHasFocus = (mailboxId: string) => mailboxRowElement(mailboxId)?.contains(document.activeElement) ?? false;
  // Pinning, hiding, and showing move a row or recreate it in the other section, and the
  // browser then drops keyboard focus on the page body. Put it on the given target instead.
  const restoreMailboxFocus = (hadFocus: boolean, target: HTMLElement | null) => {
    if (hadFocus && (!document.activeElement || document.activeElement === document.body)) target?.focus();
  };
  // Pins and hidden mailboxes belong to the person and apply on every device. The row moves at
  // once and saves run in order. A failed save puts the mailbox back where the server last
  // confirmed it, so overlapping changes never leave a state the server does not have.
  const confirmedPreferences = { pinned: props.initialPinnedMailboxIds, hidden: props.initialHiddenMailboxIds };
  let preferenceSaves = Promise.resolve();
  /** Puts the mailbox at `index`, or leaves it out with -1. */
  const placeMailbox = (ids: string[], mailboxId: string, index: number) => {
    const others = ids.filter((id) => id !== mailboxId);
    return index === -1 ? others : [...others.slice(0, index), mailboxId, ...others.slice(index)];
  };
  // A new pin or hide is the newest; an existing one keeps its place.
  const withPreference = (ids: string[], mailboxId: string, value: boolean) =>
    ids.includes(mailboxId) === value ? ids : placeMailbox(ids, mailboxId, value ? 0 : -1);
  /** Returns false when the list is full, so the row stays where it is. */
  const changeMailboxPreference = (mailboxId: string, preference: "pinned" | "hidden", value: boolean): boolean => {
    const [shown, setShown] = preference === "pinned" ? [pinnedMailboxIds, setPinnedMailboxIds] : [hiddenMailboxIds, setHiddenMailboxIds];
    // Focus leaves out every hidden mailbox in one request, so the lists stay within its limit.
    if (value && shown().length >= MAX_MAILBOX_PREFERENCES) {
      const count = formatCount(MAX_MAILBOX_PREFERENCES);
      toast.error(preference === "pinned" ? messages().pinLimitReached({ count }) : messages().hideLimitReached({ count }));
      return false;
    }
    setShown((ids) => withPreference(ids, mailboxId, value));
    preferenceSaves = preferenceSaves.then(async () => {
      try {
        const response = await apiClient.mailboxes[":mailboxId"].preference.$patch({
          param: { mailboxId },
          json: preference === "pinned" ? { pinned: value } : { hidden: value },
        });
        if (!response.ok) throw new Error(await readApiError(response, messages().failedSaveMailboxPreference));
        const saved = await response.json();
        confirmedPreferences[preference] = withPreference(confirmedPreferences[preference], mailboxId, saved[preference]);
      } catch (error) {
        const index = confirmedPreferences[preference].indexOf(mailboxId);
        setShown((ids) => placeMailbox(ids, mailboxId, index));
        toast.error(error instanceof Error ? error.message : messages().failedSaveMailboxPreference);
      }
    });
    return true;
  };
  const toggleMailboxPin = (mailbox: MailboxOverviewItem) => {
    const pin = !mailboxIsPinned(mailbox.id);
    const hadFocus = mailboxHasFocus(mailbox.id);
    if (!changeMailboxPreference(mailbox.id, "pinned", pin)) return;
    setMailboxAnnouncement(pin ? messages().pinned({ name: mailbox.name }) : messages().unpinned({ name: mailbox.name }));
    restoreMailboxFocus(hadFocus, mailboxLink(mailbox.id));
  };
  const toggleMailboxHidden = (mailbox: MailboxOverviewItem) => {
    const hide = !mailboxIsHidden(mailbox.id);
    const hadFocus = mailboxHasFocus(mailbox.id);
    const visible = visibleMailboxItems();
    const position = visible.findIndex((item) => item.id === mailbox.id);
    const neighborId = (visible[position + 1] ?? visible[position - 1])?.id;
    if (!changeMailboxPreference(mailbox.id, "hidden", hide)) return;
    setMailboxAnnouncement(hide ? messages().mailboxHidden({ name: mailbox.name }) : messages().mailboxShown({ name: mailbox.name }));
    if (hide && selection()?.mailboxId === mailbox.id) {
      setSelection(null);
      updateSelectionUrl(null);
    }
    // A hidden row lands in the collapsed Hidden section: focus the row that took its place, or
    // that section once the list is empty. A shown row stays reachable, so focus follows it.
    restoreMailboxFocus(
      hadFocus,
      hide
        ? (mailboxLink(neighborId) ?? document.querySelector<HTMLElement>(".mail-overview-hidden-mailboxes button[aria-expanded]"))
        : mailboxLink(mailbox.id),
    );
  };
  const canWriteMailbox = (mailboxId: string) => {
    const permission = props.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.permission;
    return permission === "write" || permission === "admin";
  };
  /** False where the person sees only the conversations assigned to them. */
  const mailboxWide = (mailboxId: string) => props.mailboxes.find((mailbox) => mailbox.id === mailboxId)?.accessScope !== "assigned";
  const focusScope = () => {
    const hidden = hiddenMailboxItems().length;
    return hidden > 0 ? messages().allMailboxesExceptHidden({ count: hidden }) : messages().allMailboxes;
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

  const createMailbox = mutations.create<{ mailbox: Mailbox; settings?: SettingsDialog } | null, void>({
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
      // The follow-up dialog loads during the request, behind the same pending state. Without its code, for example
      // in a tab opened before a release, the new mailbox still opens and its settings stay one click away.
      const settings = import("./_components/MailboxSettingsDialog").catch(() => undefined);
      const response = await apiClient.mailboxes.$post(
        { json: { name: values.name, description: values.description || null } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await readApiError(response, messages().failedCreateMailbox));
      return { mailbox: await response.json(), settings: await settings };
    },
    onSuccess: (created) => {
      if (!created) return;
      const { mailbox, settings } = created;
      toast.success(messages().mailboxCreated);
      if (!settings) return navigateTo(`/app/mail/${mailbox.id}`);
      void settings
        .openMailboxSettingsDialog({
          mailboxId: mailbox.id,
          currentUserEmail: props.currentUserEmail,
          contactDirectory: props.contactDirectory,
          initialTab: "delivery",
        })
        .then((result) => navigateTo(result.deleted ? "/app/mail" : `/app/mail/${mailbox.id}`));
    },
    onError: (error) => prompts.error(error.message),
  });

  const restoreMailbox = mutations.create<{ mailbox: Mailbox; health?: HealthDialog } | null, string>({
    mutation: async (mailboxId, { abortSignal }) => {
      const confirmed = await prompts.confirm(messages().restoreWarning, {
        title: messages().restoreMailbox,
        confirmText: messages().restoreMailbox,
      });
      if (!confirmed || abortSignal.aborted) return null;
      // As for a new mailbox: the health dialog loads during the request, and without it the mailbox still opens.
      const health = import("./_components/MailboxHealthDialog").catch(() => undefined);
      const response = await apiClient.mailboxes[":mailboxId"].restore.$post({ param: { mailboxId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await readApiError(response, messages().failedRestoreMailbox));
      return { mailbox: await response.json(), health: await health };
    },
    onSuccess: (restored) => {
      if (!restored) return;
      const { mailbox, health } = restored;
      void deletedResults.refresh();
      toast.success(messages().mailboxRestored);
      if (!health) return navigateTo(`/app/mail/${mailbox.id}`);
      void health.openMailboxHealthDialog({ mailboxId: mailbox.id }).then(() => navigateTo(`/app/mail/${mailbox.id}`));
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

  const mailboxRow = (mailbox: MailboxOverviewItem) => {
    const pinned = () => mailboxIsPinned(mailbox.id);
    const hidden = () => mailboxIsHidden(mailbox.id);
    const stats = () => mailboxStats(mailbox.id);
    // One number per row: needs action. Unread is a dot; both exact counts live in the tooltip and sr-only text.
    const countLabels = () => [
      ...(stats().needsAction > 0 ? [messages().needsActionCount({ count: stats().needsAction })] : []),
      ...(stats().unread > 0 ? [messages().unreadCount({ count: stats().unread })] : []),
    ];
    return (
      <AppWorkspace.SidebarItem
        variant="object"
        href={mailbox.href}
        title={[mailbox.name, mailbox.subtitle, ...countLabels()].join(" · ")}
        description={mailbox.subtitle}
        class="mail-overview-mailbox"
        data={{ mailbox: mailbox.id, pinned: pinned() && !hidden() ? "true" : undefined, hidden: hidden() ? "true" : undefined }}
        actions={
          <AppWorkspace.SidebarItemActions visibility="hover">
            <Show
              when={!hidden()}
              fallback={
                <IconButton
                  label={messages().showMailbox({ name: mailbox.name })}
                  size="xs"
                  variant="text"
                  onClick={() => toggleMailboxHidden(mailbox)}
                >
                  <i class="ti ti-eye" aria-hidden="true" />
                </IconButton>
              }
            >
              <IconButton
                label={pinned() ? messages().unpinMailbox({ name: mailbox.name }) : messages().pinMailbox({ name: mailbox.name })}
                size="xs"
                variant="text"
                aria-pressed={pinned()}
                onClick={() => toggleMailboxPin(mailbox)}
              >
                <i class={`ti ${pinned() ? "ti-flag-off" : "ti-flag"}`} aria-hidden="true" />
              </IconButton>
              <IconButton
                label={messages().hideMailbox({ name: mailbox.name })}
                size="xs"
                variant="text"
                onClick={() => toggleMailboxHidden(mailbox)}
              >
                <i class="ti ti-eye-off" aria-hidden="true" />
              </IconButton>
            </Show>
          </AppWorkspace.SidebarItemActions>
        }
      >
        <AppWorkspace.SidebarItemIcon>
          <i class={hidden() ? "ti ti-eye-off" : pinned() ? "ti ti-flag" : "ti ti-mail"} />
          <Show when={stats().unread > 0}>
            <span class="mail-overview-unread-dot" />
          </Show>
        </AppWorkspace.SidebarItemIcon>
        <AppWorkspace.SidebarItemLabel>{mailbox.name}</AppWorkspace.SidebarItemLabel>
        <AppWorkspace.SidebarItemMeta>
          <span class="mail-overview-needs-action" aria-hidden="true">
            {stats().needsAction > 0 ? formatCount(stats().needsAction) : ""}
          </span>
          <Show when={countLabels().length > 0}>
            <span class="sr-only">{countLabels().join(", ")}</span>
          </Show>
        </AppWorkspace.SidebarItemMeta>
      </AppWorkspace.SidebarItem>
    );
  };

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
            <AppWorkspace.SidebarSection title={messages().mailboxes} count={visibleMailboxItems().length}>
              <For each={visibleMailboxItems()}>{mailboxRow}</For>
            </AppWorkspace.SidebarSection>
            <Show when={hiddenMailboxItems().length > 0}>
              <AppWorkspace.SidebarSection
                class="mail-overview-hidden-mailboxes"
                title={messages().hiddenMailboxes}
                count={hiddenMailboxItems().length}
                collapsible
                defaultOpen={false}
              >
                <For each={hiddenMailboxItems()}>{mailboxRow}</For>
              </AppWorkspace.SidebarSection>
            </Show>
            <span class="sr-only" aria-live="polite">
              {mailboxAnnouncement()}
            </span>
          </AppWorkspace.SidebarBody>
          <AppWorkspace.SidebarFooter>
            <AppWorkspace.SidebarItem
              icon="ti ti-mail-plus"
              disabled={createMailbox.loading()}
              title={messages().newMailbox}
              onClick={() => createMailbox.mutate()}
            >
              {createMailbox.loading() ? messages().creatingMailbox : messages().newMailbox}
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem
              icon="ti ti-trash"
              title={messages().recentlyDeletedMailboxes}
              onClick={() => setDeletedOpen((open) => !open)}
            >
              <AppWorkspace.SidebarItemLabel>{messages().recentlyDeletedMailboxes}</AppWorkspace.SidebarItemLabel>
              <AppWorkspace.SidebarItemMeta>
                <i class={deletedOpen() ? "ti ti-chevron-up" : "ti ti-chevron-down"} aria-hidden="true" />
              </AppWorkspace.SidebarItemMeta>
            </AppWorkspace.SidebarItem>
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
        <AppWorkspace.Main class="mail-focus-main" width="content" aria-busy={focusResults.loading() || focusResults.refreshing()}>
          <div class="mail-overview-page">
            <PanelHeader
              as="h2"
              size="lg"
              title={messages().focus}
              subtitle={`${focusDescription()} · ${focusScope()}`}
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
                {focusScope()}
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

export default function MailOverview(props: Parameters<typeof MailOverviewView>[0]) {
  return (
    <MailContactDirectoryProvider value={props.contactDirectory}>
      <MailOverviewView {...props} />
    </MailContactDirectoryProvider>
  );
}
