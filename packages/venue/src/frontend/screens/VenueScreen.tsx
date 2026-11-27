import V2WorkspaceNavigation from "@k2b/cloud/ssr/V2WorkspaceNavigation";
import { documentNavigate, listenPopState, navigate, navigateTo } from "@k2b/ssr/nav";
import { dates } from "@k2b/stdlib";
import { cookies } from "@k2b/stdlib/browser";
import { query } from "@k2b/stdlib/solid";
import { Calendar, type CalendarEvent, Chart, useLocale } from "@k2b/ui";
import {
  Avatar,
  Band,
  Bar,
  Button,
  Canvas,
  Dialog,
  Empty,
  FilterBar,
  Inline,
  Input,
  List,
  ListOrder,
  Menu,
  Nav,
  Notice,
  Pane,
  Row,
  Section,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import { isServer } from "solid-js/web";
import { FEEDBACK_LOW_RATING, type ShiftAssignment, type UpcomingSlot } from "../../contracts";
import { formatDateKey, formatVenueDateTime, formatVenueSpan, formatVenueWeekdayTime, timeZoneName } from "../../time-format";
import { feedbackRatingTooltip, formatFeedbackRating } from "../_components/venue-workspace/feedback-chart-tooltips";
import { PublicPageEditor } from "../_components/venue-workspace/public-page-editor";
import { slotState } from "../_components/venue-workspace/schedule";
import { scheduleIsEmpty, setupSteps } from "../_components/venue-workspace/setup-checklist";
import {
  announceTaken,
  cancelAssignment,
  createActionKeys,
  leaveQuestion,
  removeQuestion,
  takeShift,
} from "../_components/venue-workspace/shift-actions";
import { assignmentActionKey, FOLLOWING_WEEKS, resolveShiftSelection, slotActionKey } from "../_components/venue-workspace/shift-detail";
import type { VenueView, VenueWorkspaceProps } from "../_components/venue-workspace/types";
import { calendarDateOf, canAdmin, canWrite, dateKey, isSlotActive, timeZoneDateConfig } from "../_components/venue-workspace/utils";
import { loadVenueDashboard, sameVenueDashboardSource } from "../dashboard-query";
import { feedbackHref, feedbackQuery } from "../feedback-query";
import {
  assignmentSelectionId,
  CALENDAR_VIEW_COOKIE,
  calendarLinkView,
  focusesDay,
  PHONE_VIEWPORT_QUERY,
  parseShiftSelection,
  scheduleHref,
  slotSelectionId,
  type VenueCalendarView,
} from "../schedule-url";
import { CalendarSubscriptionDialog, PublicLinkDialog } from "./LinkDialogs";
import { useVenueWords } from "./messages";
import ShiftDetailPane from "./ShiftDetailPane";
import SignupDialog from "./SignupDialog";
import { iconName } from "./VenueOverviewScreen";
import { ShiftBlockDrawing, VenueHeroDrawing } from "./venue-drawings";
import { venueNav, venueSettingsHref } from "./venue-nav";

/**
 * One venue on v2: its areas in the sidebar (schedule, my shifts, feedback, public page), the area's own head and
 * column, and the open shift beside the schedule. The address holds the area, the calendar's view and day, the
 * gaps filter, the open shift and the feedback filters.
 */
export default function VenueScreen(props: VenueWorkspaceProps) {
  const { t, words } = useVenueWords();
  const locale = useLocale();
  const toast = useToast();
  const dashboardQuery = query.create({
    source: () => props.dashboardSource,
    initial: { source: props.dashboardSource, data: props.dashboard },
    isSameSource: sameVenueDashboardSource,
    load: (source, { abortSignal }) => loadVenueDashboard(source, abortSignal, t().refreshFailed),
  });
  const dashboard = () => dashboardQuery.data() ?? props.dashboard;
  // a sign-up of mine and the planned shift it belongs to, with the others who work it
  const slotOf = (shift: ShiftAssignment) =>
    shift.templateId
      ? dashboard().slots.find((slot) => slot.template.id === shift.templateId && slot.startsAt === shift.startsAt)
      : undefined;
  const coworkers = (slot: UpcomingSlot) => slot.assignments.filter((person) => person.userId !== props.userId);
  // the mark carries the venue's colour (whose shift it is); a gap stands as a word in its own column
  const mineMark = (shift: ShiftAssignment) =>
    shift.templateId ? { icon: "calendar-event", color: venue().accentColor } : { icon: "clock-plus", color: "var(--k2-muted)" };
  const slotProblem = (slot: UpcomingSlot) => {
    const tone = slotState(slot, t()).tone;
    return tone === "warning" || tone === "danger";
  };
  const slotWord = (slot: UpcomingSlot) => {
    const state = slotState(slot, t());
    return (
      <Text tone={state.tone === "danger" ? "bad" : "warn"} weight="medium">
        {`● ${state.label}`}
      </Text>
    );
  };
  const venue = () => dashboard().venue;
  const view = (): VenueView => props.initialView;
  const calendarView = (): VenueCalendarView => props.initialCalendarView;
  const calendarDate = createMemo(() => calendarDateOf(props.initialCalendarDate, venue().timezone));
  const [gapsOnly, setGapsOnly] = createSignal(props.initialGapsOnly === true);
  const [selectedShiftId, setSelectedShiftId] = createSignal<string | null>(props.initialShiftId ?? null);
  const [phone, setPhone] = createSignal(false);
  const [signingUp, setSigningUp] = createSignal(false);
  const [subscribing, setSubscribing] = createSignal(false);
  const [linking, setLinking] = createSignal(false);
  const [calendarUrl, setCalendarUrl] = createSignal(props.calendarUrl);
  const actions = createActionKeys((message) => toast(message, { status: "bad" }));
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    actions.abortAll();
  });
  const canJoinShifts = () => canWrite(venue()) && venue().signupMode !== "free";

  const reconcileDashboard = async (success?: string): Promise<boolean> => {
    try {
      await dashboardQuery.invalidate();
      if (success) toast(success, { status: "ok" });
      return true;
    } catch {
      toast(t().savedRefreshFailed, { status: "bad" });
      return false;
    }
  };
  // ── the schedule ────────────────────────────────────────────────────────────────────────────────────────
  const calendarHref = (nextView: VenueCalendarView, nextDate: Date | string, shift: string | null = null, gaps = gapsOnly()) =>
    scheduleHref(venue().id, {
      view: nextView,
      date: typeof nextDate === "string" ? nextDate : dateKey(nextDate, venue().timezone),
      gaps,
      shift,
    });
  const selection = createMemo(() => (view() === "shifts" ? resolveShiftSelection(dashboard(), selectedShiftId()) : null));
  const slotByKey = createMemo(() => new Map(dashboard().slots.map((slot) => [slotSelectionId(slot.template.id, slot.date), slot])));
  const otherByKey = createMemo(() => new Map(dashboard().otherAssignments.map((entry) => [assignmentSelectionId(entry.id), entry])));
  const isGap = (slot: UpcomingSlot) => slot.missingPeople > 0 && isSlotActive(slot);
  const assignmentTitle = (assignment: ShiftAssignment) => assignment.templateTitle ?? t().freeTime;
  const events = createMemo<CalendarEvent[]>(() => [
    ...dashboard()
      .slots.filter((slot) => !gapsOnly() || isGap(slot))
      .map((slot) => ({
        id: slotSelectionId(slot.template.id, slot.date),
        title: slot.template.title,
        start: slot.startsAt,
        end: slot.endsAt,
        color: slotState(slot, t()).color,
        // the calendar shows this word too, so only a gap carries one
        accessibleDetail: slotState(slot, t()).color === "zinc" ? undefined : slotState(slot, t()).label,
        meta: slot.assignments.map((entry) => entry.userDisplayName).join(", ") || t().noOneYet,
        // the block names the shift and its people; only a gap says a word ("1 fehlt")
        description: slotState(slot, t()).color === "zinc" ? undefined : slotState(slot, t()).label,
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
  type SelectionHistoryState = { venueShiftSelection?: boolean; gaps?: boolean } | null;
  const selectShift = (id: string) => {
    // Switching between shifts replaces the entry, so Back and closing leave the detail instead of reopening one.
    const replace = Boolean(selectedShiftId());
    setSelectedShiftId(id);
    navigate(calendarHref(calendarView(), calendarDate(), id), {
      replace,
      scroll: "preserve",
      viewTransition: false,
      state: replace ? window.history.state : { venueShiftSelection: true, gaps: gapsOnly() },
    });
  };
  const clearSelection = () => {
    if (!selectedShiftId()) return;
    setSelectedShiftId(null);
    const state = window.history.state as SelectionHistoryState;
    if (state?.venueShiftSelection && state.gaps === gapsOnly()) window.history.back();
    else navigate(calendarHref(calendarView(), calendarDate()), { replace: true, scroll: "preserve", viewTransition: false });
  };
  const setGaps = (next: boolean) => {
    setGapsOnly(next);
    navigate(calendarHref(calendarView(), calendarDate(), selectedShiftId(), next), {
      replace: true,
      scroll: "preserve",
      viewTransition: false,
      state: window.history.state,
    });
  };
  const take = (slot: UpcomingSlot, followingWeeks: boolean) =>
    actions.run([slotActionKey(slot)], async (signal) => {
      const added = await takeShift(
        { venueId: venue().id, templateId: slot.template.id, date: slot.date, weeks: followingWeeks ? FOLLOWING_WEEKS + 1 : undefined },
        signal,
        t(),
      );
      announceTaken(added, t(), (text, status) => toast(text, { status }));
      if (added > 0) await reconcileDashboard();
    });
  /** A detail on a shift stays on it when a sign-up leaves; a sign-up outside every shift leaves nothing, so it closes. */
  const cancelSignup = async (assignment: ShiftAssignment, success: string, failure: string) => {
    const shown = selection();
    if (shown?.kind === "slot" && selectedShiftId() !== shown.eventId) selectShift(shown.eventId);
    await actions.run([assignmentActionKey(assignment)], async (signal) => {
      await cancelAssignment({ venueId: venue().id, assignmentId: assignment.id }, signal, failure);
      await reconcileDashboard(success);
    });
    if (!disposed && shown && !selection()) clearSelection();
  };
  const leave = async (assignment: ShiftAssignment) => {
    if (await Dialog.confirm(leaveQuestion(assignment, venue().timezone, locale(), t())))
      await cancelSignup(assignment, t().shiftLeft, t().leaveShiftFailed);
  };
  const remove = async (assignment: ShiftAssignment) => {
    if (await Dialog.confirm(removeQuestion(assignment, venue().timezone, locale(), t())))
      await cancelSignup(assignment, t().personRemoved, t().removeFromShiftFailed);
  };

  onMount(() => {
    const phoneMedia = window.matchMedia(PHONE_VIEWPORT_QUERY);
    const update = () => setPhone(phoneMedia.matches);
    update();
    phoneMedia.addEventListener("change", update);
    // Back and Forward move only between selections and filters of this page; its data stays loaded.
    const stop = listenPopState(({ url }) => {
      setSelectedShiftId(parseShiftSelection(url.searchParams.get("shift")));
      setGapsOnly(url.searchParams.get("gaps") === "1");
    });
    onCleanup(() => {
      phoneMedia.removeEventListener("change", update);
      stop();
    });
    if (view() !== "shifts") return;
    // A first visit on a phone switches once to the phone month; later visits keep the view this browser used last.
    if (props.initialCalendarViewSource === "default" && phoneMedia.matches && calendarView() !== "mobile-month") {
      cookies.writeCookie(CALENDAR_VIEW_COOKIE, "mobile-month");
      documentNavigate(calendarHref("mobile-month", calendarDate(), selectedShiftId()), { replace: true });
      return;
    }
    cookies.writeCookie(CALENDAR_VIEW_COOKIE, calendarView());
    if (calendarView() === "mobile-month" && focusesDay(new URLSearchParams(window.location.search)))
      requestAnimationFrame(() => {
        if (!disposed) document.querySelector(".k2b-calendar-mobile-month__agenda")?.scrollIntoView({ block: "nearest" });
      });
  });

  // ── the frame ───────────────────────────────────────────────────────────────────────────────────────────
  const nav = () => venueNav({ t, words }, dashboard(), view(), () => setLinking(true));
  // the head opens the list of shifts to sign up for; "Schicht übernehmen" is the deed of one open shift
  const signup = { label: words().signUpHead, icon: "user-plus", onClick: () => setSigningUp(true) };
  // the schedule's state stands in the head row, so the calendar's own toolbar is the only row above the weeks
  const outlook = () => (
    <Inline>
      <Text weight="strong">
        {canJoinShifts()
          ? t().nextDaysFreeSpots({ count: dashboard().outlook.missingPeople })
          : t().nextDaysUnfilledSpots({ count: dashboard().outlook.missingPeople })}
      </Text>
      <Text type="meta" muted>
        {dashboard().outlook.nextGap
          ? `${t().nextGapLabel} ${formatVenueWeekdayTime(dashboard().outlook.nextGap!.startsAt, venue().timezone, locale())} · ${dashboard().outlook.nextGap!.title}`
          : t().noGapNextDays}
      </Text>
    </Inline>
  );
  const gapsMenu = () => (
    <Menu
      variant="ghost"
      items={[
        {
          title: words().showShifts,
          choice: gapsOnly() ? "gaps" : "all",
          onChoose: (value) => setGaps(value === "gaps"),
          items: [
            { label: words().allShifts, value: "all" },
            { label: words().onlyGaps, value: "gaps" },
          ],
        },
      ]}
    >
      {gapsOnly() ? words().onlyGaps : words().allShifts}
    </Menu>
  );
  const head = (end?: JSX.Element) => (
    // The venue's name heads its group in the sidebar, so the head holds only the view's state and deeds.
    <Bar
      start={
        view() === "shifts" ? (
          outlook()
        ) : view() === "my-shifts" && dashboard().myUpcomingShifts.length > 0 ? (
          <Text type="lead">{words().upcomingShifts({ count: dashboard().myUpcomingShifts.length })}</Text>
        ) : undefined
      }
      end={
        <>
          {end}
          {/* signing up belongs to the shifts; feedback, the public page and the settings have deeds of their own */}
          <Show when={canWrite(venue()) && (view() === "shifts" || view() === "my-shifts")}>
            <Button variant="primary" icon="user-plus" onClick={signup.onClick}>
              {signup.label}
            </Button>
          </Show>
        </>
      }
    />
  );

  return (
    <>
      <V2WorkspaceNavigation label={venue().name} groups={nav().groups} foot={nav().foot} />
      <Workspace
        sidebar={<Nav title={t().appName} icon={iconName(venue().icon)} groups={nav().groups} foot={nav().foot} />}
        sidebarLabel={words().views}
        detail={selection() ? 380 : undefined}
        primary={canWrite(venue()) && (view() === "shifts" || view() === "my-shifts") ? signup : undefined}
        // one head per view: the feedback carries its search and page link in its filter bar, the public page has
        // its own heads in the editor and the preview, so neither keeps an empty bar above them
        head={
          view() === "feedback" || view() === "public"
            ? undefined
            : head(
                view() === "shifts" ? (
                  gapsMenu()
                ) : view() === "my-shifts" ? (
                  // the subscription has no other place: a symbol with its name as the hint stays on the phone too
                  <Button icon="calendar-share" keep label={t().subscribeCalendar} onClick={() => setSubscribing(true)} />
                ) : undefined,
              )
        }
      >
        <Show when={view() === "shifts"}>
          <Pane.Split>
            <Pane
              label={t().schedule}
              // beside an open shift the calendar keeps a width of its own; alone it has the whole page
              width={selection() ? { min: 520, default: 1000 } : undefined}
              scrollKey={`venue-schedule-${venue().id}`}
            >
              <Show when={dashboardQuery.error()}>
                <Notice
                  tone="bad"
                  icon="alert-circle"
                  title={t().refreshFailed}
                  actions={[{ label: t().retry, icon: "refresh", onClick: () => void dashboardQuery.refresh() }]}
                >
                  {t().savedRefreshFailed}
                </Notice>
              </Show>
              <TimeZoneNote
                timeZone={venue().timezone}
                times={dashboard()
                  .slots.slice(0, 2)
                  .map((slot) => slot.startsAt)}
              />
              <Show when={scheduleIsEmpty(dashboard())}>
                <SetupSteps {...props} accessEntries={props.accessEntries} dashboard={dashboard()} />
              </Show>
              {/* k2b-ui gap: no calendar in v2; the v1 Calendar keeps its behaviour and draws inside a canvas. */}
              {/* the week reaches the pane's foot: the calendar draws the evening shifts too, without white below */}
              <Canvas label={t().schedule} height={calendarView() === "mobile-month" ? undefined : 780}>
                <Calendar
                  // Inside the canvas the calendar's own frame gives way to the pane's lines, and its scrollbar (WebKit shows one)
                  // keeps a gap to the grip, so no second line stands at the grip.
                  class={
                    calendarView() === "mobile-month"
                      ? "!rounded-none !border-0 !shadow-none"
                      : "h-full !rounded-none !border-0 !pr-2 !shadow-none"
                  }
                  date={calendarDate()}
                  view={calendarView()}
                  views={["day", "week", "month"]}
                  events={events()}
                  dateConfig={timeZoneDateConfig(venue().timezone, locale())}
                  hideAllDay
                  startHour={7}
                  endHour={23}
                  visibleStartHour={8}
                  visibleEndHour={20}
                  getViewHref={(nextView) => calendarHref(calendarLinkView(calendarView(), nextView, "view", phone()), calendarDate())}
                  getDateHref={(nextDate, nextView) =>
                    scheduleHref(venue().id, {
                      view: calendarLinkView(calendarView(), nextView, "date", phone()),
                      date: dateKey(nextDate, venue().timezone),
                      gaps: gapsOnly(),
                      focusDay: calendarView() === "mobile-month" && nextView === "day",
                    })
                  }
                  getEventHref={(event) => calendarHref(calendarView(), calendarDate(), event.id)}
                  selectedEventId={selection()?.eventId ?? undefined}
                  onEventActivate={(event) => selectShift(event.id)}
                  renderEvent={(event, context) => {
                    const slot = slotByKey().get(event.id);
                    const other = otherByKey().get(event.id);
                    const people = slot
                      ? slot.assignments.map((entry) => entry.userDisplayName).join(", ") || t().noOneYet
                      : other?.userDisplayName;
                    const state = slot ? slotState(slot, t()) : undefined;
                    return (
                      <ShiftBlockDrawing
                        title={context.compact && context.leadingTime ? `${context.leadingTime} ${event.title}` : event.title}
                        gap={state && state.color !== "zinc" ? state.label : undefined}
                        people={context.durationHours >= 1.5 ? people : undefined}
                        compact={context.compact}
                      />
                    );
                  }}
                />
              </Canvas>
            </Pane>
            <Show when={selection()} keyed>
              {(current) => (
                <ShiftDetailPane
                  selection={current}
                  venue={venue()}
                  userId={props.userId}
                  closeHref={calendarHref(calendarView(), calendarDate())}
                  pending={actions.pending}
                  onTake={(slot, weeks) => void take(slot, slot.template.date === null && weeks)}
                  onLeave={(assignment) => void leave(assignment)}
                  onRemove={(assignment) => void remove(assignment)}
                />
              )}
            </Show>
          </Pane.Split>
        </Show>
        <Show when={view() === "my-shifts"}>
          <Pane label={t().myShifts} scrollKey={`venue-mine-${venue().id}`}>
            <TimeZoneNote
              timeZone={venue().timezone}
              times={dashboard().myUpcomingShifts.flatMap((shift) => [shift.startsAt, shift.endsAt])}
            />
            <Show
              when={dashboard().myUpcomingShifts.length > 0}
              fallback={<Empty icon="calendar-off" text={t().noUpcomingShifts} action={canWrite(venue()) ? signup : undefined} />}
            >
              {/* identity B: one line per shift (mark · name · when · who works along · state only when someone is
                  missing); the row opens the shift in the schedule, where leaving stands in its head */}
              <Table
                label={t().myShifts}
                rows={dashboard().myUpcomingShifts}
                rowKey={(shift) => shift.id}
                open={(shift) => ({
                  href: scheduleHref(venue().id, {
                    date: dates.formatDateKey(new Date(shift.startsAt), { timeZone: venue().timezone }),
                    shift: assignmentSelectionId(shift.id),
                  }),
                })}
                phone={(shift) => ({
                  mark: mineMark(shift),
                  lines: [
                    assignmentTitle(shift),
                    <>
                      {formatVenueSpan(shift.startsAt, shift.endsAt, venue().timezone, locale())}
                      <Show when={slotOf(shift) && slotProblem(slotOf(shift)!)}>
                        {" · "}
                        {slotWord(slotOf(shift)!)}
                      </Show>
                    </>,
                  ],
                })}
                columns={[
                  {
                    title: words().shiftColumn,
                    width: { min: 180, default: 240 },
                    mark: mineMark,
                    cell: (shift) => <Text weight="strong">{assignmentTitle(shift)}</Text>,
                  },
                  {
                    title: words().whenColumn,
                    width: { min: 200, default: 230 },
                    cell: (shift) => formatVenueSpan(shift.startsAt, shift.endsAt, venue().timezone, locale()),
                  },
                  {
                    title: words().withColumn,
                    width: { min: 120, default: 150 },
                    drop: true,
                    cell: (shift) => {
                      const slot = slotOf(shift);
                      const people = slot ? coworkers(slot) : [];
                      return people.length > 0 ? (
                        <Avatar.Stack
                          people={people.map((person) => ({ name: person.userDisplayName }))}
                          max={4}
                          label={words().withPeople({ names: people.map((person) => person.userDisplayName).join(", ") })}
                        />
                      ) : (
                        ""
                      );
                    },
                  },
                  {
                    title: words().staffingColumn,
                    width: { min: 120, default: 140 },
                    drop: true,
                    // fine says nothing; only a gap stands, as a dot and a word
                    cell: (shift) => (slotOf(shift) && slotProblem(slotOf(shift)!) ? slotWord(slotOf(shift)!) : ""),
                  },
                ]}
              />
            </Show>
          </Pane>
        </Show>
        <Show when={view() === "feedback"}>
          <FeedbackPane {...props} dashboard={dashboard()} refreshing={dashboardQuery.refreshing()} />
        </Show>
        <Show when={view() === "public" && canAdmin(venue())}>
          <PublicPageEditor
            dashboard={dashboard()}
            initialPreview={props.initialPublicPreview ?? null}
            initialSectionId={props.initialSectionId ?? null}
            reconcile={reconcileDashboard}
          />
        </Show>
      </Workspace>
      <SignupDialog
        open={signingUp()}
        dashboard={dashboard()}
        userId={props.userId}
        close={(changed) => {
          setSigningUp(false);
          if (changed) void reconcileDashboard();
        }}
      />
      <CalendarSubscriptionDialog open={subscribing()} url={calendarUrl()} onRenewed={setCalendarUrl} close={() => setSubscribing(false)} />
      <PublicLinkDialog open={linking()} venueId={venue().id} publicEnabled={venue().publicEnabled} close={() => setLinking(false)} />
    </>
  );
}

/** Names the venue's time zone only for viewers whose device runs in another one; the server cannot know that zone. */
function TimeZoneNote(props: { timeZone: string; times: readonly string[] }) {
  const { t } = useVenueWords();
  const locale = useLocale();
  const [viewer, setViewer] = createSignal<string | null>(null);
  onMount(() => setViewer(Intl.DateTimeFormat().resolvedOptions().timeZone));
  return (
    <Show when={viewer() !== null && viewer() !== props.timeZone}>
      <Notice tone="note" icon="world">
        {t().venueTimeZoneNote({ zone: timeZoneName(props.timeZone, locale(), props.times), id: props.timeZone })}
      </Notice>
    </Show>
  );
}

/** What an empty schedule says: admins get the open setup steps with a way into the right settings. */
function SetupSteps(props: VenueWorkspaceProps) {
  const { t } = useVenueWords();
  const steps = () => setupSteps(props.dashboard, props.accessEntries, props.userId);
  const copy = (id: "hours" | "shifts" | "team") =>
    id === "hours"
      ? { title: t().setupHours, detail: t().setupHoursDetail, action: t().setupHoursAction }
      : id === "shifts"
        ? { title: t().setupShifts, detail: t().setupShiftsDetail, action: t().setupShiftsAction }
        : { title: t().setupTeam, detail: t().setupTeamDetail, action: t().setupTeamAction };
  return (
    <Show
      when={props.dashboard.venue.permission === "admin" && steps().some((step) => !step.done)}
      fallback={<Empty icon="calendar-off" text={t().noShiftsPlanned} />}
    >
      <Section icon="list-check" title={t().setupTitle} summary={t().setupDescription}>
        <List label={t().setupTitle}>
          <For each={steps()}>
            {(step) => (
              <Row
                icon={step.done ? "circle-check" : "circle-dashed"}
                lines={[copy(step.id).title, copy(step.id).detail]}
                action={
                  step.done ? undefined : { label: copy(step.id).action, href: venueSettingsHref(props.dashboard.venue.id, step.tab) }
                }
              />
            )}
          </For>
        </List>
      </Section>
    </Show>
  );
}

/** The feedback list's declaration and the state the server read from the address. */
const feedbackList = (props: VenueWorkspaceProps, locale: string) => {
  const query = feedbackQuery(locale);
  const params = new URLSearchParams();
  if (props.initialFeedbackDays !== 30) params.set("days", String(props.initialFeedbackDays));
  if (props.initialFeedbackComments) params.set("comments", "1");
  if (props.initialFeedbackSearch) params.set("q", props.initialFeedbackSearch);
  return { query, state: query.parse(params).state };
};

/** The search over comments in the head; Enter loads the page with the words in the address. */
function FeedbackSearch(props: VenueWorkspaceProps) {
  const { t, words } = useVenueWords();
  const locale = useLocale();
  const [text, setText] = createSignal(props.initialFeedbackSearch);
  return (
    <Input
      type="search"
      icon="search"
      label={t().searchFeedbackComments}
      placeholder={words().searchShort}
      value={text()}
      onInput={setText}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || event.isComposing || isServer) return;
        const { query, state } = feedbackList(props, locale());
        navigateTo(feedbackHref(props.dashboard.venue.id, query, { ...state, search: text().trim() || undefined }));
      }}
    />
  );
}

/** Visitor feedback: the three key numbers, the average and the count per day, then the entries, newest first. */
function FeedbackPane(props: VenueWorkspaceProps & { refreshing: boolean }) {
  const { t, words } = useVenueWords();
  const locale = useLocale();
  const venue = () => props.dashboard.venue;
  const days = () => props.initialFeedbackDays;
  const comments = () => props.initialFeedbackComments === true;
  const list = createMemo(() => feedbackList(props, locale()));
  const query = () => list().query;
  const state = () => list().state;
  const buckets = () => props.dashboard.feedback?.buckets ?? [];
  const average = () => props.dashboard.feedback?.averageRating ?? null;
  const labels = createMemo(() => buckets().map((bucket) => formatDateKey(bucket.date, locale())));
  const ratingData = createMemo(() =>
    buckets()
      .map((bucket, index) => ({ bucket, index }))
      .filter(({ bucket }) => bucket.averageRating !== null)
      .map(({ bucket, index }) => ({ x: index + 1, y: bucket.averageRating ?? 0 })),
  );
  const xAxis = createMemo(() => ({
    domain: [0.5, Math.max(1, labels().length) + 0.5] as [number, number],
    ticks: Math.min(Math.max(1, labels().length), 6),
    format: (value: number) => {
      const day = Math.round(value);
      return Math.abs(value - day) < 1e-6 ? (labels()[day - 1] ?? "") : "";
    },
  }));
  const yAxis = { domain: [1, 5] as [number, number], ticks: 5, format: (value: number) => `${value}/5` };
  const page = () => {
    const current = props.dashboard.feedbackEntriesPage;
    return current && current.total > 0 ? current : null;
  };
  const pages = () => (page() ? Math.ceil(page()!.total / page()!.pageSize) : 1);
  // a rating stays quiet; only a bad one (FEEDBACK_LOW_RATING stars or fewer) carries colour (identity B, rule 7)
  const stars = (rating: number) => (
    <Text tone={rating <= FEEDBACK_LOW_RATING ? "bad" : undefined}>{`${"★".repeat(rating)}${"☆".repeat(5 - rating)} ${rating}/5`}</Text>
  );
  return (
    <Pane
      label={t().feedback}
      scrollKey={`venue-feedback-${venue().id}`}
      // the filter bar is the list's one status row: filters, what they found, and the order at its end
      status={
        <FilterBar
          query={query()}
          state={state()}
          onChange={(next) => navigateTo(feedbackHref(venue().id, query(), next))}
          results={t().feedbackEntriesRange({
            from: 1,
            to: props.dashboard.feedbackEntries.length,
            total: props.dashboard.feedbackEntriesPage?.total ?? 0,
          })}
          end={
            <>
              <ListOrder query={query()} state={state()} onChange={() => undefined} />
              <FeedbackSearch {...props} />
              <Show when={venue().feedbackEnabled}>
                <Button icon="external-link" href={`/app/venue/public/${venue().id}/feedback`}>
                  {t().feedbackPage}
                </Button>
              </Show>
            </>
          }
        />
      }
    >
      {/* identity B: one hero, the average in the venue's colour with its course over the days beside it, and the
          exceptions under it; the filter bar names the range and the count once, nothing here repeats them */}
      <Band label={t().averageRating}>
        <Canvas label={t().averageRating}>
          <VenueHeroDrawing
            figure={average() === null ? "—" : formatFeedbackRating(average()!, locale())}
            label={average() === null ? words().noRatingsYet : t().averageRating}
            color={venue().accentColor}
            chart={
              <Show when={ratingData().length > 0}>
                <Chart
                  kind={ratingData().length > 1 ? "line" : "scatter"}
                  style={{ height: "100%" }}
                  series={[{ label: t().averageRating, data: ratingData() }]}
                  xAxis={xAxis()}
                  yAxis={yAxis}
                  smooth={false}
                  tooltip={feedbackRatingTooltip({
                    dayLabels: labels(),
                    label: t().averageRating,
                    locale: locale(),
                    counts: { label: t().ratings, values: buckets().map((bucket) => bucket.count) },
                  })}
                />
              </Show>
            }
            exceptions={[
              ...((props.dashboard.feedback?.lowCount ?? 0) > 0
                ? [
                    {
                      tone: "bad" as const,
                      count: String(props.dashboard.feedback!.lowCount),
                      word: words().lowRatings({ stars: FEEDBACK_LOW_RATING }),
                    },
                  ]
                : []),
              ...((props.dashboard.feedback?.commentCount ?? 0) > 0
                ? [{ tone: "off" as const, count: String(props.dashboard.feedback!.commentCount), word: words().withComment }]
                : []),
            ]}
          />
        </Canvas>
      </Band>
      <Table
        label={t().feedback}
        rows={props.dashboard.feedbackEntries}
        empty={{
          icon: "message-off",
          text: props.initialFeedbackSearch
            ? t().noMatchingFeedback({ search: props.initialFeedbackSearch })
            : comments()
              ? t().noFeedbackWithComment({ count: days() })
              : t().noFeedbackInDays({ count: days() }),
        }}
        phone={(entry) => ({
          lines: [stars(entry.rating), entry.comment || "–"],
          time: formatVenueDateTime(entry.createdAt, venue().timezone, locale()),
        })}
        columns={[
          { title: words().ratingColumn, width: { min: 120, default: 130 }, cell: (entry) => stars(entry.rating) },
          // a rating without words leaves its cell quiet instead of saying "Kein Kommentar" in every such row
          { title: words().commentColumn, wrap: true, cell: (entry) => entry.comment || "" },
          {
            title: words().submittedColumn,
            width: { min: 150, default: 170 },
            drop: true,
            cell: (entry) => formatVenueDateTime(entry.createdAt, venue().timezone, locale()),
          },
        ]}
      />
      {/* the filter bar says the range already; paging stands only when there is more than one page */}
      <Show when={pages() > 1 ? page() : null}>
        {(current) => {
          const from = () => (current().page - 1) * current().pageSize + 1;
          const range = () => ({ from: from(), to: from() + props.dashboard.feedbackEntries.length - 1, total: current().total });
          return (
            <Bar
              start={
                <Text type="meta" muted>
                  {props.initialFeedbackSearch
                    ? t().feedbackMatchesRange({ ...range(), search: props.initialFeedbackSearch })
                    : t().feedbackEntriesRange(range())}
                </Text>
              }
              end={
                <>
                  <Button
                    icon="chevron-left"
                    disabled={current().page <= 1}
                    href={current().page > 1 ? feedbackHref(venue().id, query(), state(), current().page - 1) : undefined}
                  >
                    {words().previous}
                  </Button>
                  <Button
                    icon="chevron-right"
                    disabled={current().page >= pages()}
                    href={current().page < pages() ? feedbackHref(venue().id, query(), state(), current().page + 1) : undefined}
                  >
                    {words().next}
                  </Button>
                </>
              }
            />
          );
        }}
      </Show>
    </Pane>
  );
}
