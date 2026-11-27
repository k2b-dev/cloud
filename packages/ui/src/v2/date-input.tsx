import { createRenderEffect, createSignal, Show } from "solid-js";
import { formatDateInput, parseDateInput } from "../inputs/date-input";
import { dateKey, isCalendarDay, isDateKey } from "../inputs/date-picker";
import { useLocale } from "../intl/locale";
import { usePopover } from "./behavior/overlays";
import { useField } from "./controls";
import { useDateMessages } from "./date-messages";
import { DatePicker } from "./date-picker";
import { Icon } from "./marks";

export type DateInputProps = {
  /** The date as a date key ("2026-12-15") or as the locale writes it ("15.12.2026"); the field shows the second. */
  value?: string;
  /**
   * A picked or typed date as a date key ("2026-12-15"), or "" when the field was emptied. Typed text applies on Enter
   * or when the field is left; text that is no date marks the field and applies nothing.
   */
  onInput?: (value: string) => void;
  /** A quiet example date while the field is empty. */
  placeholder?: string;
  /** The name a form sends the date key under; the field's name by default. */
  name?: string;
  /** A name when the date stands without a Field. */
  label?: string;
  /**
   * The zone that says which day today is, for words such as "heute" or "+3" and the calendar's today; "UTC" by
   * default. Give the person's zone, the same on the server and in the island, as for `FilterBar`.
   */
  timeZone?: string;
};

/**
 * A date field: the date typed in the order of the locale ("24.11.2026", also "heute", "+3", "Mi"), and the calendar
 * symbol at its end opens `DatePicker` below it. Picking a day fills the field and gives the focus back to it.
 */
export const DateInput = (props: DateInputProps) => {
  const field = useField();
  const locale = useLocale();
  const t = useDateMessages();
  // today in one zone on the server and in the browser, so "heute" names the same day on both sides
  const today = () => dateKey(new Date(), { timeZone: props.timeZone ?? "UTC" });
  /** A date key for a value, or `undefined` when it is no readable date (also a key of a day that does not exist). */
  const keyOf = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    if (isDateKey(value)) return isCalendarDay(value) ? value : undefined;
    const read = parseDateInput(value, { today: today(), locale: locale() });
    return read.kind === "date" ? read.date : undefined;
  };
  const shown = (value: string | undefined) => (value && isCalendarDay(value) ? formatDateInput(value, locale()) : (value ?? ""));
  // Without `onInput` the field keeps what was picked or typed itself, so it always shows the date it holds.
  const [own, setOwn] = createSignal(props.value);
  createRenderEffect(() => setOwn(props.value));
  const [text, setText] = createSignal(shown(props.value));
  createRenderEffect(() => setText(shown(own())));
  const [unreadable, setUnreadable] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let input: HTMLInputElement | undefined;
  const take = (key: string) => {
    setUnreadable(false);
    setOwn(key);
    setText(shown(key));
    props.onInput?.(key);
  };
  const commit = (typed: string) => {
    if (!typed.trim()) {
      if (keyOf(own()) !== undefined || own()) take("");
      setUnreadable(false);
      return;
    }
    const key = keyOf(typed);
    if (key === undefined) {
      setUnreadable(true);
      return;
    }
    if (key !== keyOf(own())) take(key);
    else {
      setUnreadable(false);
      setText(shown(key));
    }
  };
  const popover = usePopover(() => ({ open: open(), onOpenChange: setOpen }));
  const invalid = () => field?.invalid || unreadable();
  // text that is no date makes the form invalid too, so it never sends the date the field held before
  // (the message is read before the element is there, so the effect follows it from the start)
  createRenderEffect(() => {
    const message = unreadable() ? t().unreadable : "";
    input?.setCustomValidity(message);
  });
  return (
    <span class="k2-input" data-k2-part="DateInput" data-invalid={invalid() ? "" : undefined}>
      <input
        ref={input}
        id={field?.control}
        type="text"
        inputmode="numeric"
        autocomplete="off"
        value={text()}
        placeholder={props.placeholder}
        aria-label={field ? undefined : props.label}
        aria-invalid={invalid() ? "true" : undefined}
        aria-describedby={field?.described}
        title={unreadable() ? t().unreadable : undefined}
        required={field?.required || undefined}
        onInput={(event) => setText(event.currentTarget.value)}
        onChange={(event) => commit(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.isComposing) commit(event.currentTarget.value);
          if (event.key === "ArrowDown" && event.altKey) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      />
      <Show when={props.name ?? field?.name}>{(name) => <input type="hidden" name={name()} value={keyOf(own()) ?? own() ?? ""} />}</Show>
      <span class="k2-input-end">
        <popover.Trigger
          class="k2-btn"
          data-k2-part="Button"
          data-variant="ghost"
          data-icon-only=""
          aria-label={t().openCalendar}
          title={t().openCalendar}
        >
          <Icon name="calendar" />
        </popover.Trigger>
      </span>
      <popover.Popup class="k2-pop k2-dpop" data-k2-part="Popover" side="bottom" align="end" sideOffset={4} collisionPadding={8}>
        <DatePicker
          value={keyOf(own())}
          timeZone={props.timeZone ?? "UTC"}
          label={props.label}
          autoFocus
          onPick={(key) => {
            take(key);
            setOpen(false);
            input?.focus({ preventScroll: true });
          }}
        />
      </popover.Popup>
    </span>
  );
};
