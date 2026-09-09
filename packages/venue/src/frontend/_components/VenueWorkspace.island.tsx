import { navigateTo } from "@k2b/ssr/nav";
import { cookies } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  Calendar,
  type CalendarEvent,
  type CalendarView,
  Chart,
  DataTable,
  type DataTableColumn,
  Dropdown,
  dialogCore,
  FilterChip,
  Placeholder,
  panelDialogOptions,
  prompts,
  StatCell,
  StatGrid,
  Tooltip,
  toast,
  useLocale,
} from "@k2b/ui";
import { SearchBar } from "@k2b/cloud/ssr/islands";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { FeedbackEntry, PublicSection, PublicSectionInput, ShiftAssignment, UpcomingSlot } from "../../contracts";
import { venueMessages } from "../../messages";
import { loadVenueDashboard, sameVenueDashboardSource } from "../dashboard-query";
import { reconcileChangedSettings } from "../settings-contract";
import { DOUBLE_CLICK_CONFIRM_COOKIE } from "./venue-workspace/constants";
import { openVenuePublicDisplayDialog } from "./venue-workspace/public-display";
import { PublicSectionDialog, PublicSectionPreview, sectionKindIcon } from "./venue-workspace/public-sections";
import { ProgressBar } from "./venue-workspace/schedule";
import { SettingsDialog } from "./venue-workspace/settings";
import { ConfirmShiftSignupDialog, SignupDialog } from "./venue-workspace/signup";
import type { FeedbackRange, VenueView, VenueWorkspaceProps } from "./venue-workspace/types";
import {
  canAdmin,
  canWrite,
  dateKey,
  feedbackBucketAverage,
  feedbackBucketCount,
  fmt,
  fmtDate,
  fmtTime,
  isSlotActive,
  parseDateKey,
  readError,
  timeZoneDateConfig,
  withinLastDays,
} from "./venue-workspace/utils";

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
    { id: "feedback" as const, label: t().feedback, icon: "ti ti-message-star" },
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
  const [calendarView] = createSignal<CalendarView>(props.initialCalendarView);
  const [calendarDate] = createSignal(parseDateKey(props.initialCalendarDate));
  const [prompting, setPrompting] = createSignal(false);
  const [workspaceWritePending, setWorkspaceWritePending] = createSignal(false);
  let disposed = false;
  const runPromptedAction = async <T,>(readIntent: () => Promise<T>, applyIntent: (intent: T) => Promise<void>) => {
    if (prompting() || workspaceWriteBusy()) return;
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
  const feedbackSearchAction = createMemo(() => {
    const url = new URL(viewHref("feedback"), "http://venue.local");
    if (props.initialFeedbackDays !== 30) url.searchParams.set("days", String(props.initialFeedbackDays));
    return `${url.pathname}${url.search}`;
  });
  const feedbackFilterUrl = (days: FeedbackRange) => {
    const url = new URL(viewHref("feedback"), "http://venue.local");
    if (days !== 30) url.searchParams.set("days", String(days));
    if (props.initialFeedbackSearch) url.searchParams.set("search", props.initialFeedbackSearch);
    return `${url.pathname}${url.search}`;
  };
  const setFeedbackDays = (value: string[]) => {
    const next = Number(value[0] ?? 30);
    navigateTo(feedbackFilterUrl(next === 7 || next === 14 ? next : 30));
  };
  const feedbackBucketsForDays = (days: number) => dashboard().feedback.buckets.filter((bucket) => withinLastDays(bucket.date, days));
  const feedbackBuckets = createMemo(() => feedbackBucketsForDays(feedbackRangeDays()));
  const feedbackRangeCount = createMemo(() => feedbackBucketCount(feedbackBuckets()));
  const feedbackRangeAverage = createMemo(() => feedbackBucketAverage(feedbackBuckets()));
  const feedbackChartLabels = createMemo(() => feedbackBuckets().map((bucket) => fmtDate(bucket.date, locale())));
  const feedbackChartData = createMemo(() =>
    feedbackBuckets()
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket }) => bucket.averageRating !== null)
      .map(({ bucket, index }) => ({ x: index + 1, y: bucket.averageRating ?? 0 })),
  );
  const filteredFeedbackEntries = createMemo(() =>
    dashboard().feedbackEntries.filter((entry) => withinLastDays(entry.createdAt, feedbackRangeDays())),
  );
  const activeSlots = createMemo(() => dashboard().slots.filter(isSlotActive));
  const openRegistrationCount = createMemo(() => activeSlots().reduce((sum, slot) => sum + slot.missingPeople, 0));
  const feedbackCommentCount = createMemo(() => filteredFeedbackEntries().filter((entry) => Boolean(entry.comment?.trim())).length);
  const feedbackColumns: DataTableColumn<FeedbackEntry>[] = [
    { id: "rating", header: t().rating, value: (entry) => entry.rating, cellClass: "w-px" },
    { id: "comment", header: t().comment, value: (entry) => entry.comment, cellClass: "min-w-64" },
    { id: "created", header: t().submitted, value: (entry) => entry.createdAt, headerClass: "w-px", cellClass: "w-px whitespace-nowrap" },
  ];
  const selectedSection = createMemo(() => dashboard().sections.find((section) => section.id === selectedSectionId()) ?? null);
  const slotOccurrenceKey = (slot: UpcomingSlot) => `${slot.template.id}:${slot.date}`;
  const slotByKey = createMemo(() => new Map(dashboard().slots.map((slot) => [slotOccurrenceKey(slot), slot])));
  const shiftEvents = createMemo<CalendarEvent[]>(() =>
    dashboard().slots.map((slot) => ({
      id: slotOccurrenceKey(slot),
      title: slot.template.title,
      start: slot.startsAt,
      end: slot.endsAt,
      color: !isSlotActive(slot) || slot.full ? "zinc" : slot.missingPeople > 0 ? "amber" : "emerald",
      meta: slot.assignments.map((entry) => entry.userDisplayName).join(", ") || t().noOneYet,
      description: `${slot.assignedCount}/${slot.minPeople}${slot.maxPeople ? ` · max ${slot.maxPeople}` : ""}`,
    })),
  );
  const sectionHref = (section: PublicSection) => `/app/venue/${venue().id}/public-sections/${section.id}`;
  const collapsedPublicContentMenu = () => [
    {
      sectionLabel: t().publicContent,
      items: [
        ...(canAdmin(venue()) ? [{ icon: "ti ti-plus", label: t().addPublicSection, action: () => void openAddSection() }] : []),
        ...dashboard().sections.map((section) => ({
          icon: sectionKindIcon(section.kind),
          label: section.title,
          href: sectionHref(section),
        })),
      ],
    },
  ];
  const calendarHref = (nextView: CalendarView, nextDate: Date) => {
    const normalizedView = nextView === "month" ? "month" : "week";
    const url = new URL(viewHref("shifts"), "http://venue.local");
    url.searchParams.set("cv", normalizedView);
    url.searchParams.set("cd", dateKey(nextDate));
    return `${url.pathname}?${url.searchParams.toString()}`;
  };

  const openSignup = async () => {
    const snapshot = dashboard();
    await runPromptedAction(
      () => dialogCore.open<boolean>((close) => <SignupDialog dashboard={snapshot} close={close} />, panelDialogOptions),
      async (changed) => {
        await reconcileChangedSettings(changed, async () => {
          await reconcileDashboard();
        });
      },
    );
  };
  const openPublicPage = () => openVenuePublicDisplayDialog(venue().id, locale());

  const calendarSignup = mutation.create<void, { venueId: string; templateId: string; date: string }>({
    mutation: async ({ venueId, templateId, date }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].templates[":templateId"].signup.$post(
        { param: { id: venueId, templateId }, json: { date } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().signupFailed));
    },
    onError: (err) => prompts.error(err.message),
  });

  const signupFromCalendar = async (slot: UpcomingSlot) => {
    if (slot.full) {
      prompts.error(t().shiftFull);
      return;
    }
    if (!isSlotActive(slot)) {
      prompts.error(t().shiftEnded);
      return;
    }
    const intent = {
      venueId: venue().id,
      templateId: slot.template.id,
      date: slot.date,
      slot,
      timezone: venue().timezone,
    };
    await runPromptedAction(
      async () =>
        cookies.readJsonCookie(DOUBLE_CLICK_CONFIRM_COOKIE, false)
          ? true
          : await prompts.dialog<boolean>(
              (close) => <ConfirmShiftSignupDialog slot={intent.slot} timezone={intent.timezone} close={close} />,
              {
                title: t().joinShift,
                icon: "ti ti-user-plus",
                size: "small",
              },
            ),
      async (confirmed) => {
        if (confirmed) {
          await runWorkspaceWrite(
            calendarSignup,
            { venueId: intent.venueId, templateId: intent.templateId, date: intent.date },
            t().shiftAdded,
          );
        }
      },
    );
  };

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
              icalToken={props.icalToken}
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

  const addSection = mutation.create<void, { venueId: string; input: PublicSectionInput }>({
    mutation: async ({ venueId, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].sections.$post({ param: { id: venueId }, json: input }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().addSectionFailed));
    },
    onError: (err) => prompts.error(err.message),
  });

  const openAddSection = async () => {
    const intent = { venueId: venue().id, nextPosition: dashboard().sections.length + 1 };
    await runPromptedAction(
      () =>
        dialogCore.open<PublicSectionInput | null>(
          (close) => <PublicSectionDialog close={close} nextPosition={intent.nextPosition} />,
          panelDialogOptions,
        ),
      async (input) => {
        if (input) await runWorkspaceWrite(addSection, { venueId: intent.venueId, input });
      },
    );
  };

  const editSection = mutation.create<void, { venueId: string; sectionId: string; input: PublicSectionInput }>({
    mutation: async ({ venueId, sectionId, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].sections[":resourceId"].$patch(
        { param: { id: venueId, resourceId: sectionId }, json: input },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().updateSectionFailed));
    },
    onError: (err) => prompts.error(err.message),
  });

  const openEditSection = async (section: PublicSection) => {
    const intent = { venueId: venue().id, sectionId: section.id, section: { ...section, content: { ...section.content } } };
    await runPromptedAction(
      () =>
        dialogCore.open<PublicSectionInput | null>(
          (close) => (
            <PublicSectionDialog
              close={close}
              initial={intent.section}
              nextPosition={intent.section.position}
              title={t().editPublicSection}
              submitLabel={t().saveSection}
            />
          ),
          panelDialogOptions,
        ),
      async (input) => {
        if (input) {
          await runWorkspaceWrite(editSection, { venueId: intent.venueId, sectionId: intent.sectionId, input }, t().sectionUpdated);
        }
      },
    );
  };

  const duplicateSection = mutation.create<void, { venueId: string; input: PublicSectionInput }>({
    mutation: async ({ venueId, input }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].sections.$post({ param: { id: venueId }, json: input }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().duplicateSectionFailed));
    },
    onError: (err) => prompts.error(err.message),
  });
  const duplicatePublicSection = async (section: PublicSection) => {
    await runWorkspaceWrite(
      duplicateSection,
      {
        venueId: venue().id,
        input: {
          kind: section.kind,
          title: `${section.title} copy`,
          content: { ...section.content },
          enabled: section.enabled,
          position: dashboard().sections.length + 1,
        },
      },
      t().sectionDuplicated,
    );
  };

  const deleteSection = mutation.create<void, { venueId: string; sectionId: string }>({
    mutation: async ({ venueId, sectionId }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].sections[":resourceId"].$delete(
        { param: { id: venueId, resourceId: sectionId } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().deleteSectionFailed));
    },
    onError: (err) => prompts.error(err.message),
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
        if (confirmed) {
          await runWorkspaceWrite(deleteSection, { venueId: intent.venueId, sectionId: intent.sectionId }, t().sectionDeleted, () => {
            setSelectedSectionId(null);
            window.history.replaceState({}, "", viewHref("shifts"));
          });
        }
      },
    );
  };

  const cancelAssignment = mutation.create<void, { venueId: string; assignmentId: string }>({
    mutation: async ({ venueId, assignmentId }, { abortSignal }) => {
      const res = await apiClient.venues[":id"].assignments[":assignmentId"].$delete(
        { param: { id: venueId, assignmentId } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().cancelShiftFailed));
    },
    onError: (err) => prompts.error(err.message),
  });

  const confirmCancelAssignment = async (assignment: ShiftAssignment) => {
    const intent = {
      venueId: venue().id,
      assignmentId: assignment.id,
      label: t().assignmentAt({ name: assignment.userDisplayName, date: fmt(assignment.startsAt, locale()) }),
    };
    await runPromptedAction(
      () =>
        prompts.confirm(t().cancelShiftQuestion({ label: intent.label }), {
          title: t().cancelShift,
          variant: "danger",
          confirmText: t().cancelShift,
        }),
      async (confirmed) => {
        if (confirmed) {
          await runWorkspaceWrite(cancelAssignment, { venueId: intent.venueId, assignmentId: intent.assignmentId }, t().shiftCancelled);
        }
      },
    );
  };

  const workspaceWriteBusy = () =>
    workspaceWritePending() ||
    dashboardQuery.refreshing() ||
    Boolean(dashboardQuery.error()) ||
    calendarSignup.loading() ||
    addSection.loading() ||
    editSection.loading() ||
    duplicateSection.loading() ||
    deleteSection.loading() ||
    cancelAssignment.loading();
  const workspaceActionBlocked = () => prompting() || workspaceWriteBusy();
  const runWorkspaceWrite = async <V,>(
    control: { mutate: (value: V) => Promise<void>; error: () => Error | null | undefined },
    value: V,
    successMessage?: string,
    afterReconcile?: () => void,
  ) => {
    if (workspaceWriteBusy()) return;
    setWorkspaceWritePending(true);
    try {
      await control.mutate(value);
      if (disposed || control.error()) return;
      const reconciled = await reconcileDashboard(successMessage);
      if (reconciled && !disposed) afterReconcile?.();
    } finally {
      setWorkspaceWritePending(false);
    }
  };

  onCleanup(() => {
    disposed = true;
    calendarSignup.abort();
    addSection.abort();
    editSection.abort();
    duplicateSection.abort();
    deleteSection.abort();
    cancelAssignment.abort();
  });

  return (
    <AppWorkspace>
      <AppWorkspace.Sidebar collapsible>
        <AppWorkspace.SidebarMobileTrigger label={venue().name} />

        <AppWorkspace.SidebarMobile>
          <AppWorkspace.SidebarMobileItems scrollPreserveKey={`venue-sidebar-mobile-${venue().id}`}>
            <Show when={canWrite(venue())}>
              <AppWorkspace.SidebarItem icon="ti ti-user-plus" tone="success" disabled={workspaceActionBlocked()} onClick={openSignup}>
                Sign up
              </AppWorkspace.SidebarItem>
            </Show>
            <AppWorkspace.SidebarItem href="/app/venue" navigation="document" icon="ti ti-layout-grid">
              All venues
            </AppWorkspace.SidebarItem>
            <AppWorkspace.SidebarItem icon="ti ti-device-tv" onClick={openPublicPage}>
              Public page
            </AppWorkspace.SidebarItem>
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
            <Show when={canAdmin(venue())}>
              <AppWorkspace.SidebarItem
                icon="ti ti-plus"
                tone="success"
                disabled={workspaceActionBlocked()}
                onClick={() => void openAddSection()}
              >
                Add public section
              </AppWorkspace.SidebarItem>
            </Show>
            <For each={dashboard().sections}>
              {(section) => (
                <AppWorkspace.SidebarItem
                  href={sectionHref(section)}
                  navigation="document"
                  icon={sectionKindIcon(section.kind)}
                  active={selectedSectionId() === section.id}
                >
                  {section.title}
                </AppWorkspace.SidebarItem>
              )}
            </For>
            <AppWorkspace.SidebarItem icon="ti ti-settings" onClick={openSettings}>
              Venue settings
            </AppWorkspace.SidebarItem>
          </AppWorkspace.SidebarMobileItems>
        </AppWorkspace.SidebarMobile>

        <AppWorkspace.SidebarDesktop>
          <div class="flex flex-col gap-3">
            <AppWorkspace.SidebarIconGrid columns={canWrite(venue()) ? 3 : 2} sidebarMode="expanded">
              <Show when={canWrite(venue())}>
                <AppWorkspace.SidebarIconAction
                  icon="ti ti-user-plus"
                  label={t().signUpForShift}
                  tone="success"
                  disabled={workspaceActionBlocked()}
                  onClick={openSignup}
                />
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
              <AppWorkspace.SidebarIconAction
                icon="ti ti-user-plus"
                label={t().signUpForShift}
                tone="success"
                disabled={workspaceActionBlocked()}
                onClick={openSignup}
              />
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
            <Show when={canAdmin(venue()) || dashboard().sections.length > 0}>
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
            <AppWorkspace.SidebarSection title={t().publicContent}>
              <Show when={canAdmin(venue())}>
                <AppWorkspace.SidebarItem
                  icon="ti ti-plus"
                  tone="success"
                  disabled={workspaceActionBlocked()}
                  onClick={() => void openAddSection()}
                >
                  Add public section
                </AppWorkspace.SidebarItem>
              </Show>
              <For
                each={dashboard().sections}
                fallback={<Placeholder align="left" class="px-2 py-2" description={<>{t().noSections}</>} />}
              >
                {(section) => (
                  <AppWorkspace.SidebarItem
                    href={sectionHref(section)}
                    navigation="document"
                    icon={sectionKindIcon(section.kind)}
                    active={selectedSectionId() === section.id}
                  >
                    {section.title}
                  </AppWorkspace.SidebarItem>
                )}
              </For>
            </AppWorkspace.SidebarSection>
          </AppWorkspace.SidebarBody>

          <AppWorkspace.SidebarFooter sidebarMode="expanded">
            <AppWorkspace.SidebarItem icon="ti ti-settings" onClick={openSettings}>
              Venue settings
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
                    disabled={dashboardQuery.refreshing()}
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
                              disabled={workspaceActionBlocked()}
                              onClick={() => void openEditSection(section())}
                            >
                              <i class={editSection.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-pencil"} /> {t().edit}
                            </Button>
                            <Tooltip.Anchor content={t().duplicateSection}>
                              <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                disabled={workspaceActionBlocked()}
                                onClick={() => void duplicatePublicSection(section())}
                                aria-label={t().duplicateSection}
                              >
                                <i class={duplicateSection.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-copy"} />
                              </Button>
                            </Tooltip.Anchor>
                            <Tooltip.Anchor content={t().deleteSection}>
                              <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                disabled={workspaceActionBlocked()}
                                onClick={() => void confirmDeleteSection(section())}
                                aria-label={t().deleteSection}
                              >
                                <i class={deleteSection.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-trash"} />
                              </Button>
                            </Tooltip.Anchor>
                          </Show>
                        </>
                      }
                    />
                    <div class="flex items-center gap-2 px-1">
                      <i class={`${sectionKindIcon(section().kind)} text-dimmed`} />
                      <span class="tag">{section().kind}</span>
                      <Show when={!section().enabled}>
                        <span class="tag bg-zinc-100 text-dimmed dark:bg-zinc-800">{t().hidden}</span>
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
                    description={t().scheduleDescription}
                    action={
                      <Show when={canWrite(venue())}>
                        <Button type="button" size="sm" disabled={workspaceActionBlocked()} onClick={openSignup}>
                          <i class="ti ti-user-plus" /> {t().signUp}
                        </Button>
                      </Show>
                    }
                  />
                  <StatGrid columns={3} size="sm" class="shrink-0">
                    <StatCell
                      label={t().openSpots}
                      value={openRegistrationCount()}
                      sub={t().peopleStillNeeded}
                      accent={{
                        tone: openRegistrationCount() > 0 ? "amber" : "emerald",
                        icon: openRegistrationCount() > 0 ? "ti ti-user-plus" : "ti ti-check",
                      }}
                    />
                    <StatCell
                      label={t().upcomingShifts}
                      value={activeSlots().length}
                      sub={t().visibleCalendarWindow}
                      accent={{ tone: "blue", icon: "ti ti-calendar-event" }}
                    />
                    <StatCell
                      label={t().myUpcoming}
                      value={dashboard().myUpcomingShifts.length}
                      sub={t().assignmentsTotal({ count: dashboard().myShiftCount })}
                      accent={{ tone: "blue", icon: "ti ti-user-check" }}
                    />
                  </StatGrid>
                  <Calendar
                    class="min-h-[42rem] flex-1"
                    date={calendarDate()}
                    view={calendarView()}
                    views={["week", "month"]}
                    events={shiftEvents()}
                    dateConfig={timeZoneDateConfig(venue().timezone)}
                    hideAllDay
                    startHour={7}
                    endHour={23}
                    visibleStartHour={8}
                    visibleEndHour={20}
                    getViewHref={(nextView) => calendarHref(nextView, calendarDate())}
                    getDateHref={(nextDate, nextView) => calendarHref(nextView, nextDate)}
                    eventActivation="double"
                    onEventActivate={(event) => {
                      const slot = slotByKey().get(event.id);
                      if (slot) void signupFromCalendar(slot);
                    }}
                    renderEvent={(event, context) => {
                      const slot = slotByKey().get(event.id);
                      const slotProgress = !context.compact ? slot : undefined;
                      const slotAttendees = context.durationHours >= 1.5 ? slot : undefined;
                      const ended = slot ? !isSlotActive(slot) : false;
                      return (
                        <div class="flex min-h-0 min-w-0 flex-col gap-1">
                          <span class="block truncate text-[11px] font-semibold">{event.title}</span>
                          <span class="block truncate text-[10px] opacity-75">
                            {fmtTime(context.start.toISOString(), venue().timezone, locale())}-
                            {fmtTime(context.end.toISOString(), venue().timezone, locale())}
                          </span>
                          <Show
                            when={ended}
                            fallback={<Show when={slotProgress}>{(currentSlot) => <ProgressBar slot={currentSlot()} compact />}</Show>}
                          >
                            <span class="block truncate text-[10px] font-semibold opacity-75">{t().ended}</span>
                          </Show>
                          <Show when={slotAttendees}>
                            {(currentSlot) => (
                              <span class="block truncate text-[10px] opacity-75">
                                {currentSlot()
                                  .assignments.map((entry) => entry.userDisplayName)
                                  .join(", ") || t().noOneYet}
                              </span>
                            )}
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
                        <ButtonLink variant="secondary" size="sm" href={`/api/venue/calendar/${props.icalToken}.ics`}>
                          <i class="ti ti-calendar-down" /> iCal
                        </ButtonLink>
                        <Show when={canWrite(venue())}>
                          <Button type="button" size="sm" disabled={workspaceActionBlocked()} onClick={openSignup}>
                            <i class="ti ti-user-plus" /> {t().signUp}
                          </Button>
                        </Show>
                      </>
                    }
                  />
                  <section class="paper p-2">
                    <Show
                      when={dashboard().myUpcomingShifts.length > 0}
                      fallback={<Placeholder align="left" class="px-2 py-6" description={<>{t().noUpcomingShifts}</>} />}
                    >
                      <div class="grid gap-1">
                        <For each={dashboard().myUpcomingShifts}>
                          {(shift) => (
                            <div class="flex items-center justify-between gap-3 rounded-lg px-3 py-3 text-sm hover:bg-zinc-50 dark:hover:bg-zinc-900">
                              <div class="min-w-0">
                                <p class="font-medium text-primary">{fmt(shift.startsAt, locale())}</p>
                                <p class="text-xs text-dimmed">{shift.note || t().shift}</p>
                              </div>
                              <Button
                                type="button"
                                variant="danger"
                                size="sm"
                                disabled={workspaceActionBlocked()}
                                onClick={() => void confirmCancelAssignment(shift)}
                              >
                                <i class={cancelAssignment.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-x"} /> {t().cancel}
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
                    description={`Visitor ratings and comments from the last ${feedbackRangeDays()} days.`}
                    action={
                      <Show when={venue().feedbackEnabled}>
                        <ButtonLink
                          href={`/app/venue/public/${venue().id}/feedback`}
                          target="_blank"
                          rel="noreferrer"
                          variant="secondary"
                          size="sm"
                        >
                          <i class="ti ti-external-link" /> {t().feedbackPage}
                        </ButtonLink>
                      </Show>
                    }
                  />

                  <StatGrid columns={3} size="sm" class="shrink-0">
                    <StatCell
                      label={t().averageRating}
                      value={feedbackRangeAverage() === null ? "-" : `${feedbackRangeAverage()!.toFixed(1)}/5`}
                      sub={`over the last ${feedbackRangeDays()} days`}
                      accent={{
                        tone: feedbackRangeAverage() !== null && feedbackRangeAverage()! >= 4 ? "emerald" : "amber",
                        icon: "ti ti-star",
                      }}
                    />
                    <StatCell
                      label={t().ratings}
                      value={feedbackRangeCount()}
                      sub={`received in the last ${feedbackRangeDays()} days`}
                      accent={{ tone: "blue", icon: "ti ti-message-star" }}
                    />
                    <StatCell
                      label={t().comments}
                      value={feedbackCommentCount()}
                      sub={t().ratingsWithComments}
                      accent={{ tone: "blue", icon: "ti ti-message" }}
                    />
                  </StatGrid>

                  <div class="paper h-64 p-3 text-dimmed">
                    <Chart
                      kind="line"
                      class="h-full min-h-0"
                      series={[{ label: t().averageRating, data: feedbackChartData() }]}
                      xAxis={{ format: (value) => feedbackChartLabels()[Math.max(0, Math.round(value) - 1)] ?? "" }}
                      yAxis={{ format: (value) => `${value}/5` }}
                      smooth
                    />
                  </div>

                  <div class="flex items-stretch gap-2 px-1">
                    <div class="min-w-0 flex-1">
                      <SearchBar
                        action={feedbackSearchAction()}
                        value={props.initialFeedbackSearch}
                        placeholder={t().searchComments}
                        ariaLabel={t().searchFeedbackComments}
                      />
                    </div>
                    <FilterChip
                      label={`Last ${feedbackRangeDays()} days`}
                      icon="ti ti-calendar"
                      options={feedbackRangeOptions()}
                      value={[String(feedbackRangeDays())]}
                      onValueChange={setFeedbackDays}
                      isActive={feedbackRangeDays() !== 30}
                      defaultValue={["30"]}
                      position="bottom-right"
                    />
                  </div>

                  <div class="paper overflow-hidden">
                    <DataTable
                      rows={filteredFeedbackEntries()}
                      columns={feedbackColumns}
                      getRowId={(entry) => `${entry.createdAt}:${entry.rating}:${entry.comment ?? ""}`}
                      hoverRows
                      highlightColumns={false}
                      class="overflow-x-auto"
                      empty={`No feedback in the last ${feedbackRangeDays()} days.`}
                      renderCell={({ row: entry, col, value, render }) => {
                        if (col.id === "rating") {
                          return (
                            <span class="inline-flex items-center gap-0.5 whitespace-nowrap text-amber-500 dark:text-amber-400">
                              <For each={[1, 2, 3, 4, 5]}>
                                {(star) => (
                                  <i class={`ti ti-star text-sm ${star <= entry.rating ? "" : "text-zinc-300 dark:text-zinc-600"}`} />
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
                        if (col.id === "created") return fmt(entry.createdAt, locale());
                        return render(value);
                      }}
                    />
                  </div>
                </section>
              </Show>
            </div>
          </div>
        </AppWorkspace.Main>
      </AppWorkspace.Content>
    </AppWorkspace>
  );
}
