import { createSignal } from "solid-js";
import { Band, Bar, Button, Facts, Field, Pane, Rating, Text, Workspace } from "../src/v2";

// A rating as a feedback form asks for it: a required question held by the page, with its reading as the hint, and
// the form's send; beside it a rating that keeps its own choice, one that is locked, one with an error, and given
// ratings shown read-only (whole stars, an average, none yet, one past the scale). What a person chose lands in `window.__rated`, what the
// form sends in `window.__sent`.

declare global {
  interface Window {
    __rated?: number[];
    __sent?: Record<string, string>[];
  }
}

export const Demo = () => {
  const [stars, setStars] = createSignal<number>();
  return (
    <Workspace head={<Bar start={<Text type="lead">Rückmeldung</Text>} />}>
      <Pane label="Rückmeldung">
        <form
          id="visit"
          onSubmit={(event) => {
            event.preventDefault();
            const sent = Object.fromEntries([...new FormData(event.currentTarget)].map(([key, value]) => [key, String(value)]));
            window.__sent = [...(window.__sent ?? []), sent];
          }}
        >
          <Band>
            <Field name="stars" label="Wie war dein Besuch?" required hint={stars() ? `${stars()} von 5` : "Wähle 1 bis 5 Sterne."}>
              <Rating
                value={stars()}
                onChange={(value) => {
                  setStars(value);
                  window.__rated = [...(window.__rated ?? []), value];
                }}
              />
            </Field>
          </Band>
          <Bar end={<Button variant="primary" type="submit" label="Senden" />} />
        </form>
        <Band>
          <Rating name="kept" label="Wie war das Essen?" value={3} />
          <Field label="Gesperrt">
            <Rating value={2} disabled />
          </Field>
          <Field label="Mit Fehler" error="Wähle mindestens einen Stern." required>
            <Rating />
          </Field>
        </Band>
        <Band>
          <Facts
            items={[
              { label: "Gesendet", value: <Rating readOnly value={4} /> },
              { label: "Durchschnitt", value: <Rating readOnly value={4.2} /> },
              { label: "Noch keine", value: <Rating readOnly value={0} /> },
              { label: "Zu viel", value: <Rating readOnly value={7} /> },
            ]}
          />
        </Band>
      </Pane>
    </Workspace>
  );
};
