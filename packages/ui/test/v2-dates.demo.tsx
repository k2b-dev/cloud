import { createSignal } from "solid-js";
import { LocaleProvider } from "../src/intl/locale";
import { Band, Button, DateInput, DatePicker, Field } from "../src/v2";

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
  // a picker whose language changes while it is open: German (24 hours) and American English (AM/PM)
  const [lang, setLang] = createSignal<"de" | "en-US">("de");
  const [switched, setSwitched] = createSignal("2026-11-24T09:00");
  // a moment ahead: six weeks from the week of today (the tests stand on 25 November 2026)
  const [ahead, setAhead] = createSignal("");
  const [weeksLang, setWeeksLang] = createSignal<"de" | "en-US">("de");
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
      <div style={{ display: "flex", "flex-wrap": "wrap", gap: "40px", "align-items": "flex-start", padding: "24px" }}>
        <section data-testid="locked-moment">
          <DatePicker time value="2026-11-02T09:00" label="Gesperrter Zeitpunkt" min="2026-11-03" onPick={record} />
        </section>
        <section data-testid="locked-day">
          <DatePicker value="2026-11-02" label="Gesperrter Tag" min="2026-11-03" onPick={record} />
        </section>
        <section data-testid="weeks">
          <DatePicker view="weeks" min="2026-11-25" value={ahead() || undefined} label="Später" onPick={setAhead} />
          <output data-testid="weeks-value">{ahead()}</output>
          <Button onClick={() => setAhead("2027-03-01")}>Auf 1. März setzen</Button>
        </section>
        <section data-testid="weeks-max">
          <DatePicker view="weeks" min="2026-11-25" max="2026-12-31" label="Bis Jahresende" onPick={record} />
        </section>
        <section data-testid="weeks-switch">
          <LocaleProvider locale={weeksLang()}>
            <DatePicker view="weeks" min="2026-11-25" label="Umschaltbar" onPick={record} />
          </LocaleProvider>
          <Button onClick={() => setWeeksLang(weeksLang() === "de" ? "en-US" : "de")}>Wochen-Sprache wechseln</Button>
        </section>
        {/* without `min`: today in the picker's zone, never the zone of the server or the browser */}
        <section data-testid="weeks-zone">
          <DatePicker view="weeks" timeZone="Pacific/Kiritimati" label="Kiritimati" onPick={record} />
        </section>
        <section data-testid="weeks-utc">
          <DatePicker view="weeks" label="UTC" onPick={record} />
        </section>
        <section data-testid="switch">
          {/* inside a form: Enter in the time applies the picker and never sends the form */}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              record("submitted");
            }}
          >
            <LocaleProvider locale={lang()}>
              <DatePicker time value={switched()} label="Umschaltbar" onPick={setSwitched} />
            </LocaleProvider>
          </form>
          <Button onClick={() => setLang(lang() === "de" ? "en-US" : "de")}>Sprache wechseln</Button>
          <output data-testid="switch-value">{switched()}</output>
        </section>
      </div>
    </Band>
  );
}
