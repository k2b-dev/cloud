import { TextInput } from "@k2b/ui";

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Whether `value` is a 24-hour clock time such as `09:30`. */
export const isClockTime = (value: string): boolean => TIME_PATTERN.test(value);

/** Whether `value` can end a time range: a clock time, or `24:00` for until midnight. */
export const isEndTime = (value: string): boolean => isClockTime(value) || value === "24:00";

/**
 * Completes what people type into a clock time: `9` becomes `09:00`, `930` becomes `09:30`, `9.5` becomes
 * `09:05`, and `24` becomes `24:00`, which only an end time accepts. Anything that is no time stays as typed, so
 * the field can say what is wrong.
 */
export const completeClockTime = (value: string): string => {
  const trimmed = value.trim();
  const parts = trimmed.split(/[:.]/);
  let hours: string;
  let minutes: string;
  if (parts.length === 2) [hours = "", minutes = ""] = parts;
  else if (/^\d{3,4}$/.test(trimmed)) [hours, minutes] = [trimmed.slice(0, -2), trimmed.slice(-2)];
  else [hours, minutes] = [trimmed, "0"];
  if (!/^\d{1,2}$/.test(hours) || !/^\d{1,2}$/.test(minutes)) return value;
  const completed = `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
  return isEndTime(completed) ? completed : value;
};

/**
 * A 24-hour clock time field: the numeric keypad on phones, and on leaving the field it completes short input
 * such as `9` to `09:00`. `@k2b/ui` has no time-only field, so this composes its `TextInput`.
 */
export function TimeInput(props: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  error?: string;
  placeholder?: string;
}) {
  return (
    <TextInput
      label={props.label}
      value={() => props.value}
      onValueChange={(value) => props.onValueChange(value.replace(/[^\d:.]/g, "").slice(0, 5))}
      onBlur={() => props.onValueChange(completeClockTime(props.value))}
      error={() => props.error}
      placeholder={props.placeholder}
      icon="ti ti-clock"
      activeIcon="ti ti-clock"
      inputMode="numeric"
      autocomplete="off"
      maxLength={5}
      required
    />
  );
}
