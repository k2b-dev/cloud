import { dates } from "@k2b/stdlib";
import { DatePicker } from "@k2b/ui/v2";
import { createSignal } from "solid-js";

/**
 * "Datum und Uhrzeit …" of "Später anzeigen" and "Erinnere mich": the v2 calendar with a time, in the person's time
 * zone, from today on. It starts at the time set now, else at 8:00; a time already past is refused under the calendar.
 */
export const MailV2TimePicker = (props: {
  label: string;
  timeZone: string;
  /** The time set now, as an instant. */
  current: string | null;
  pastError: string;
  onPick: (at: string) => void;
}) => {
  const [error, setError] = createSignal<string>();
  const today = dates.instantToZonedInput(new Date(), props.timeZone).slice(0, 10);
  const current =
    props.current && Date.parse(props.current) > Date.now() ? dates.instantToZonedInput(props.current, props.timeZone) : undefined;
  return (
    <DatePicker
      time
      label={props.label}
      timeZone={props.timeZone}
      min={today}
      defaultTime="08:00"
      {...(current ? { value: current } : {})}
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
