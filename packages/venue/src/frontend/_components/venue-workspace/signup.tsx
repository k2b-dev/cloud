import { dates } from "@k2b/stdlib";
import { cookies } from "@k2b/stdlib/browser";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  DateRangePicker,
  type DateRangeValue,
  InlineGuidance,
  PanelDialog,
  Placeholder,
  prompts,
  SegmentedControl,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { UpcomingSlot, VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { formatDateKey, formatVenueSpan } from "../../../time-format";
import { shiftDate } from "../../dashboard-query";
import { DOUBLE_CLICK_CONFIRM_COOKIE } from "./constants";
import { ProgressBar } from "./schedule";
import { VenueTimeZoneNote } from "./time-zone-note";
import { defaultShiftRange, isSlotActive, readError, timeZoneDateConfig } from "./utils";

/** The dialog lists shifts in steps of this many days, starting today in the Venue's time zone. */
export const SIGNUP_PAGE_DAYS = 14;

type SlotPage = { startDate: string; slots: UpcomingSlot[] };

/** `userId` is the viewer, so shifts they already joined read as joined instead of offering a second sign-up. */
export function SignupDialog(props: { dashboard: VenueDashboard; userId: string; close: (changed: boolean) => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dashboard = () => props.dashboard;
  const defaultMode = dashboard().venue.signupMode === "free" ? "free" : "shifts";
  const [mode, setMode] = createSignal<"shifts" | "free">(defaultMode);
  const [freeRange, setFreeRange] = createSignal<DateRangeValue>(defaultShiftRange());
  const [note, setNote] = createSignal("");
  const hasShiftTemplates = () => dashboard().templates.some((template) => template.active);
  // The dialog owns its window instead of reusing the calendar's: it always starts today and grows on request.
  const slotPages = query.createInfinite<{ venueId: string; startDate: string }, SlotPage, string>({
    source: () => ({
      venueId: dashboard().venue.id,
      startDate: dates.formatDateKey(new Date(), { timeZone: dashboard().venue.timezone }),
    }),
    isSameSource: (left, right) => left.venueId === right.venueId && left.startDate === right.startDate,
    enabled: () => dashboard().venue.signupMode !== "free" && hasShiftTemplates(),
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
  const availableSlots = () => slotPages.pages().flatMap((page) => page.slots);
  const joined = (slot: UpcomingSlot) => slot.assignments.some((assignment) => assignment.userId === props.userId);
  const shownTimes = () =>
    mode() === "shifts"
      ? availableSlots().flatMap((slot) => [slot.startsAt, slot.endsAt])
      : [freeRange().start, freeRange().end].filter((time): time is string => Boolean(time));
  const loadedThrough = () => {
    const last = slotPages.pages().at(-1);
    if (!last) return "";
    return formatDateKey(shiftDate(last.startDate, SIGNUP_PAGE_DAYS - 1), locale(), { weekday: "short", day: "numeric", month: "short" });
  };

  /** Resolves to the number of new sign-ups: the weeks sign-up skips weeks the viewer already has or that are full. */
  const signup = mutation.create<number, { venueId: string; templateId: string; date: string; weeks?: number }>({
    mutation: async ({ venueId, templateId, date, weeks }, { abortSignal }) => {
      const target = apiClient.venues[":id"].templates[":templateId"];
      if (weeks) {
        const res = await target["signup-weeks"].$post(
          { param: { id: venueId, templateId }, json: { date, weeks } },
          { init: { signal: abortSignal } },
        );
        if (!res.ok) throw new Error(await readError(res, t().signupFailed));
        return (await res.json()).length;
      }
      const res = await target.signup.$post({ param: { id: venueId, templateId }, json: { date } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().signupFailed));
      return 1;
    },
    onSuccess: (added) => {
      if (added === 0) {
        toast(t().noShiftsAdded);
        return;
      }
      toast.success(added === 1 ? t().shiftAdded : t().shiftsAdded({ count: added }));
      props.close(true);
    },
    onError: (err) => prompts.error(err.message),
  });

  const freeSignup = mutation.create<void, { venueId: string; startsAt: string; endsAt: string; note: string | null }>({
    mutation: async ({ venueId, startsAt, endsAt, note: signupNote }, { abortSignal }) => {
      const res = await apiClient.venues[":id"]["free-signup"].$post(
        { param: { id: venueId }, json: { startsAt, endsAt, note: signupNote } },
        { init: { signal: abortSignal } },
      );
      if (!res.ok) throw new Error(await readError(res, t().signupFailed));
    },
    onSuccess: () => {
      toast.success(t().shiftAdded);
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
      venueId: dashboard().venue.id,
      startsAt: range.start,
      endsAt: range.end,
      note: note().trim() || null,
    });
  };

  onCleanup(() => {
    slotPages.abort();
    signup.abort();
    freeSignup.abort();
  });

  return (
    <PanelDialog>
      <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <PanelDialog.Header
          title={t().signUpForShift}
          subtitle={dashboard().venue.name}
          icon="ti ti-user-plus"
          close={() => props.close(false)}
        />
        <PanelDialog.Body>
          <Show when={dashboard().venue.signupMode === "both"}>
            <SegmentedControl
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "shifts", label: t().shiftSlots, icon: "ti ti-calendar-event" },
                { value: "free", label: t().freeTime, icon: "ti ti-clock-plus" },
              ]}
            />
          </Show>
          <VenueTimeZoneNote timeZone={dashboard().venue.timezone} times={shownTimes()} />
          <Show
            when={mode() === "shifts"}
            fallback={
              <div class="grid gap-3">
                <DateRangePicker
                  label={t().time}
                  value={freeRange}
                  onValueChange={setFreeRange}
                  withTime
                  dateConfig={timeZoneDateConfig(dashboard().venue.timezone, locale())}
                  durationPresets={[
                    { label: "2h", minutes: 120 },
                    { label: "4h", minutes: 240 },
                    { label: "8h", minutes: 480 },
                  ]}
                />
                <TextInput label={t().note} value={note} onValueChange={setNote} multiline lines={3} />
                <Button
                  type="button"
                  size="sm"
                  class="justify-center"
                  disabled={freeSignup.loading()}
                  onClick={() => void submitFreeSignup()}
                >
                  <i class={freeSignup.loading() ? "ti ti-loader-2 animate-spin" : "ti ti-plus"} />
                  {t().addFreeShift}
                </Button>
              </div>
            }
          >
            <Show
              when={hasShiftTemplates()}
              fallback={
                <Placeholder
                  surface="paper"
                  variant="panel"
                  title={t().noShiftsAvailable}
                  description={t().noShiftsAvailableDescription}
                  icon="ti ti-calendar-off"
                />
              }
            >
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
                      each={availableSlots()}
                      fallback={
                        <Placeholder
                          surface="paper"
                          variant="panel"
                          title={t().noShiftsUntil({ date: loadedThrough() })}
                          description={t().noShiftsUntilDescription}
                          icon="ti ti-calendar-off"
                        />
                      }
                    >
                      {(slot) => (
                        <div class="paper p-3">
                          <div class="flex items-start justify-between gap-3">
                            <div class="min-w-0">
                              <p class="font-medium text-primary">{slot.template.title}</p>
                              <p class="text-xs text-dimmed">
                                {formatVenueSpan(slot.startsAt, slot.endsAt, dashboard().venue.timezone, locale())}
                              </p>
                            </div>
                            <Show
                              when={joined(slot)}
                              fallback={
                                <span
                                  class={`tag ${slot.full ? "bg-zinc-100 text-dimmed dark:bg-zinc-800" : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"}`}
                                >
                                  {slot.full ? t().full : t().openSpots}
                                </span>
                              }
                            >
                              <span class="tag bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                                <i class="ti ti-check" aria-hidden="true" /> {t().joined}
                              </span>
                            </Show>
                          </div>
                          <div class="mt-3">
                            <ProgressBar slot={slot} />
                          </div>
                          <div class="mt-3 flex flex-wrap gap-2">
                            <Button
                              type="button"
                              size="sm"
                              disabled={joined(slot) || slot.full || !isSlotActive(slot) || signup.loading()}
                              onClick={() =>
                                signup.mutate({
                                  venueId: dashboard().venue.id,
                                  templateId: slot.template.id,
                                  date: slot.date,
                                })
                              }
                            >
                              {t().join}
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              disabled={slot.full || !isSlotActive(slot) || signup.loading()}
                              onClick={() =>
                                signup.mutate({
                                  venueId: dashboard().venue.id,
                                  templateId: slot.template.id,
                                  date: slot.date,
                                  weeks: 4,
                                })
                              }
                            >
                              {t().joinNextWeeks({ count: 4 })}
                            </Button>
                          </div>
                        </div>
                      )}
                    </For>
                    <Show when={slotPages.error()}>
                      <InlineGuidance tone="danger" icon="ti ti-alert-circle">
                        {t().loadShiftsFailed}
                      </InlineGuidance>
                    </Show>
                    <div class="flex flex-wrap items-center justify-between gap-2 px-1 pt-1">
                      <p class="text-xs text-dimmed">{t().shiftsUpTo({ count: availableSlots().length, date: loadedThrough() })}</p>
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
          <Button type="button" variant="secondary" size="sm" onClick={() => props.close(false)}>
            {t().close}
          </Button>
        </PanelDialog.Footer>
      </div>
    </PanelDialog>
  );
}

export function ConfirmShiftSignupDialog(props: { slot: UpcomingSlot; timezone: string; close: (confirmed: boolean) => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const [skipConfirm, setSkipConfirm] = createSignal(false);
  const confirm = () => {
    if (skipConfirm()) cookies.writeJsonCookie(DOUBLE_CLICK_CONFIRM_COOKIE, true);
    props.close(true);
  };
  return (
    <div class="grid gap-4">
      <div class="rounded-xl bg-zinc-50 p-3 text-sm dark:bg-zinc-900">
        <p class="font-semibold text-primary">{props.slot.template.title}</p>
        <p class="mt-1 text-dimmed">{formatVenueSpan(props.slot.startsAt, props.slot.endsAt, props.timezone, locale())}</p>
        <div class="mt-3">
          <ProgressBar slot={props.slot} />
        </div>
      </div>
      <VenueTimeZoneNote timeZone={props.timezone} times={[props.slot.startsAt, props.slot.endsAt]} />
      <CheckboxCard
        label={t().skipConfirmation}
        description={t().skipConfirmationDescription}
        icon="ti ti-click"
        value={skipConfirm}
        onValueChange={setSkipConfirm}
        variant="input"
      />
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close(false)}>
          {t().cancel}
        </Button>
        <Button type="button" size="sm" onClick={confirm}>
          {t().joinShiftAction}
        </Button>
      </div>
    </div>
  );
}
