import { dates } from "@k2b/stdlib";
import { query } from "@k2b/stdlib/solid";
import { DateRangePicker, type DateRangeValue, useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Canvas,
  Check,
  Choice,
  Dialog,
  Empty,
  Failed,
  Field,
  Input,
  List,
  Loading,
  Notice,
  Row,
  Section,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { ShiftAssignment, UpcomingSlot, VenueDashboard } from "../../contracts";
import { formatDateKey, formatVenueSpan } from "../../time-format";
import { slotStaffingLabel } from "../_components/venue-workspace/schedule";
import { announceTaken, cancelAssignment, createActionKeys, leaveQuestion, takeShift } from "../_components/venue-workspace/shift-actions";
import { assignmentActionKey, FOLLOWING_WEEKS, slotActionKey } from "../_components/venue-workspace/shift-detail";
import { SIGNUP_PAGE_DAYS, visibleSignupSlots } from "../_components/venue-workspace/signup-slots";
import { defaultShiftRange, groupSlotsByDay, isSlotActive, readError, timeZoneDateConfig } from "../_components/venue-workspace/utils";
import { shiftDate } from "../dashboard-query";
import { useVenueWords } from "./messages";
import { slotChip } from "./ShiftDetailPane";

type SlotPage = { startDate: string; slots: UpcomingSlot[] };

/**
 * Signing up: a shift from the list (14 days at a time, from today in the venue's time zone) or free time with a
 * note. A Leave keeps the dialog open; closing reports whether anything changed, so the page reloads its data.
 */
export default function SignupDialog(props: {
  open: boolean;
  dashboard: VenueDashboard;
  userId: string;
  close: (changed: boolean) => void;
}) {
  return (
    <Show when={props.open}>
      <SignupForm dashboard={props.dashboard} userId={props.userId} close={props.close} />
    </Show>
  );
}

function SignupForm(props: { dashboard: VenueDashboard; userId: string; close: (changed: boolean) => void }) {
  const { t, words } = useVenueWords();
  const locale = useLocale();
  const toast = useToast();
  const venue = () => props.dashboard.venue;
  const [mode, setMode] = createSignal<"shifts" | "free">(venue().signupMode === "free" ? "free" : "shifts");
  const [range, setRange] = createSignal<DateRangeValue>(defaultShiftRange());
  const [note, setNote] = createSignal("");
  const [onlyFree, setOnlyFree] = createSignal(true);
  const [followingWeeks, setFollowingWeeks] = createSignal(false);
  const [changed, setChanged] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const actions = createActionKeys((message) => toast(message, { status: "bad" }));
  const hasTemplates = () => props.dashboard.templates.some((template) => template.active);
  const pages = query.createInfinite<{ venueId: string; startDate: string }, SlotPage, string>({
    source: () => ({ venueId: venue().id, startDate: dates.formatDateKey(new Date(), { timeZone: venue().timezone }) }),
    isSameSource: (left, right) => left.venueId === right.venueId && left.startDate === right.startDate,
    enabled: () => venue().signupMode !== "free" && hasTemplates(),
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
  onCleanup(() => {
    pages.abort();
    actions.abortAll();
  });
  const loaded = () => pages.pages().flatMap((page) => page.slots);
  const days = () => groupSlotsByDay(visibleSignupSlots(loaded(), props.userId, onlyFree()));
  const through = () => {
    const last = pages.pages().at(-1);
    return last
      ? formatDateKey(shiftDate(last.startDate, SIGNUP_PAGE_DAYS - 1), locale(), { weekday: "short", day: "numeric", month: "short" })
      : "";
  };
  const own = (slot: UpcomingSlot): ShiftAssignment | undefined =>
    slot.assignments.find((assignment) => assignment.userId === props.userId);
  const take = (slot: UpcomingSlot) =>
    actions.run([slotActionKey(slot)], async (signal) => {
      const added = await takeShift(
        {
          venueId: venue().id,
          templateId: slot.template.id,
          date: slot.date,
          weeks: slot.template.date === null && followingWeeks() ? FOLLOWING_WEEKS + 1 : undefined,
        },
        signal,
        t(),
      );
      announceTaken(added, t(), (text, status) => toast(text, { status }));
      if (added > 0) props.close(true);
    });
  const leave = async (slot: UpcomingSlot, assignment: ShiftAssignment) => {
    if (!(await Dialog.confirm(leaveQuestion(assignment, venue().timezone, locale(), t())))) return;
    await actions.run([slotActionKey(slot), assignmentActionKey(assignment)], async (signal) => {
      await cancelAssignment({ venueId: venue().id, assignmentId: assignment.id }, signal, t().leaveShiftFailed);
      setChanged(true);
      toast(t().shiftLeft, { status: "ok" });
      await pages.refresh();
    });
  };
  const signUpFree = async () => {
    const value = range();
    if (!value.start || !value.end) return setError(t().pickStartEnd);
    setSaving(true);
    setError(null);
    try {
      const response = await apiClient.venues[":id"]["free-signup"].$post({
        param: { id: venue().id },
        json: { startsAt: value.start, endsAt: value.end, note: note().trim() || null },
      });
      if (!response.ok) throw new Error(await readError(response, t().signupFailed));
      toast(t().shiftTaken, { status: "ok" });
      props.close(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t().signupFailed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={t().signUpForShift}
      open
      onOpenChange={(open) => {
        if (!open) props.close(changed());
      }}
      foot={
        <>
          <Button onClick={() => props.close(changed())}>{t().close}</Button>
          <Show when={mode() === "free"}>
            <Button variant="primary" icon="plus" busy={saving()} onClick={() => void signUpFree()}>
              {t().addFreeShift}
            </Button>
          </Show>
        </>
      }
    >
      <Show when={venue().signupMode === "both"}>
        <Choice
          name="signup-kind"
          label={words().kind}
          options={[
            { value: "shifts", label: t().shiftSlots },
            { value: "free", label: t().freeTime },
          ]}
          value={mode()}
          onChange={(value) => setMode(value === "free" ? "free" : "shifts")}
        />
      </Show>
      <Show
        when={mode() === "shifts"}
        fallback={
          <>
            <Show when={error()}>
              {(message) => (
                <Notice tone="bad" icon="alert-circle">
                  {message()}
                </Notice>
              )}
            </Show>
            {/* k2b-ui gap: no date and time range picker in v2; the v1 picker keeps its behaviour in a canvas. */}
            <Canvas label={t().time}>
              <DateRangePicker
                label={t().time}
                value={range}
                onValueChange={setRange}
                withTime
                dateConfig={timeZoneDateConfig(venue().timezone, locale())}
                durationPresets={[2, 4, 8].map((hours) => ({
                  label: new Intl.NumberFormat(locale(), { style: "unit", unit: "hour", unitDisplay: "narrow" }).format(hours),
                  minutes: hours * 60,
                }))}
              />
            </Canvas>
            <Field name="note" label={t().note} optional={words().optional}>
              <Input multiline value={note()} onInput={setNote} />
            </Field>
          </>
        }
      >
        <Show when={hasTemplates()} fallback={<Empty icon="calendar-off" text={t().noShiftsAvailableDescription} />}>
          <Check switch label={t().onlyFree} checked={onlyFree()} onChange={setOnlyFree} />
          <Check label={t().alsoFollowingWeeks({ count: FOLLOWING_WEEKS })} checked={followingWeeks()} onChange={setFollowingWeeks} />
          <Show when={!pages.loading()} fallback={<Loading rows={4} lines={2} />}>
            <Show when={pages.pages().length > 0} fallback={<Failed text={t().loadShiftsFailed} onRetry={() => void pages.refresh()} />}>
              <For
                each={days()}
                fallback={
                  <Empty
                    icon="calendar-off"
                    text={
                      onlyFree() && loaded().length > 0
                        ? t().noFreeShiftsUntil({ date: through() })
                        : t().noShiftsUntil({ date: through() })
                    }
                  />
                }
              >
                {(day) => (
                  <Section
                    title={formatDateKey(day.date, locale(), { weekday: "long", day: "numeric", month: "long" })}
                    count={day.slots.length}
                  >
                    <List label={day.date}>
                      <For each={day.slots}>
                        {(slot) => (
                          <Row
                            icon="calendar-event"
                            color={venue().accentColor}
                            lines={[
                              slot.template.title,
                              `${formatVenueSpan(slot.startsAt, slot.endsAt, venue().timezone, locale())} · ${slotStaffingLabel(slot, t())}`,
                            ]}
                            end={own(slot) ? <Text type="meta">{t().joined}</Text> : slotChip(slot, t())}
                            action={
                              own(slot)
                                ? {
                                    label: t().leave,
                                    disabled: actions.pending(assignmentActionKey(own(slot)!)),
                                    onClick: () => void leave(slot, own(slot)!),
                                  }
                                : {
                                    label: t().join,
                                    icon: "user-plus",
                                    disabled: slot.full || actions.pending(slotActionKey(slot)),
                                    onClick: () => void take(slot),
                                  }
                            }
                          />
                        )}
                      </For>
                    </List>
                  </Section>
                )}
              </For>
              <Bar
                start={
                  <Text type="meta" muted>
                    {t().shiftsUpTo({ count: visibleSignupSlots(loaded(), props.userId, onlyFree()).length, date: through() })}
                  </Text>
                }
                end={
                  <Button icon="chevrons-down" busy={pages.loadingMore()} onClick={() => void pages.loadMore()}>
                    {t().loadMoreShifts}
                  </Button>
                }
              />
            </Show>
          </Show>
        </Show>
      </Show>
    </Dialog>
  );
}
