import { createSignal } from "solid-js";
import { Band, DateInput, DatePicker, Field } from "../src/v2";

declare global {
  interface Window {
    /** What the demo's DateInput and pickers gave, in order. */
    __dates?: string[];
  }
}

const record = (value: string) => {
  window.__dates = [...(window.__dates ?? []), value];
};

/** A date field in a form, a picker of a day and a picker of a day with its time, each showing what it holds. */
export function Demo() {
  const [date, setDate] = createSignal("2026-12-15");
  const [day, setDay] = createSignal("2026-11-24");
  const [moment, setMoment] = createSignal("2026-11-24T09:00");
  return (
    <Band>
      <div style={{ display: "flex", gap: "40px", "align-items": "flex-start", padding: "24px" }}>
        <form style={{ width: "240px" }} onSubmit={(event) => event.preventDefault()}>
          <Field label="Lieferdatum" name="delivery">
            <DateInput
              value={date()}
              onInput={(value) => {
                setDate(value);
                record(value);
              }}
            />
          </Field>
          <output data-testid="date">{date()}</output>
        </form>
        <section data-testid="day">
          <DatePicker
            value={day()}
            label="Tag"
            onPick={(value) => {
              setDay(value);
              record(value);
            }}
          />
          <output data-testid="day-value">{day()}</output>
        </section>
        <section data-testid="moment">
          <DatePicker
            time
            value={moment()}
            label="Zeitpunkt"
            min="2026-11-03"
            onPick={(value) => {
              setMoment(value);
              record(value);
            }}
            onClear={() => setMoment("")}
          />
          <output data-testid="moment-value">{moment()}</output>
        </section>
      </div>
      {/* values on a day before `min`, as an app may still hold them: shown, never picked again */}
      <div style={{ display: "flex", gap: "40px", "align-items": "flex-start", padding: "24px" }}>
        <section data-testid="locked-moment">
          <DatePicker time value="2026-11-02T09:00" label="Gesperrter Zeitpunkt" min="2026-11-03" onPick={record} />
        </section>
        <section data-testid="locked-day">
          <DatePicker value="2026-11-02" label="Gesperrter Tag" min="2026-11-03" onPick={record} />
        </section>
      </div>
    </Band>
  );
}
