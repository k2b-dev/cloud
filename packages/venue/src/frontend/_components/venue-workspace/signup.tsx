import { dates } from "@k2b/stdlib";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  Checkbox,
  DateRangePicker,
  type DateRangeValue,
  InlineGuidance,
  PanelDialog,
  Placeholder,
  prompts,
  SegmentedControl,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { ShiftAssignment, UpcomingSlot, VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { formatDateKey, formatVenueSpan } from "../../../time-format";
import { shiftDate } from "../../dashboard-query";
import { ProgressBar } from "./schedule";
import { announceTaken, cancelAssignment, confirmLeave, createActionKeys, takeShift } from "./shift-actions";
import { assignmentActionKey, FOLLOWING_WEEKS, slotActionKey } from "./shift-detail";
import { VenueTimeZoneNote } from "./time-zone-note";
import { defaultShiftRange, groupSlotsByDay, isSlotActive, joinedSlot, readError, timeZoneDateConfig } from "./utils";

/** The dialog lists shifts in steps of this many days, starting today in the Venue's time zone. */
export const SIGNUP_PAGE_DAYS = 14;

type SlotPage = { startDate: string; slots: UpcomingSlot[] };

/**
 * `Only free` hides shifts that are full, except the viewer's own: those stay listed with Leave.
 */
export const visibleSignupSlots = (slots: readonly UpcomingSlot[], userId: string, onlyFree: boolean): UpcomingSlot[] =>
  onlyFree ? slots.filter((slot) => !slot.full || joinedSlot(slot, userId)) : [...slots];

/**
 * `userId` is the viewer, so shifts they already joined read as joined and offer Leave instead of a second sign-up.
 * Pass the dialog's `setDismissHandler`, so Escape and the backdrop also report a Leave as a change.
 */
export function SignupDialog(props: {
  dashboard: VenueDashboard;
  userId: string;
  close: (changed: boolean) => void;
  setDismissHandler?: (handler: () => void) => void;
}) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dashboard = () => props.dashboard;
  const venue = () => dashboard().venue;
  const defaultMode = venue().signupMode === "free" ? "free" : "shifts";
  const [mode, setMode] = createSignal<"shifts" | "free">(defaultMode);
  const [freeRange, setFreeRange] = createSignal<DateRangeValue>(defaultShiftRange());
  const [note, setNote] = createSignal("");
  const [onlyFree, setOnlyFree] = createSignal(true);
  const [followingWeeks, setFollowingWeeks] = createSignal(false);
  /** A Leave keeps the dialog open, so closing it still has to refresh the workspace. */
  const [changed, setChanged] = createSignal(false);
  const actions = createActionKeys();
  props.setDismissHandler?.(() => props.close(changed()));
  const hasShiftTemplates = () => dashboard().templates.some((template) => template.active);
  // The dialog owns its window instead of reusing the calendar's: it always starts today and grows on request.
  const slotPages = query.createInfinite<{ venueId: string; startDate: string }, SlotPage, string>({
    source: () => ({
      venueId: venue().id,
      startDate: dates.formatDateKey(new Date(), { timeZone: venue().timezone }),
    }),
    isSameSource: (left, right) => left.venueId === right.venueId && left.startDate === right.startDate,
    enabled: () => venue().signupMode !== "free" && hasShiftTemplates(),
    loadPage: async (source, { cursor, abortSignal }) => {
      const startDate = cursor ?? source.startDate;
      const response = await apiClient.venues[":id"].dashboard.$get(
        { param: { id: source.venueId }, query: { slotStartDate: startDate, slotDays: String(SIGNUP_PAGE_DAYS) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(t().loadShiftsFailed);
      return { startDate, slots: (await response.json()).slots.filter(isSlotActive) };
    },
    getNextCursor: (page) => shiftDate(page.startDate, SIGNUP_PAGE_DAYS),
  });
  const loadedSlots = () => slotPages.pages().flatMap((page) => page.slots);
  const shownSlots = () => visibleSignupSlots(loadedSlots(), props.userId, onlyFree());
  const shownDays = () => groupSlotsByDay(shownSlots());
  const ownAssignment = (slot: UpcomingSlot): ShiftAssignment | undefined =>
    slot.assignments.find((assignment) => assignment.userId === props.userId);
  const shownTimes = () =>
    mode() === "shifts"
      ? shownSlots().flatMap((slot) => [slot.startsAt, slot.endsAt])
      : [freeRange().start, freeRange().end].filter((time): time is string => Boolean(time));
  const loadedThrough = () => {
    const last = slotPages.pages().at(-1);
    if (!last) return "";
    return formatDateKey(shiftDate(last.startDate, SIGNUP_PAGE_DAYS - 1), locale(), { weekday: "short", day: "numeric", month: "short" });
  };

  const take = (slot: UpcomingSlot) =>
    actions.run([slotActionKey(slot)], async (signal) => {
      const added = await takeShift(
        {
          venueId: venue().id,
          templateId: slot.template.id,
          date: slot.date,
          // This shift and the same shift in each of the following weeks.
          weeks: slot.template.date === null && followingWeeks() ? FOLLOWING_WEEKS + 1 : undefined,
        },
        signal,
        t(),
      );
      announceTaken(added, t());
      if (added > 0) props.close(true);
    });

  const leave = async (slot: UpcomingSlot, assignment: ShiftAssignment) => {
    if (!(await confirmLeave(assignment, venue().timezone, locale(), t()))) return;
    await actions.run([slotActionKey(slot), assignmentActionKey(assignment)], async (signal) => {
      await cancelAssignment({ venueId: venue().id, assignmentId: assignment.id }, signal, t().leaveShiftFailed);
      setChanged(true);
      toast.success(t().shiftLeft);
      await slotPages.refresh();
    });
  };

  const freeSignup = mutation.create<void, { venueId: string; startsAt: string; endsAt: string; note: string | null }>({
    mutation: async ({ venueId, startsAt, endsAt, note: signupNote }, { abortSignal }) => {
      const res = await apiClient.venues[":id"]["free-signup"].$post(
        { param: { id: venueId }, json: { startsAt, endsAt, note: signupNote } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().signupFailed));
    },
    onSuccess: () => {
      toast.success(t().shiftTaken);
      props.close(true);
    },
    onError: (err) => prompts.error(err.message),
  });

  const submitFreeSignup = async () => {
    const range = freeRange();
    if (!range.start || !range.end) {
      prompts.error(t().pickStartEnd);
      return;
    }
    await freeSignup.mutate({
      venueId: venue().id,
      startsAt: range.start,
      endsAt: range.end,
      note: note().trim() || null,
    });
  };

  onCleanup(() => {
    slotPages.abort();
    actions.abortAll();
    freeSignup.abort();
  });

  return (
    <PanelDialog>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header
          title={t().signUpForShift}
          subtitle={venue().name}
          icon="ti ti-user-plus"
          close={() => props.close(changed())}
        />
        <PanelDialog.Body>
          <Show when={venue().signupMode === "both"}>
            <SegmentedControl
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "shifts", label: t().shiftSlots, icon: "ti ti-calendar-event" },
                { value: "free", label: t().freeTime, icon: "ti ti-clock-plus" },
              ]}
            />
          </Show>
          <VenueTimeZoneNote timeZone={venue().timezone} times={shownTimes()} />
          <Show
            when={mode() === "shifts"}
            fallback={
              <div class="grid gap-3">
                <DateRangePicker
                  label={t().time}
                  value={freeRange}
                  onValueChange={setFreeRange}
                  withTime
                  dateConfig={timeZoneDateConfig(venue().timezone, locale())}
                  durationPresets={[2, 4, 8].map((hours) => ({
                    label: new Intl.NumberFormat(locale(), { style: "unit", unit: "hour", unitDisplay: "narrow" }).format(hours),
                    minutes: hours * 60,
                  }))}
                />
                <TextInput label={t().note} value={note} onValueChange={setNote} multiline lines={3} />
              </div>
            }
          >
            <Show
              when={hasShiftTemplates()}
              fallback={
                <Placeholder
                  variant="panel"
                  title={t().noShiftsAvailable}
                  description={t().noShiftsAvailableDescription}
                  icon="ti ti-calendar-off"
                />
              }
            >
              <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <Switch label={t().onlyFree} value={onlyFree} onValueChange={setOnlyFree} />
                <Checkbox
                  label={t().alsoFollowingWeeks({ count: FOLLOWING_WEEKS })}
                  value={followingWeeks}
                  onValueChange={setFollowingWeeks}
                />
              </div>
              <Show when={!slotPages.loading()} fallback={<Placeholder state="loading" description={t().loadingShifts} />}>
                <Show
                  when={slotPages.pages().length > 0}
                  fallback={
                    <Placeholder
                      state="error"
                      description={t().loadShiftsFailed}
                      action={
                        <Button type="button" variant="secondary" size="sm" onClick={() => void slotPages.refresh()}>
                          {t().retry}
                        </Button>
                      }
                    />
                  }
                >
                  <div class="flex flex-col gap-2">
                    <For
                      each={shownDays()}
                      fallback={
                        <Placeholder
                          variant="panel"
                          title={
                            onlyFree() && loadedSlots().length > 0
                              ? t().noFreeShiftsUntil({ date: loadedThrough() })
                              : t().noShiftsUntil({ date: loadedThrough() })
                          }
                          description={
                            onlyFree() && loadedSlots().length > 0 ? t().noFreeShiftsUntilDescription : t().noShiftsUntilDescription
                          }
                          icon="ti ti-calendar-off"
                        />
                      }
                    >
                      {(day) => (
                        <section class="flex flex-col gap-2" data-signup-day={day.date}>
                          {/* The body scrolls with 1.25rem padding, so the heading sticks flush to its top edge. */}
                          <h3 class="sticky -top-5 z-10 bg-[var(--k2b-surface)] py-1.5 text-xs font-semibold text-secondary">
                            {formatDateKey(day.date, locale(), { weekday: "long", day: "numeric", month: "long" })}
                          </h3>
                          <For each={day.slots}>
                            {(slot) => (
                              <div class="paper p-3" data-signup-slot={`${slot.template.id}:${slot.date}`}>
                                <div class="flex items-start justify-between gap-3">
                                  <div class="min-w-0">
                                    <p class="font-medium text-primary">{slot.template.title}</p>
                                    <p class="text-xs text-dimmed">
                                      {formatVenueSpan(slot.startsAt, slot.endsAt, venue().timezone, locale())}
                                    </p>
                                  </div>
                                  <Show
                                    when={ownAssignment(slot)}
                                    fallback={
                                      <span
                                        class={`tag ${slot.full ? "bg-zinc-100 text-dimmed dark:bg-zinc-800" : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"}`}
                                      >
                                        {slot.full ? t().full : t().openSpots}
                                      </span>
                                    }
                                  >
                                    <StatusBadge tone="ok" icon="ti ti-check" label={t().joined} />
                                  </Show>
                                </div>
                                <div class="mt-3">
                                  <ProgressBar slot={slot} />
                                </div>
                                <div class="mt-3 flex flex-wrap justify-end gap-2">
                                  <Show
                                    when={ownAssignment(slot)}
                                    fallback={
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={slot.full}
                                        loading={actions.pending(slotActionKey(slot))}
                                        onClick={() => void take(slot)}
                                      >
                                        {t().join}
                                      </Button>
                                    }
                                  >
                                    {(own) => (
                                      <Button
                                        type="button"
                                        variant="secondary"
                                        size="sm"
                                        loading={actions.pending(assignmentActionKey(own()))}
                                        onClick={() => void leave(slot, own())}
                                      >
                                        {t().leave}
                                      </Button>
                                    )}
                                  </Show>
                                </div>
                              </div>
                            )}
                          </For>
                        </section>
                      )}
                    </For>
                    <Show when={slotPages.error()}>
                      <InlineGuidance tone="danger" icon="ti ti-alert-circle">
                        {t().loadShiftsFailed}
                      </InlineGuidance>
                    </Show>
                    <div class="flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
                      <p class="text-xs text-dimmed">{t().shiftsUpTo({ count: shownSlots().length, date: loadedThrough() })}</p>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        loading={slotPages.loadingMore()}
                        onClick={() => void slotPages.loadMore()}
                      >
                        {t().loadMoreShifts}
                      </Button>
                    </div>
                  </div>
                </Show>
              </Show>
            </Show>
          </Show>
        </PanelDialog.Body>
        <PanelDialog.Footer>
          <div />
          <div class="flex justify-end gap-2">
            <Button type="button" variant="secondary" size="sm" onClick={() => props.close(changed())}>
              {t().close}
            </Button>
            <Show when={mode() === "free"}>
              <Button type="button" size="sm" loading={freeSignup.loading()} onClick={() => void submitFreeSignup()}>
                <i class="ti ti-plus" aria-hidden="true" /> {t().addFreeShift}
              </Button>
            </Show>
          </div>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}
