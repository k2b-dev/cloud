import { SearchBar, WorkspaceNavigationProvider } from "@k2b/cloud/ssr/islands";
import { documentNavigate, listenPopState, navigate, navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { cookies } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  bottomSheetOptions,
  Calendar,
  type CalendarEvent,
  Chart,
  createNavigation,
  DataTable,
  type DataTableColumn,
  Dropdown,
  dialogCore,
  FilterChip,
  Pagination,
  Placeholder,
  panelDialogOptions,
  prompts,
  StatCell,
  StatGrid,
  StatusBadge,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { FeedbackEntry, PublicSection, PublicSectionInput, ShiftAssignment, UpcomingSlot } from "../../contracts";
import { venueMessages } from "../../messages";
import { formatDateKey, formatVenueDateTime, formatVenueSpan, formatVenueTime, formatVenueWeekdayTime } from "../../time-format";
import { loadVenueDashboard, sameVenueDashboardSource, shiftDate } from "../dashboard-query";
import {
  assignmentSelectionId,
  CALENDAR_VIEW_COOKIE,
  calendarLinkView,
  PHONE_VIEWPORT_QUERY,
  parseShiftSelection,
  scheduleHref,
  slotSelectionId,
  type VenueCalendarView,
  WIDE_VIEWPORT_QUERY,
} from "../schedule-url";
import { reconcileChangedSettings } from "../settings-contract";
import { CalendarSubscriptionDialog } from "./venue-workspace/calendar-subscription";
import { openVenuePublicDisplayDialog } from "./venue-workspace/public-display";
import { PublicSectionDialog, PublicSectionPreview, sectionKindIcon, sectionKindLabel } from "./venue-workspace/public-sections";
import { ProgressBar, SlotStateLabel, slotStaffingLabel, slotState } from "./venue-workspace/schedule";
import { SettingsDialog } from "./venue-workspace/settings";
import { announceTaken, cancelAssignment, confirmLeave, confirmRemove, createActionKeys, takeShift } from "./venue-workspace/shift-actions";
import {
  assignmentActionKey,
  FOLLOWING_WEEKS,
  resolveShiftSelection,
  ShiftDetailPanel,
  ShiftDetailSheet,
  slotActionKey,
} from "./venue-workspace/shift-detail";
import { SignupDialog } from "./venue-workspace/signup";
import { VenueTimeZoneNote } from "./venue-workspace/time-zone-note";
import type { FeedbackRange, VenueView, VenueWorkspaceProps } from "./venue-workspace/types";
import { canAdmin, canWrite, dateKey, isSlotActive, parseDateKey, readError, timeZoneDateConfig } from "./venue-workspace/utils";

function ViewHeader(props: { title: string; description: string; action?: JSX.Element }) {
  return (
    <div class="flex min-w-0 flex-col gap-2 px-1 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0">
        <h1 class="text-base font-semibold text-primary">{props.title}</h1>
        <p class="text-xs text-dimmed">{props.description}</p>
      </div>
      <Show when={props.action}>
        <div class="flex shrink-0 flex-wrap gap-2">{props.action}</div>
      </Show>
    </div>
  );
}

export default function VenueWorkspace(props: VenueWorkspaceProps) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const views = () => [
    { id: "shifts" as const, label: t().schedule, icon: "ti ti-calendar-event" },
    { id: "my-shifts" as const, label: t().myShifts, icon: "ti ti-user-check" },
    // Visitor feedback is for staff and admins; the server leaves it out for read access.
    ...(canWrite(venue()) ? [{ id: "feedback" as const, label: t().feedback, icon: "ti ti-message-star" }] : []),
  ];
  const feedbackRangeOptions = () => [
    {
      options: [7, 14, 30].map((count) => ({
        value: String(count),
        label: t().lastDays({ count }),
        icon: count === 7 ? "ti ti-calendar-week" : count === 14 ? "ti ti-calendar" : "ti ti-calendar-month",
      })),
    },
  ];
  const dashboardQuery = query.create({
    source: () => props.dashboardSource,
    initial: { source: props.dashboardSource, data: props.dashboard },
    isSameSource: sameVenueDashboardSource,
    load: (source, { abortSignal }) => loadVenueDashboard(source, abortSignal, t().refreshFailed),
  });
  const dashboard = () => dashboardQuery.data() ?? props.dashboard;
  const venue = () => dashboard().venue;
  const [view] = createSignal<VenueView>(props.initialView);
  const [selectedSectionId, setSelectedSectionId] = createSignal(props.initialSectionId ?? null);
  const [calendarView] = createSignal<VenueCalendarView>(props.initialCalendarView);
  const [calendarDate] = createSignal(parseDateKey(props.initialCalendarDate));
  const [gapsOnly, setGapsOnly] = createSignal(props.initialGapsOnly === true);
  const [selectedShiftId, setSelectedShiftId] = createSignal<string | null>(props.initialShiftId ?? null);
  // The server cannot know the width: it renders the side panel, which CSS hides below 1024 px until hydration.
  const [wide, setWide] = createSignal(true);
  const [phone, setPhone] = createSignal(false);
  const [prompting, setPrompting] = createSignal(false);
  /** Running writes by the slot, sign-up, or section they change; unrelated actions stay available. */
  const actions = createActionKeys();
  let disposed = false;
  /** Opens one dialog at a time; a second click while a dialog is on its way does nothing. */
  const runPromptedAction = async <T,>(readIntent: () => Promise<T>, applyIntent: (intent: T) => Promise<void>) => {
    if (prompting()) return;
    setPrompting(true);
    try {
      const intent = await readIntent();
      if (disposed) return;
      await applyIntent(intent);
    } finally {
      setPrompting(false);
    }
  };
  const viewHref = (next: VenueView) => `/app/venue/${venue().id}/${next}`;
  const feedbackRangeDays = createMemo(() => props.initialFeedbackDays);
  const feedbackComments = () => props.initialFeedbackComments === true;
  /** The feedback view with its filters in the URL; the search box submits `search` itself. */
  const feedbackFilterUrl = (filters: { days?: FeedbackRange; comments?: boolean; search?: string } = {}, withSearch = true) => {
    const days = filters.days ?? feedbackRangeDays();
    const comments = filters.comments ?? feedbackComments();
    const search = filters.search ?? props.initialFeedbackSearch;
    const url = new URL(viewHref("feedback"), "http://venue.local");
    if (days !== 30) url.searchParams.set("days", String(days));
    if (comments) url.searchParams.set("comments", "1");
    if (withSearch && search) url.searchParams.set("search", search);
    return `${url.pathname}${url.search}`;
  };
  const feedbackSearchAction = createMemo(() => feedbackFilterUrl({}, false));
  const setFeedbackDays = (value: string[]) => {
    const next = Number(value[0] ?? 30);
    navigateTo(feedbackFilterUrl({ days: next === 7 || next === 14 ? next : 30 }));
  };
  const setFeedbackComments = (value: string[]) => navigateTo(feedbackFilterUrl({ comments: value[0] === "comments" }));
  // The server scopes counts, buckets, and entries to the same feedback window.
  const feedbackBuckets = () => dashboard().feedback?.buckets ?? [];
  const feedbackAverage = () => dashboard().feedback?.averageRating ?? null;
  /** The list's place in all matching entries; `null` while the loaded view carries no entries. */
  const feedbackPage = () => {
    const page = dashboard().feedbackEntriesPage;
    return page && page.total > 0 ? page : null;
  };
  const feedbackPageBaseUrl = () => {
    const url = new URL(feedbackFilterUrl(), "http://venue.local");
    url.searchParams.set("page", "");
    return `${url.pathname}?${url.searchParams.toString()}`;
  };
  const formatAverage = (value: number) =>
    `${new Intl.NumberFormat(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)}/5`;
  const feedbackChartLabels = createMemo(() => feedbackBuckets().map((bucket) => formatDateKey(bucket.date, locale())));
  const feedbackCountData = createMemo(() =>
    feedbackBuckets().map((bucket, index) => ({ label: feedbackChartLabels()[index] ?? bucket.date, value: bucket.count })),
  );
  const feedbackChartData = createMemo(() =>
    feedbackBuckets()
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket }) => bucket.averageRating !== null)
      .map(({ bucket, index }) => ({ x: index + 1, y: bucket.averageRating ?? 0 })),
  );
  // Shift sign-up needs staff access and a Venue that takes sign-ups for its shifts; the server enforces both.
  const canJoinShifts = () => canWrite(venue()) && venue().signupMode !== "free";
  /** Midday of the first and last day the calendar grid shows (weeks start on Monday). */
  const calendarTimes = createMemo(() => {
    const key = dateKey(calendarDate());
    if (calendarView() === "day") return [`${key}T12:00:00Z`];
    const weekStart = (day: string) => shiftDate(day, -((parseDateKey(day).getUTCDay() + 6) % 7));
    const month = calendarView() === "month" || calendarView() === "mobile-month";
    const first = month ? `${key.slice(0, 7)}-01` : key;
    const last = month ? shiftDate(`${shiftDate(first, 31).slice(0, 7)}-01`, -1) : key;
    return [`${weekStart(first)}T12:00:00Z`, `${shiftDate(weekStart(last), 6)}T12:00:00Z`];
  });
  const feedbackColumns: DataTableColumn<FeedbackEntry>[] = [
    { id: "rating", header: t().rating, value: (entry) => entry.rating, cellClass: "w-px" },
    { id: "comment", header: t().comment, value: (entry) => entry.comment, cellClass: "min-w-64" },
    { id: "created", header: t().submitted, value: (entry) => entry.createdAt, headerClass: "w-px", cellClass: "w-px whitespace-nowrap" },
  ];
  const selectedSection = createMemo(() => dashboard().sections.find((section) => section.id === selectedSectionId()) ?? null);
  const slotByKey = createMemo(() => new Map(dashboard().slots.map((slot) => [slotSelectionId(slot.template.id, slot.date), slot])));
  const otherAssignmentByKey = createMemo(
    () => new Map(dashboard().otherAssignments.map((assignment) => [assignmentSelectionId(assignment.id), assignment])),
  );
  /** A gap is a shift that has not ended and still misses people. */
  const isGap = (slot: UpcomingSlot) => slot.missingPeople > 0 && isSlotActive(slot);
  /** An assignment carries its shift's name, also once the template is paused or deleted; free time has none. */
  const assignmentTitle = (assignment: ShiftAssignment) => assignment.templateTitle ?? t().freeTime;
  const shiftEvents = createMemo<CalendarEvent[]>(() => [
    ...dashboard()
      .slots.filter((slot) => !gapsOnly() || isGap(slot))
      .map((slot) => ({
        id: slotSelectionId(slot.template.id, slot.date),
        title: slot.template.title,
        start: slot.startsAt,
        end: slot.endsAt,
        color: slotState(slot, t()).color,
        meta: slot.assignments.map((entry) => entry.userDisplayName).join(", ") || t().noOneYet,
        description: slotStaffingLabel(slot, t()),
      })),
    // Free time and other sign-ups outside the shifts have no target, so the gaps filter leaves them out.
    ...(gapsOnly()
      ? []
      : dashboard().otherAssignments.map(
          (assignment): CalendarEvent => ({
            id: assignmentSelectionId(assignment.id),
            title: assignmentTitle(assignment),
            start: assignment.startsAt,
            end: assignment.endsAt,
            color: "violet",
            meta: assignment.userDisplayName,
            description: assignment.note ?? undefined,
          }),
        )),
  ]);
  const sectionHref = (section: PublicSection) => `/app/venue/${venue().id}/public-sections/${section.id}`;
  // Only admins manage sections; others see the group only when their view contains a section.
  const showPublicContent = () => canAdmin(venue()) || dashboard().sections.length > 0;
  const collapsedPublicContentMenu = () => [
    {
      sectionLabel: t().publicContent,
      items: [
        ...(canAdmin(venue()) ? [{ icon: "ti ti-plus", label: t().addPublicSection, action: () => void openAddSection() }] : []),
        ...dashboard().sections.map((section) => ({
          icon: sectionKindIcon(section.kind),
          label: section.title,
          description: section.enabled ? undefined : t().sectionDraft,
          href: sectionHref(section),
        })),
      ],
    },
  ];
  const calendarHref = (nextView: VenueCalendarView, nextDate: Date | string, shift: string | null = null, gaps = gapsOnly()) =>
    scheduleHref(venue().id, {
      view: nextView,
      date: typeof nextDate === "string" ? nextDate : dateKey(nextDate),
      gaps,
      shift,
    });

  // The selected shift lives in the URL (`?shift=`), so reload and Back restore it.
  const selection = createMemo(() =>
    view() === "shifts" && !selectedSectionId() ? resolveShiftSelection(dashboard(), selectedShiftId()) : null,
  );
  const selectedEventId = createMemo(() => selection()?.eventId ?? null);
  type SelectionHistoryState = { venueShiftSelection?: boolean } | null;
  const selectShift = (id: string) => {
    // Switching from one selected shift to another replaces its entry, so Back and closing leave the detail.
    const replace = Boolean(selectedShiftId() && (window.history.state as SelectionHistoryState)?.venueShiftSelection);
    setSelectedShiftId(id);
    navigate(calendarHref(calendarView(), calendarDate(), id), {
      replace,
      scroll: "preserve",
      viewTransition: false,
      state: { venueShiftSelection: true },
    });
  };
  const clearSelection = () => {
    if (!selectedShiftId()) return;
    setSelectedShiftId(null);
    // Closing a detail this page opened goes back to where the person came from; a shared link just drops `shift`.
    if ((window.history.state as SelectionHistoryState)?.venueShiftSelection) window.history.back();
    else navigate(calendarHref(calendarView(), calendarDate()), { replace: true, scroll: "preserve", viewTransition: false });
  };
  const setGapsFilter = (value: string[]) => {
    const next = value[0] === "gaps";
    setGapsOnly(next);
    navigate(calendarHref(calendarView(), calendarDate(), selectedShiftId(), next), {
      replace: true,
      scroll: "preserve",
      viewTransition: false,
      state: window.history.state,
    });
  };

  const openSignup = async () => {
    const snapshot = dashboard();
    await runPromptedAction(
      () =>
        dialogCore.open<boolean>(
          (close, context) => (
            <SignupDialog dashboard={snapshot} userId={props.userId} close={close} setDismissHandler={context.setDismissHandler} />
          ),
          panelDialogOptions,
        ),
      async (changed) => {
        await reconcileChangedSettings(changed, async () => {
          await reconcileDashboard();
        });
      },
    );
  };
  const openPublicPage = () => openVenuePublicDisplayDialog(venue().id, locale());
  // Renewing replaces the token on the server, so every later dialog has to start from the new URL.
  const [calendarUrl, setCalendarUrl] = createSignal(props.calendarUrl);
  const openCalendarSubscription = () =>
    dialogCore.open<void>(
      (close) => <CalendarSubscriptionDialog url={calendarUrl()} onRenewed={setCalendarUrl} close={() => close()} />,
      panelDialogOptions,
    );

  const takeFromDetail = (slot: UpcomingSlot, followingWeeks: boolean) =>
    actions.run([slotActionKey(slot)], async (signal) => {
      const added = await takeShift(
        {
          venueId: venue().id,
          templateId: slot.template.id,
          date: slot.date,
          // This shift and the same shift in each of the following weeks.
          weeks: followingWeeks ? FOLLOWING_WEEKS + 1 : undefined,
        },
        signal,
        t(),
      );
      announceTaken(added, t());
      if (added > 0) await reconcileDashboard();
    });

  /** After a sign-up disappears, a detail that showed only that sign-up closes. */
  const dropStaleSelection = () => {
    if (selectedShiftId() && !selection()) clearSelection();
  };
  const leaveShift = async (assignment: ShiftAssignment) => {
    if (!(await confirmLeave(assignment, venue().timezone, locale(), t()))) return;
    const venueId = venue().id;
    await actions.run([assignmentActionKey(assignment)], async (signal) => {
      await cancelAssignment({ venueId, assignmentId: assignment.id }, signal, t().leaveShiftFailed);
      await reconcileDashboard(t().shiftLeft);
    });
    if (!disposed) dropStaleSelection();
  };
  const removePerson = async (assignment: ShiftAssignment) => {
    if (!(await confirmRemove(assignment, venue().timezone, locale(), t()))) return;
    const venueId = venue().id;
    await actions.run([assignmentActionKey(assignment)], async (signal) => {
      await cancelAssignment({ venueId, assignmentId: assignment.id }, signal, t().removeFromShiftFailed);
      await reconcileDashboard(t().personRemoved);
    });
    if (!disposed) dropStaleSelection();
  };
  const detailProps = () => ({
    venue: venue(),
    userId: props.userId,
    pending: actions.pending,
    onTake: (slot: UpcomingSlot, followingWeeks: boolean) => void takeFromDetail(slot, followingWeeks),
    onLeave: (assignment: ShiftAssignment) => void leaveShift(assignment),
    onRemove: (assignment: ShiftAssignment) => void removePerson(assignment),
  });

  /** Below 1024 px the detail opens as a bottom sheet; dismissing it ends the selection. */
  let sheet: AbortController | null = null;
  const openSheet = () => {
    if (sheet) return;
    const controller = new AbortController();
    sheet = controller;
    void dialogCore
      .open<void>(
        (_close, context) => (
          <Show when={selection()}>
            {(current) => <ShiftDetailSheet selection={current()} {...detailProps()} onDismiss={context.requestDismiss} />}
          </Show>
        ),
        { ...bottomSheetOptions, signal: controller.signal },
      )
      .then(() => {
        if (sheet !== controller) return;
        sheet = null;
        if (!disposed) clearSelection();
      });
  };
  const closeSheet = () => {
    const controller = sheet;
    sheet = null;
    controller?.abort();
  };
  createEffect(
    on([selectedEventId, wide], ([eventId, isWide]) => {
      if (eventId && !isWide) openSheet();
      else closeSheet();
    }),
  );

  const openSettings = async () => {
    const snapshot = dashboard();
    await runPromptedAction(
      () =>
        prompts.dialog<boolean>(
          (close) => (
            <SettingsDialog
              dashboard={snapshot}
              accessEntries={props.accessEntries}
              apiKeys={props.apiKeys}
              onOpenCalendarSubscription={openCalendarSubscription}
              close={close}
            />
          ),
          {
            surface: "bare",
            header: false,
            size: "large",
            cancelBehavior: "ignore",
          },
        ),
      async (changed) => {
        await reconcileChangedSettings(changed, async () => {
          await reconcileDashboard();
        });
      },
    );
  };

  const reconcileDashboard = async (successMessage?: string): Promise<boolean> => {
    try {
      await dashboardQuery.invalidate();
      if (successMessage) toast.success(successMessage);
      return true;
    } catch {
      prompts.error(t().savedRefreshFailed);
      return false;
    }
  };

  const addSection = (venueId: string, input: PublicSectionInput) =>
    actions.run(["section:add"], async (signal) => {
      const res = await apiClient.venues[":id"].sections.$post({ param: { id: venueId }, json: input }, { init: { signal } });
      if (!res.ok) throw new Error(await readError(res, t().addSectionFailed));
      await reconcileDashboard();
    });

  const openAddSection = async () => {
    const intent = { venueId: venue().id, nextPosition: dashboard().sections.length + 1, publicPageEnabled: venue().publicEnabled };
    await runPromptedAction(
      () =>
        dialogCore.open<PublicSectionInput | null>(
          (close) => <PublicSectionDialog close={close} nextPosition={intent.nextPosition} publicPageEnabled={intent.publicPageEnabled} />,
          panelDialogOptions,
        ),
      async (input) => {
        if (input) await addSection(intent.venueId, input);
      },
    );
  };

  /** Editing and deleting one section conflict; each shows progress only on its own button. */
  const sectionKey = (sectionId: string) => `section:${sectionId}`;
  const editSection = (venueId: string, sectionId: string, input: PublicSectionInput) =>
    actions.run([sectionKey(sectionId), `${sectionKey(sectionId)}:edit`], async (signal) => {
      const res = await apiClient.venues[":id"].sections[":resourceId"].$patch(
        { param: { id: venueId, resourceId: sectionId }, json: input },
        { init: { signal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().updateSectionFailed));
      await reconcileDashboard(t().sectionUpdated);
    });

  const openEditSection = async (section: PublicSection) => {
    const intent = {
      venueId: venue().id,
      sectionId: section.id,
      section: { ...section, content: { ...section.content } },
      publicPageEnabled: venue().publicEnabled,
    };
    await runPromptedAction(
      () =>
        dialogCore.open<PublicSectionInput | null>(
          (close) => (
            <PublicSectionDialog
              close={close}
              initial={intent.section}
              nextPosition={intent.section.position}
              publicPageEnabled={intent.publicPageEnabled}
              title={t().editPublicSection}
              submitLabel={t().saveSection}
            />
          ),
          panelDialogOptions,
        ),
      async (input) => {
        if (input) await editSection(intent.venueId, intent.sectionId, input);
      },
    );
  };

  /** A copy is a new section, so it conflicts only with another copy of the same section. */
  const duplicatePublicSection = (section: PublicSection) => {
    const venueId = venue().id;
    const input: PublicSectionInput = {
      kind: section.kind,
      title: t().sectionCopy({ title: section.title }),
      content: { ...section.content },
      enabled: section.enabled,
      position: dashboard().sections.length + 1,
    };
    return actions.run([`${sectionKey(section.id)}:copy`], async (signal) => {
      const res = await apiClient.venues[":id"].sections.$post({ param: { id: venueId }, json: input }, { init: { signal } });
      if (!res.ok) throw new Error(await readError(res, t().duplicateSectionFailed));
      await reconcileDashboard(t().sectionDuplicated);
    });
  };

  const deleteSection = (venueId: string, sectionId: string) =>
    actions.run([sectionKey(sectionId), `${sectionKey(sectionId)}:delete`], async (signal) => {
      const res = await apiClient.venues[":id"].sections[":resourceId"].$delete(
        { param: { id: venueId, resourceId: sectionId } },
        { init: { signal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().deleteSectionFailed));
      if (await reconcileDashboard(t().sectionDeleted)) {
        setSelectedSectionId(null);
        window.history.replaceState({}, "", viewHref("shifts"));
      }
    });

  const confirmDeleteSection = async (section: PublicSection) => {
    const intent = { venueId: venue().id, sectionId: section.id, title: section.title };
    await runPromptedAction(
      () =>
        prompts.confirm(t().deletePublicSectionQuestion({ title: intent.title }), {
          title: t().deletePublicSection,
          variant: "danger",
          confirmText: t().delete,
        }),
      async (confirmed) => {
        if (confirmed) await deleteSection(intent.venueId, intent.sectionId);
      },
    );
  };

  onMount(() => {
    const wideMedia = window.matchMedia(WIDE_VIEWPORT_QUERY);
    const phoneMedia = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const updateViewport = () => {
      setWide(wideMedia.matches);
      setPhone(phoneMedia.matches);
    };
    updateViewport();
    wideMedia.addEventListener("change", updateViewport);
    phoneMedia.addEventListener("change", updateViewport);
    // Back and Forward move only between selections and filters of this page; its data stays loaded.
    const stopPopState = listenPopState(({ url }) => {
      setSelectedShiftId(parseShiftSelection(url.searchParams.get("shift")));
      setGapsOnly(url.searchParams.get("gaps") === "1");
    });
    onCleanup(() => {
      wideMedia.removeEventListener("change", updateViewport);
      phoneMedia.removeEventListener("change", updateViewport);
      stopPopState();
    });
    if (view() !== "shifts") return;
    // A first visit on a phone switches once to the phone month view; later visits keep the view this browser used last.
    if (props.initialCalendarViewSource === "default" && phoneMedia.matches && calendarView() !== "mobile-month") {
      cookies.writeCookie(CALENDAR_VIEW_COOKIE, "mobile-month");
      documentNavigate(calendarHref("mobile-month", calendarDate(), selectedShiftId()), { replace: true });
      return;
    }
    cookies.writeCookie(CALENDAR_VIEW_COOKIE, calendarView());
  });

  onCleanup(() => {
    disposed = true;
    actions.abortAll();
    closeSheet();
  });

  const navigation = createNavigation({
    items: () => [
      ...(canWrite(venue()) ? [{ id: "signup", label: t().signUp, icon: "ti ti-user-plus", action: "signup" }] : []),
      { id: "all", label: t().allVenues, icon: "ti ti-layout-grid", href: "/app/venue" },
      { id: "public", label: t().publicPage, icon: "ti ti-device-tv", action: "public" },
      ...views().map((item) => ({
        id: item.id,
        label: item.label,
        icon: item.icon,
        href: viewHref(item.id),
        active: !selectedSectionId() && view() === item.id,
      })),
      ...(canAdmin(venue())
        ? [
            {
              id: "add-section",
              label: t().addPublicSection,
              icon: "ti ti-plus",
              action: "add-section",
            },
          ]
        : []),
      ...dashboard().sections.map((section) => ({
        id: `section:${section.id}`,
        label: section.title,
        badge: section.enabled ? undefined : t().sectionDraft,
        icon: sectionKindIcon(section.kind),
        href: sectionHref(section),
        active: selectedSectionId() === section.id,
      })),
      { id: "settings", label: t().venueSettings, icon: "ti ti-settings", action: "settings" },
    ],
    onAction: async (action) => {
      if (action === "signup") await openSignup();
      if (action === "public") await openPublicPage();
      if (action === "add-section") await openAddSection();
      if (action === "settings") await openSettings();
    },
  });
  return (
    <AppWorkspace mobileSurface="flush">
      <WorkspaceNavigationProvider navigation={navigation} label={venue().name} />
      <AppWorkspace.Sidebar collapsible>
        <AppWorkspace.SidebarDesktop>
          <div class="flex flex-col gap-3">
            <AppWorkspace.SidebarIconGrid columns={canWrite(venue()) ? 3 : 2} sidebarMode="expanded">
              <Show when={canWrite(venue())}>
                <AppWorkspace.SidebarIconAction icon="ti ti-user-plus" label={t().signUpForShift} tone="success" onClick={openSignup} />
              </Show>
              <AppWorkspace.SidebarIconAction icon="ti ti-device-tv" label={t().publicPage} onClick={openPublicPage} />
              <AppWorkspace.SidebarIconAction href="/app/venue" navigation="document" icon="ti ti-layout-grid" label={t().allVenues} />
            </AppWorkspace.SidebarIconGrid>

            <AppWorkspace.SidebarSection title={t().workspace} sidebarMode="expanded">
              <For each={views()}>
                {(item) => (
                  <AppWorkspace.SidebarItem
                    href={viewHref(item.id)}
                    navigation="document"
                    icon={item.icon}
                    active={!selectedSectionId() && view() === item.id}
                  >
                    {item.label}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
            </AppWorkspace.SidebarSection>
          </div>

          <AppWorkspace.SidebarIconGrid sidebarMode="collapsed">
            <Show when={canWrite(venue())}>
              <AppWorkspace.SidebarIconAction icon="ti ti-user-plus" label={t().signUpForShift} tone="success" onClick={openSignup} />
            </Show>
            <AppWorkspace.SidebarIconAction icon="ti ti-device-tv" label={t().publicPage} onClick={openPublicPage} />
            <AppWorkspace.SidebarIconAction href="/app/venue" navigation="document" icon="ti ti-layout-grid" label={t().allVenues} />
            <For each={views()}>
              {(item) => (
                <AppWorkspace.SidebarIconAction
                  href={viewHref(item.id)}
                  navigation="document"
                  icon={item.icon}
                  label={item.label}
                  active={!selectedSectionId() && view() === item.id}
                />
              )}
            </For>
            <Show when={showPublicContent()}>
              <Dropdown.Root items={collapsedPublicContentMenu()} position="right-start" width="16rem">
                <Dropdown.Trigger
                  appearance="plain"
                  iconOnly
                  label={t().publicContent}
                  class={`k2b-app-workspace__sidebar-icon-action ${selectedSectionId() ? "is-active" : ""}`}
                >
                  <i class="ti ti-layout-list" aria-hidden="true" />
                </Dropdown.Trigger>
              </Dropdown.Root>
            </Show>
          </AppWorkspace.SidebarIconGrid>

          <AppWorkspace.SidebarBody scrollPreserveKey={`venue-sidebar-${venue().id}`} sidebarMode="expanded">
            <Show when={showPublicContent()}>
              <AppWorkspace.SidebarSection title={t().publicContent}>
                <Show when={canAdmin(venue())}>
                  <AppWorkspace.SidebarItem
                    icon="ti ti-plus"
                    tone="success"
                    title={t().addPublicSection}
                    onClick={() => void openAddSection()}
                  >
                    <AppWorkspace.SidebarItemLabel marquee={false}>{t().addPublicSection}</AppWorkspace.SidebarItemLabel>
                  </AppWorkspace.SidebarItem>
                </Show>
                <For
                  each={dashboard().sections}
                  fallback={<Placeholder align="left" class="px-2 py-2" description={<>{t().noSections}</>} />}
                >
                  {(section) => (
                    // Only drafts carry a marker; a published section is the normal case.
                    <AppWorkspace.SidebarItem
                      href={sectionHref(section)}
                      navigation="document"
                      icon={sectionKindIcon(section.kind)}
                      title={section.enabled ? section.title : `${section.title} · ${t().sectionDraft}`}
                      meta={section.enabled ? undefined : t().sectionDraft}
                      active={selectedSectionId() === section.id}
                    >
                      <AppWorkspace.SidebarItemLabel marquee={false}>{section.title}</AppWorkspace.SidebarItemLabel>
                    </AppWorkspace.SidebarItem>
                  )}
                </For>
              </AppWorkspace.SidebarSection>
            </Show>
          </AppWorkspace.SidebarBody>

          <AppWorkspace.SidebarFooter sidebarMode="expanded">
            <AppWorkspace.SidebarItem icon="ti ti-settings" onClick={openSettings}>
              {t().venueSettings}
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarFooter>
          <AppWorkspace.SidebarFooter sidebarMode="collapsed">
            <AppWorkspace.SidebarIconGrid>
              <AppWorkspace.SidebarIconAction icon="ti ti-settings" label={t().venueSettings} onClick={openSettings} />
            </AppWorkspace.SidebarIconGrid>
          </AppWorkspace.SidebarFooter>
        </AppWorkspace.SidebarDesktop>
      </AppWorkspace.Sidebar>

      <AppWorkspace.Content>
        <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scrollPreserveKey={`venue-main-${venue().id}`}>
          <div class="flex-1">
            <div class="flex flex-col gap-2">
              <Show when={dashboardQuery.error()}>
                <div class="paper flex items-center justify-between gap-3 p-3 text-sm">
                  <p class="text-danger">{t().refreshFailed}</p>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    loading={dashboardQuery.refreshing()}
                    onClick={() => dashboardQuery.refresh()}
                  >
                    {t().retry}
                  </Button>
                </div>
              </Show>
              <Show when={selectedSection()}>
                {(section) => (
                  <>
                    <ViewHeader
                      title={section().title}
                      description={t().previewSection}
                      action={
                        <>
                          <Button type="button" variant="secondary" size="sm" onClick={openPublicPage}>
                            <i class="ti ti-device-tv" /> {t().publicPage}
                          </Button>
                          <Show when={canAdmin(venue())}>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={actions.pending(sectionKey(section().id))}
                              loading={actions.pending(`${sectionKey(section().id)}:edit`)}
                              onClick={() => void openEditSection(section())}
                            >
                              <i class="ti ti-pencil" aria-hidden="true" /> {t().edit}
                            </Button>
                            <Tooltip.Anchor content={t().duplicateSection}>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                loading={actions.pending(`${sectionKey(section().id)}:copy`)}
                                onClick={() => void duplicatePublicSection(section())}
                                aria-label={t().duplicateSection}
                              >
                                <i class="ti ti-copy" aria-hidden="true" />
                              </Button>
                            </Tooltip.Anchor>
                            <Tooltip.Anchor content={t().deleteSection}>
                              <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                disabled={actions.pending(sectionKey(section().id))}
                                loading={actions.pending(`${sectionKey(section().id)}:delete`)}
                                onClick={() => void confirmDeleteSection(section())}
                                aria-label={t().deleteSection}
                              >
                                <i class="ti ti-trash" aria-hidden="true" />
                              </Button>
                            </Tooltip.Anchor>
                          </Show>
                        </>
                      }
                    />
                    <div class="flex flex-wrap items-center gap-2 px-1">
                      <i class={`${sectionKindIcon(section().kind)} text-dimmed`} aria-hidden="true" />
                      <span class="tag">{sectionKindLabel(section().kind, t())}</span>
                      <Show
                        when={section().enabled}
                        fallback={
                          <>
                            <StatusBadge tone="neutral" icon="ti ti-eye-off" label={t().sectionDraft} />
                            <span class="text-xs text-dimmed">
                              {canAdmin(venue()) ? t().sectionDraftDetailAdmin : t().sectionDraftDetailStaff}
                            </span>
                          </>
                        }
                      >
                        <Show
                          when={venue().publicEnabled}
                          fallback={
                            <>
                              <StatusBadge tone="neutral" icon="ti ti-world-off" label={t().sectionPublicPageOff} />
                              <span class="text-xs text-dimmed">{t().sectionPublicPageOffDetail}</span>
                            </>
                          }
                        >
                          <StatusBadge tone="ok" icon="ti ti-world" label={t().sectionPublic} />
                          <span class="text-xs text-dimmed">{t().sectionPublicDetail}</span>
                        </Show>
                      </Show>
                    </div>
                    <section class="paper p-4">
                      <PublicSectionPreview section={section()} />
                    </section>
                  </>
                )}
              </Show>

              <Show when={!selectedSection() && view() === "shifts"}>
                <>
                  <ViewHeader
                    title={t().schedule}
                    description={canJoinShifts() ? t().scheduleDescription : t().scheduleDescriptionReadOnly}
                    action={
                      <Show when={canWrite(venue())}>
                        <Button type="button" size="sm" onClick={openSignup}>
                          <i class="ti ti-user-plus" aria-hidden="true" /> {t().signUp}
                        </Button>
                      </Show>
                    }
                  />
                  <VenueTimeZoneNote timeZone={venue().timezone} times={calendarTimes()} />
                  {/* Fixed figures for today and the next six days: paging through the calendar does not change them. */}
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 px-1 text-sm" data-schedule-outlook="">
                    <span class="inline-flex items-center gap-1.5 font-medium text-primary">
                      <i
                        class={`ti ${dashboard().outlook.missingPeople > 0 ? "ti-user-plus text-amber-600 dark:text-amber-400" : "ti-check text-emerald-600 dark:text-emerald-400"}`}
                        aria-hidden="true"
                      />
                      {canJoinShifts()
                        ? t().thisWeekFreeSpots({ count: dashboard().outlook.missingPeople })
                        : t().thisWeekUnfilledSpots({ count: dashboard().outlook.missingPeople })}
                    </span>
                    <span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5">
                      <i class="ti ti-calendar-exclamation text-dimmed" aria-hidden="true" />
                      <span class="text-dimmed">{t().nextGapLabel}</span>
                      <Show when={dashboard().outlook.nextGap} fallback={<span class="text-dimmed">{t().noGapThisWeek}</span>}>
                        {(gap) => {
                          const id = () => slotSelectionId(gap().templateId, gap().date);
                          return (
                            <a
                              class="font-medium text-primary underline-offset-2 hover:underline"
                              href={calendarHref(calendarView(), gap().date, id())}
                              onClick={(event) => {
                                // A shift the calendar already shows opens in place; any other loads its week.
                                if (!slotByKey().has(id())) return;
                                event.preventDefault();
                                selectShift(id());
                              }}
                            >
                              {formatVenueWeekdayTime(gap().startsAt, venue().timezone, locale())} · {gap().title}
                            </a>
                          );
                        }}
                      </Show>
                    </span>
                    <div class="ml-auto">
                      <FilterChip
                        label={gapsOnly() ? t().gapsOnly : t().allShiftsFilter}
                        icon="ti ti-filter"
                        options={[
                          {
                            options: [
                              { value: "all", label: t().allShiftsFilter, icon: "ti ti-calendar-event" },
                              { value: "gaps", label: t().gapsOnly, icon: "ti ti-user-plus" },
                            ],
                          },
                        ]}
                        value={[gapsOnly() ? "gaps" : "all"]}
                        onValueChange={setGapsFilter}
                        isActive={gapsOnly()}
                        defaultValue={["all"]}
                        position="bottom-right"
                      />
                    </div>
                  </div>
                  <Calendar
                    class="min-h-[42rem] flex-1"
                    date={calendarDate()}
                    view={calendarView()}
                    views={["day", "week", "month"]}
                    events={shiftEvents()}
                    dateConfig={timeZoneDateConfig(venue().timezone, locale())}
                    hideAllDay
                    startHour={7}
                    endHour={23}
                    visibleStartHour={8}
                    visibleEndHour={20}
                    getViewHref={(nextView) => calendarHref(calendarLinkView(calendarView(), nextView, "view", phone()), calendarDate())}
                    getDateHref={(nextDate, nextView) =>
                      calendarHref(calendarLinkView(calendarView(), nextView, "date", phone()), nextDate)
                    }
                    // Every shift is a link to its detail, so it opens before hydration too; one tap or click selects it.
                    getEventHref={(event) => calendarHref(calendarView(), calendarDate(), event.id)}
                    selectedEventId={selectedEventId() ?? undefined}
                    onEventActivate={(event) => selectShift(event.id)}
                    renderEvent={(event, context) => {
                      const slot = slotByKey().get(event.id);
                      const other = otherAssignmentByKey().get(event.id);
                      const slotProgress = !context.compact && slot && isSlotActive(slot) ? slot : undefined;
                      const slotAttendees = context.durationHours >= 1.5 ? slot : undefined;
                      return (
                        <div class="flex min-h-0 min-w-0 flex-col gap-1">
                          <span class="block truncate text-[11px] font-semibold">{event.title}</span>
                          <span class="block truncate text-[10px] opacity-75">
                            {formatVenueTime(context.start.toISOString(), venue().timezone, locale())}–
                            {formatVenueTime(context.end.toISOString(), venue().timezone, locale())}
                          </span>
                          {/* Text and icon carry the state; the event color only repeats it. */}
                          <Show when={slot}>
                            {(currentSlot) => <SlotStateLabel state={slotState(currentSlot(), t())} class="text-[10px] font-semibold" />}
                          </Show>
                          <Show when={slotProgress}>{(currentSlot) => <ProgressBar slot={currentSlot()} compact />}</Show>
                          <Show when={slotAttendees}>
                            {(currentSlot) => (
                              <span class="block truncate text-[10px] opacity-75">
                                {currentSlot()
                                  .assignments.map((entry) => entry.userDisplayName)
                                  .join(", ") || t().noOneYet}
                              </span>
                            )}
                          </Show>
                          <Show when={other}>
                            {(assignment) => <span class="block truncate text-[10px] opacity-75">{assignment().userDisplayName}</span>}
                          </Show>
                        </div>
                      );
                    }}
                  />
                </>
              </Show>

              <Show when={!selectedSection() && view() === "my-shifts"}>
                <>
                  <ViewHeader
                    title={t().myShifts}
                    description={t().myShiftsDescription}
                    action={
                      <>
                        <Button type="button" variant="secondary" size="sm" onClick={openCalendarSubscription}>
                          <i class="ti ti-calendar-share" aria-hidden="true" /> {t().subscribeCalendar}
                        </Button>
                        <Show when={canWrite(venue())}>
                          <Button type="button" size="sm" onClick={openSignup}>
                            <i class="ti ti-user-plus" aria-hidden="true" /> {t().signUp}
                          </Button>
                        </Show>
                      </>
                    }
                  />
                  <VenueTimeZoneNote
                    timeZone={venue().timezone}
                    times={dashboard().myUpcomingShifts.flatMap((shift) => [shift.startsAt, shift.endsAt])}
                  />
                  <section class="paper p-2">
                    <Show
                      when={dashboard().myUpcomingShifts.length > 0}
                      fallback={<Placeholder align="left" class="px-2 py-6" description={<>{t().noUpcomingShifts}</>} />}
                    >
                      <div class="grid gap-1">
                        <For each={dashboard().myUpcomingShifts}>
                          {(shift) => (
                            // The row wraps on narrow screens: the date line never truncates, and Leave keeps its touch size.
                            <div
                              class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg px-3 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900"
                              data-my-shift={shift.id}
                            >
                              <div class="min-w-0 flex-1">
                                {/* The entry opens the shift's detail in the schedule, with everyone on it. */}
                                <p class="font-medium text-primary [overflow-wrap:anywhere]">
                                  <a
                                    class="underline-offset-2 hover:underline"
                                    href={scheduleHref(venue().id, {
                                      date: dates.formatDateKey(new Date(shift.startsAt), { timeZone: venue().timezone }),
                                      shift: assignmentSelectionId(shift.id),
                                    })}
                                  >
                                    {formatVenueSpan(shift.startsAt, shift.endsAt, venue().timezone, locale())} · {assignmentTitle(shift)}
                                  </a>
                                </p>
                                <Show when={shift.note}>
                                  {(note) => <p class="text-xs text-dimmed [overflow-wrap:anywhere]">{note()}</p>}
                                </Show>
                              </div>
                              <Button
                                type="button"
                                variant="secondary"
                                loading={actions.pending(assignmentActionKey(shift))}
                                onClick={() => void leaveShift(shift)}
                              >
                                {t().leave}
                              </Button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </section>
                </>
              </Show>

              <Show when={!selectedSection() && view() === "feedback"}>
                <section class="flex flex-col gap-2">
                  <ViewHeader
                    title={t().feedback}
                    description={t().feedbackDescription({ count: feedbackRangeDays() })}
                    action={
                      <Show when={venue().feedbackEnabled}>
                        <ButtonLink
                          href={`/app/venue/public/${venue().id}/feedback`}
                          target="_blank"
                          rel="noreferrer"
                          variant="secondary"
                          size="sm"
                        >
                          <i class="ti ti-external-link" aria-hidden="true" /> {t().feedbackPage}
                        </ButtonLink>
                      </Show>
                    }
                  />
                  <VenueTimeZoneNote timeZone={venue().timezone} times={dashboard().feedbackEntries.map((entry) => entry.createdAt)} />

                  <StatGrid columns={3} size="sm" class="shrink-0">
                    <StatCell
                      label={t().averageRating}
                      value={feedbackAverage() === null ? "–" : formatAverage(feedbackAverage()!)}
                      sub={t().inLastDays({ count: feedbackRangeDays() })}
                      accent={{
                        tone: feedbackAverage() !== null && feedbackAverage()! >= 4 ? "emerald" : "amber",
                        icon: "ti ti-star",
                      }}
                    />
                    <StatCell
                      label={t().ratings}
                      value={dashboard().feedback?.count ?? 0}
                      sub={t().inLastDays({ count: feedbackRangeDays() })}
                      accent={{ tone: "blue", icon: "ti ti-message-star" }}
                    />
                    <StatCell
                      label={t().comments}
                      value={dashboard().feedback?.commentCount ?? 0}
                      sub={t().ratingsWithComments}
                      accent={{ tone: "blue", icon: "ti ti-message" }}
                    />
                  </StatGrid>

                  {/* Straight segments on the full 1–5 scale, so the line neither overshoots nor exaggerates small changes. */}
                  <div class="paper flex h-64 flex-col gap-1 p-3 text-dimmed">
                    <p class="text-xs font-medium">{t().averageRating}</p>
                    <Chart
                      kind="line"
                      class="min-h-0 flex-1"
                      series={[{ label: t().averageRating, data: feedbackChartData() }]}
                      xAxis={{ format: (value) => feedbackChartLabels()[Math.max(0, Math.round(value) - 1)] ?? "" }}
                      yAxis={{ domain: [1, 5], ticks: 5, format: (value) => `${value}/5` }}
                      smooth={false}
                    />
                  </div>
                  <div class="paper flex h-40 flex-col gap-1 p-3 text-dimmed">
                    <p class="text-xs font-medium">{t().ratingsPerDay}</p>
                    <Chart
                      kind="bar"
                      class="min-h-0 flex-1"
                      data={feedbackCountData()}
                      yAxis={{ ticks: 3, format: (value) => (Number.isInteger(value) ? String(value) : "") }}
                    />
                  </div>

                  <div class="flex flex-wrap items-stretch gap-2 px-1">
                    <div class="min-w-48 flex-1">
                      <SearchBar
                        action={feedbackSearchAction()}
                        value={props.initialFeedbackSearch}
                        placeholder={t().searchComments}
                        ariaLabel={t().searchFeedbackComments}
                      />
                    </div>
                    <FilterChip
                      label={t().lastDays({ count: feedbackRangeDays() })}
                      icon="ti ti-calendar"
                      options={feedbackRangeOptions()}
                      value={[String(feedbackRangeDays())]}
                      onValueChange={setFeedbackDays}
                      isActive={feedbackRangeDays() !== 30}
                      defaultValue={["30"]}
                      position="bottom-right"
                    />
                    <FilterChip
                      label={feedbackComments() ? t().onlyWithComment : t().allRatings}
                      icon="ti ti-message"
                      options={[
                        {
                          options: [
                            { value: "all", label: t().allRatings, icon: "ti ti-message-star" },
                            { value: "comments", label: t().onlyWithComment, icon: "ti ti-message" },
                          ],
                        },
                      ]}
                      value={[feedbackComments() ? "comments" : "all"]}
                      onValueChange={setFeedbackComments}
                      isActive={feedbackComments()}
                      defaultValue={["all"]}
                      position="bottom-right"
                    />
                  </div>

                  <div class="paper overflow-hidden">
                    <DataTable
                      rows={dashboard().feedbackEntries}
                      columns={feedbackColumns}
                      getRowId={(entry) => `${entry.createdAt}:${entry.rating}:${entry.comment ?? ""}`}
                      hoverRows
                      highlightColumns={false}
                      class="overflow-x-auto"
                      empty={
                        props.initialFeedbackSearch
                          ? t().noMatchingFeedback({ search: props.initialFeedbackSearch })
                          : feedbackComments()
                            ? t().noFeedbackWithComment({ count: feedbackRangeDays() })
                            : t().noFeedbackInDays({ count: feedbackRangeDays() })
                      }
                      renderCell={({ row: entry, col, value, render }) => {
                        if (col.id === "rating") {
                          // Filled and outlined stars differ in shape, and the label states the value.
                          return (
                            <span
                              role="img"
                              aria-label={t().ratingValue({ count: entry.rating })}
                              class="inline-flex items-center gap-0.5 whitespace-nowrap text-amber-500 dark:text-amber-400"
                            >
                              <For each={[1, 2, 3, 4, 5]}>
                                {(star) => (
                                  <i
                                    aria-hidden="true"
                                    class={
                                      star <= entry.rating
                                        ? "ti ti-star-filled text-sm"
                                        : "ti ti-star text-sm text-zinc-300 dark:text-zinc-600"
                                    }
                                  />
                                )}
                              </For>
                            </span>
                          );
                        }
                        if (col.id === "comment") {
                          return (
                            <span class={entry.comment ? "text-primary" : "italic text-dimmed"}>{entry.comment || t().noComment}</span>
                          );
                        }
                        if (col.id === "created") return formatVenueDateTime(entry.createdAt, venue().timezone, locale());
                        return render(value);
                      }}
                    />
                  </div>
                  <Show when={feedbackPage()}>
                    {(page) => {
                      const from = () => (page().page - 1) * page().pageSize + 1;
                      const range = () => ({ from: from(), to: from() + dashboard().feedbackEntries.length - 1, total: page().total });
                      return (
                        <div class="flex flex-wrap items-center justify-between gap-2 px-1">
                          <p class="text-xs text-dimmed">
                            {props.initialFeedbackSearch
                              ? t().feedbackMatchesRange({ ...range(), search: props.initialFeedbackSearch })
                              : t().feedbackEntriesRange(range())}
                          </p>
                          <Pagination
                            currentPage={page().page}
                            totalPages={Math.ceil(page().total / page().pageSize)}
                            baseUrl={feedbackPageBaseUrl()}
                          />
                        </div>
                      );
                    }}
                  </Show>
                </section>
              </Show>
            </div>
          </div>
        </AppWorkspace.Main>
        {/* From 1024 px the detail sits next to the calendar; below, CSS hides it and a bottom sheet shows the same detail. */}
        <AppWorkspace.Detail
          id="venue-shift-detail"
          open={selection() !== null && wide()}
          width="md"
          resizable={false}
          class="max-lg:hidden!"
        >
          <Show when={selection()}>
            {(current) => <ShiftDetailPanel selection={current()} {...detailProps()} onClose={clearSelection} />}
          </Show>
        </AppWorkspace.Detail>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
