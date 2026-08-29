import { cookies } from "@k2b/stdlib/browser";
import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  DateRangePicker,
  type DateRangeValue,
  PanelDialog,
  Placeholder,
  prompts,
  SegmentedControl,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { UpcomingSlot, VenueDashboard } from "../../../contracts";
import { venueMessages } from "../../../messages";
import { DOUBLE_CLICK_CONFIRM_COOKIE } from "./constants";
import { ProgressBar } from "./schedule";
import { defaultShiftRange, fmt, fmtTime, isSlotActive, readError, timeZoneDateConfig } from "./utils";

export function SignupDialog(props: { dashboard: VenueDashboard; close: (changed: boolean) => void }) {
  const locale = useLocale();
  const t = () => venueMessages.resolve([locale()]).t;
  const dashboard = () => props.dashboard;
  const defaultMode = dashboard().venue.signupMode === "free" ? "free" : "shifts";
  const [mode, setMode] = createSignal<"shifts" | "free">(defaultMode);
  const [freeRange, setFreeRange] = createSignal<DateRangeValue>(defaultShiftRange());
  const [note, setNote] = createSignal("");
  const availableSlots = createMemo(() => dashboard().slots.filter(isSlotActive).slice(0, 16));

  const signup = mutation.create<void, { venueId: string; templateId: string; date: string; weeks?: number }>({
    mutation: async ({ venueId, templateId, date, weeks }, { abortSignal }) => {
      const target = apiClient.venues[":id"].templates[":templateId"];
      const res = weeks
        ? await target["signup-weeks"].$post(
            { param: { id: venueId, templateId }, json: { date, weeks } },
            { init: { signal: abortSignal } },
          )
        : await target.signup.$post({ param: { id: venueId, templateId }, json: { date } }, { init: { signal: abortSignal } });
      if (!res.ok) throw new Error(await readError(res, t().signupFailed));
    },
    onSuccess: () => {
      toast.success(t().shiftAdded);
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
            <div class="flex flex-col gap-2">
              <For
                each={availableSlots()}
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
                {(slot) => (
                  <div class="paper p-3">
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0">
                        <p class="font-medium text-primary">{slot.template.title}</p>
                        <p class="text-xs text-dimmed">
                          {fmt(slot.startsAt, locale())} · {slot.template.startTime}-{slot.template.endTime}
                        </p>
                      </div>
                      <span
                        class={`tag ${slot.full ? "bg-zinc-100 text-dimmed dark:bg-zinc-800" : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"}`}
                      >
                        {slot.full ? t().full : t().open}
                      </span>
                    </div>
                    <div class="mt-3">
                      <ProgressBar slot={slot} />
                    </div>
                    <div class="mt-3 flex flex-wrap gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={slot.full || !isSlotActive(slot) || signup.loading()}
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
            </div>
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
        <p class="mt-1 text-dimmed">
          {fmt(props.slot.startsAt, locale())} · {fmtTime(props.slot.startsAt, props.timezone, locale())}-
          {fmtTime(props.slot.endsAt, props.timezone, locale())}
        </p>
        <div class="mt-3">
          <ProgressBar slot={props.slot} />
        </div>
      </div>
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
