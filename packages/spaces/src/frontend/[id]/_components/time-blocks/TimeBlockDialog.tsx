import { type DateContext, dates } from "@k2b/stdlib";
import {
  AutocompleteSelect,
  BottomSheet,
  Button,
  bottomSheetAdaptiveOptions,
  DatePicker,
  dialogCore,
  NumberInput,
  TextInput,
} from "@k2b/ui";
import { createSignal, createUniqueId, Show } from "solid-js";
import type { SpaceItem } from "@/contracts";
import { formatDeadline } from "@/presentation/deadline";
import type { SpaceTimeBlock } from "../../../../time-block-contracts";
import { instantFromLocalDateTime } from "../shared/item-form/date";
import { createTimeBlock, updateTimeBlock } from "./client";
import { useTimeBlockMessages } from "./messages";

type Props = {
  spaceId: string;
  item: Pick<SpaceItem, "id" | "title" | "estimatedDurationMinutes" | "deadline">;
  block?: SpaceTimeBlock;
  day?: string;
  dateConfig?: DateContext;
  close: (block: SpaceTimeBlock | null) => void;
  registerDismiss?: (handler: () => void) => void;
};
export function TimeBlockDialog(props: Props) {
  const t = useTimeBlockMessages();
  const [date, setDate] = createSignal<string | null>(
    props.block
      ? dates.formatDateKey(props.block.startsAt, props.dateConfig)
      : (props.day ?? dates.formatDateKey(dates.today(props.dateConfig), props.dateConfig)),
  );
  const [start, setStart] = createSignal(
    props.block ? dates.formatTime(props.block.startsAt, { ...props.dateConfig, locale: "en-GB" }) : "",
  );
  const [duration, setDuration] = createSignal<number | null>(
    props.block
      ? (Date.parse(props.block.endsAt) - Date.parse(props.block.startsAt)) / 60_000
      : (props.item.estimatedDurationMinutes ?? 60),
  );
  const [title, setTitle] = createSignal(props.block?.title ?? props.item.title);
  const [busy, setBusy] = createSignal(false);
  props.registerDismiss?.(() => {
    if (!busy()) props.close(null);
  });
  const [error, setError] = createSignal<string>();
  const [invalid, setInvalid] = createSignal<"date" | "start" | "duration" | null>(null);
  let form: HTMLFormElement | undefined;
  const formId = createUniqueId();
  const id = crypto.randomUUID();
  let submitted: { id: string; startsAt: string; endsAt: string } | undefined;
  const times = () => {
    if (!date() || !/^([01]\d|2[0-3]):[0-5]\d$/.test(start()) || !duration() || duration()! <= 0) return null;
    try {
      const startsAt = instantFromLocalDateTime(date()!, start(), props.dateConfig);
      return { startsAt, endsAt: new Date(Date.parse(startsAt) + duration()! * 60_000).toISOString() };
    } catch {
      return null;
    }
  };
  const afterDeadline = () => {
    const deadline = props.item.deadline;
    return Boolean(
      deadline && times() && (deadline.length === 10 ? date()! > deadline : Date.parse(times()!.startsAt) > Date.parse(deadline)),
    );
  };
  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy()) return;
    const field = !date() ? "date" : !/^([01]\d|2[0-3]):[0-5]\d$/.test(start()) ? "start" : !times() ? "duration" : null;
    setInvalid(field);
    if (field) {
      form?.querySelector<HTMLElement>(`[data-field="${field}"] input, [data-field="${field}"] button`)?.focus();
      return;
    }
    setBusy(true);
    try {
      // A failed create freezes its intent: reconcile that exact UUID before accepting another edit.
      const retry = Boolean(submitted);
      submitted ??= { id, ...times()! };
      const saved = props.block
        ? await updateTimeBlock(props.block.id, { ...times()!, title: title() }, t.updateFailed)
        : await createTimeBlock(props.spaceId, props.item.id, submitted, t.createFailed, retry);
      props.close(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      onDismiss={() => {
        if (!busy()) props.close(null);
      }}
      dismissDisabled={busy()}
    >
      <BottomSheet.Header title={props.block ? t.edit : t.block} subtitle={props.item.title} />
      <BottomSheet.Body>
        <form id={formId} ref={form} onSubmit={submit} class="spaces-time-block-form">
          <Show when={props.block}>
            <TextInput label={t.title} value={title()} onValueChange={setTitle} disabled={busy()} maxLength={200} required />
          </Show>
          <div class="spaces-time-block-fields">
            <div data-field="date">
              <DatePicker
                label={t.date}
                value={date()}
                onValueChange={(value) => {
                  setDate(value);
                  if (invalid() === "date") setInvalid(null);
                }}
                dateConfig={props.dateConfig}
                renderValue={(value) => formatDeadline(value, props.dateConfig)}
                disabled={busy() || Boolean(!props.block && submitted && error())}
                error={invalid() === "date" ? t.chooseDate : undefined}
              />
            </div>
            <div data-field="start">
              <AutocompleteSelect
                label={t.start}
                value={start() || null}
                onValueChange={(value) => {
                  setStart(value ?? "");
                  if (invalid() === "start") setInvalid(null);
                }}
                placeholder={t.choose}
                debounceMs={0}
                noMatchText={t.chooseStart}
                search={async (query) => ({
                  options: Array.from({ length: 96 }, (_, index) => {
                    const time = `${String(Math.floor(index / 4)).padStart(2, "0")}:${String((index % 4) * 15).padStart(2, "0")}`;
                    return { value: time, label: time };
                  }).filter((option) => option.label.includes(query)),
                  // Accept a complete clock time on Tab/blur, including times outside the quarter-hour suggestions.
                  match: /^([01]\d|2[0-3]):[0-5]\d$/.test(query) ? { value: query, label: query } : undefined,
                })}
                disabled={busy() || Boolean(!props.block && submitted && error())}
                error={invalid() === "start" ? t.chooseStart : undefined}
                aria-describedby={invalid() === "start" ? undefined : `${formId}-start-hint`}
              />
              <Show when={invalid() !== "start"}>
                <p id={`${formId}-start-hint`} class="spaces-time-block-hint">
                  {times() ? t.until({ time: dates.formatTime(times()!.endsAt, props.dateConfig) }) : "\u00a0"}
                </p>
              </Show>
            </div>
            <div data-field="duration">
              <NumberInput
                showSteppers={false}
                icon=""
                label={t.duration}
                value={duration()}
                onValueChange={(value) => {
                  setDuration(value);
                  if (invalid() === "duration") setInvalid(null);
                }}
                suffix={t.minutes}
                disabled={busy() || Boolean(!props.block && submitted && error())}
                error={invalid() === "duration" ? t.positiveDuration : undefined}
                aria-describedby={invalid() === "duration" ? undefined : `${formId}-duration-hint`}
              />
              <Show when={invalid() !== "duration"}>
                <p id={`${formId}-duration-hint`} class="spaces-time-block-hint">
                  {props.item.estimatedDurationMinutes
                    ? duration() === props.item.estimatedDurationMinutes
                      ? t.estimate
                      : t.estimateValue({ minutes: props.item.estimatedDurationMinutes })
                    : t.suggestion}
                </p>
              </Show>
            </div>
          </div>
          <div class="spaces-time-block-context text-sm text-dimmed">
            <Show when={props.item.deadline}>
              <p style={{ color: afterDeadline() ? "var(--k2b-warning-text)" : undefined }}>
                <i class={`ti ${afterDeadline() ? "ti-alert-triangle" : "ti-flag-3"}`} aria-hidden="true" />{" "}
                {afterDeadline()
                  ? t.afterDeadline({ date: formatDeadline(props.item.deadline!, props.dateConfig) })
                  : t.deadline({ date: formatDeadline(props.item.deadline!, props.dateConfig) })}
              </p>
            </Show>
            <p>
              <i class="ti ti-users" aria-hidden="true" /> {t.visible}
            </p>
          </div>
          <div class="spaces-time-block-error text-sm" role={error() ? "alert" : undefined}>
            <Show when={error()}>
              {(reason) => (
                <div class="flex items-start gap-1.5">
                  <i class="ti ti-alert-circle mt-0.5" aria-hidden="true" />
                  <div>
                    <p>{t.failed({ reason: reason() })}</p>
                    <p class="text-dimmed">{t.retained}</p>
                  </div>
                </div>
              )}
            </Show>
          </div>
        </form>
      </BottomSheet.Body>
      <BottomSheet.Footer>
        <Button variant="ghost" disabled={busy()} onClick={() => props.close(null)}>
          {t.cancel}
        </Button>
        <Button type="submit" form={formId} disabled={busy()} class="spaces-time-block-submit">
          <Show when={busy()}>
            <i class="ti ti-loader-2 animate-spin" aria-hidden="true" />
          </Show>
          <Show when={error() && !busy()}>
            <i class="ti ti-refresh" aria-hidden="true" />
          </Show>
          {busy() ? t.saving : error() ? t.retry : props.block ? t.save : t.block}
        </Button>
      </BottomSheet.Footer>
    </BottomSheet>
  );
}
export const openTimeBlockDialog = (props: Omit<Props, "close" | "registerDismiss">) =>
  dialogCore.open<SpaceTimeBlock | null>(
    (close, context) => <TimeBlockDialog {...props} close={close} registerDismiss={context.setDismissHandler} />,
    {
      ...bottomSheetAdaptiveOptions,
      panelClassName: `${bottomSheetAdaptiveOptions.panelClassName} spaces-time-block-dialog`,
    },
  );
