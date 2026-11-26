import { dates } from "@k2b/stdlib";
import { DatePicker } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

/**
 * "Datum und Uhrzeit …" of "Später anzeigen" and "Erinnere mich": the v2 calendar with a time, in the person's time
 * zone, from today on. It starts at the time set now, else at an offered time (tomorrow at 8:00), so its month shows
 * the days that matter and "Übernehmen" works at once; a time already past is refused under the calendar.
 */
export const MailV2TimePicker = (props: {
  label: string;
  timeZone: string;
  /** The time set now, as an instant. */
  current: string | null;
  /** Where the calendar starts without a time set now: an offered time, as an instant. */
  suggested: string;
  pastError: string;
  onPick: (at: string) => void;
}) => {
  const [error, setError] = createSignal<string>();
  const today = dates.instantToZonedInput(new Date(Date.now()), props.timeZone).slice(0, 10);
  const start = props.current && Date.parse(props.current) > Date.now() ? props.current : props.suggested;
  const value = dates.instantToZonedInput(start, props.timeZone);
  return (
    <DatePicker
      time
      label={props.label}
      timeZone={props.timeZone}
      min={today}
      defaultTime="08:00"
      value={value}
      {...(error() ? { error: error() } : {})}
      autoFocus
      onPick={(wall) => {
        const at = dates.zonedDateTimeToInstant(wall, props.timeZone, { disambiguation: "compatible" });
        if (Date.parse(at) <= Date.now()) return void setError(props.pastError);
        props.onPick(at);
      }}
    />
  );
};
