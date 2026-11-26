import { createSignal } from "solid-js";
import {
  Band,
  Choice,
  CodeInput,
  ColorInput,
  Disclosure,
  Field,
  Group,
  ImageInput,
  Pane,
  Section,
  Select,
  Slider,
  TagsInput,
  Text,
  Workspace,
} from "../src/v2";

// The form controls of v2 beyond text, as a settings page uses them: a field with a reset deed, a select that is
// locked and one with a dimmed option, tags, an image, a code, a disclosure and a folded group. Each deed lands in
// `window.__deeds`, so a test reads what ran.

declare global {
  interface Window {
    __deeds?: string[];
    /** While set, reading a picked image waits for this promise (a slow conversion). */
    __k2Gate?: Promise<void>;
  }
}

const did = (deed: string) => {
  window.__deeds = [...(window.__deeds ?? []), deed];
};

export function Demo() {
  const [session, setSession] = createSignal("7 Tage");
  const [tags, setTags] = createSignal(["werkstatt.example"]);
  const [image, setImage] = createSignal<string | null>(null);
  const [dim, setDim] = createSignal(30);
  const [accent, setAccent] = createSignal("#b45309");
  const [banner, setBanner] = createSignal<string | null>(null);
  const [zoom, setZoom] = createSignal(30);
  const [notify, setNotify] = createSignal<string[]>(["mail"]);
  return (
    <Workspace>
      <Pane label="Einstellungen">
        <Band>
          <Field
            name="session"
            label="Sitzungsdauer"
            action={{
              label: "Auf Standard zurücksetzen",
              icon: "restore",
              onClick: () => {
                setSession("24 Stunden");
                did("reset");
              },
            }}
          >
            <Select options={["8 Stunden", "24 Stunden", "7 Tage"]} value={session()} onChange={setSession} />
          </Field>
          <Field name="method" label="Verfahren" hint="Legt der Betreiber fest.">
            <Select options={["Passwort", "Passkey"]} value="Passwort" disabled onChange={() => did("method")} />
          </Field>
          <Field name="plan" label="Tarif">
            <Select
              options={[
                { value: "free", label: "Frei" },
                { value: "team", label: "Team", disabled: true },
                { value: "pro", label: "Pro" },
              ]}
              value="free"
              onChange={(value) => did(`plan:${value}`)}
            />
          </Field>
          <Field name="sender" label="Absender">
            <Select
              options={[
                "Annabelle Wohlgemuth-Lindqvist <annabelle.wohlgemuth-lindqvist@tischlerei-wohlgemuth-lindqvist.example>",
                "Büro <buero@tischlerei-wohlgemuth-lindqvist.example>",
              ]}
              value="Annabelle Wohlgemuth-Lindqvist <annabelle.wohlgemuth-lindqvist@tischlerei-wohlgemuth-lindqvist.example>"
              onChange={(value) => did(`sender:${value}`)}
            />
          </Field>
          <Field name="domains" label="Erlaubte Domains">
            <TagsInput
              value={tags()}
              onChange={(values) => {
                setTags(values);
                did(`tags:${values.join(",")}`);
              }}
              placeholder="z. B. firma.example"
            />
          </Field>
          <Field name="logo" label="Logo">
            <ImageInput
              value={image()}
              transform={async (file) => `data:text/plain,${encodeURIComponent(await file.text())}`}
              onChange={(value) => {
                setImage(value);
                did(`image:${value === null ? "none" : "set"}`);
              }}
            />
          </Field>
          <Field name="radius" label="Ecken">
            <Slider value={12} min={0} max={40} unit="px" />
          </Field>
          <Field name="dim" label="Abdunkeln">
            <Slider value={dim()} onChange={setDim} onCommit={(value) => did(`dim:${value}`)} min={0} max={100} step={10} />
          </Field>
          <Field name="accent" label="Akzentfarbe">
            <ColorInput
              value={accent()}
              onChange={setAccent}
              onCommit={(value) => did(`accent:${value}`)}
              swatches={["#0f766e", "#1d4ed8"]}
            />
          </Field>
          <Field name="code" label="Code vom anderen Gerät">
            <CodeInput onComplete={(code) => did(`code:${code}`)} />
          </Field>
        </Band>
        {/* a form that sends what it holds: uncontrolled tags, a locked list, a required image, a slider and a colour */}
        {/* several to choose, at least one (outside the form below, whose other checks it would hold up) */}
        <Band>
          {/* several to choose, at least one */}
          <Field name="crew" label="Mannschaft" required>
            <Choice name="crew" multiple options={["Anna Berg", "Jonas Wolf"]} />
          </Field>
        </Band>
        {/* an address in a right-to-left page */}
        <div dir="rtl">
          <Band>
            <Field name="rtl-sender" label="المرسل">
              <Select
                options={["Anna Berg <anna.berg@werkstatt-lindqvist.example>"]}
                value="Anna Berg <anna.berg@werkstatt-lindqvist.example>"
                onChange={() => undefined}
              />
            </Field>
          </Band>
        </div>
        <form id="sent" onSubmit={(event) => event.preventDefault()}>
          <Band>
            {/* people to choose, each with their face: one who is responsible, several who take part */}
            <Field name="owner" label="Zuständig">
              <Choice
                name="owner"
                value="anna"
                options={[
                  { value: "anna", label: "Anna Berg", person: { name: "Anna Berg", color: "#0f766e" } },
                  { value: "jonas", label: "Jonas Wolf", person: { name: "Jonas Wolf", color: "#7c3aed" } },
                  { value: "mia", label: "Mia Lindqvist-Oswald", person: { name: "Mia Lindqvist-Oswald" } },
                ]}
              />
            </Field>
            {/* held by the page: a form's reset must not show other boxes than the page holds */}
            <Field name="notify" label="Benachrichtigen">
              <Choice
                name="notify"
                multiple
                value={notify()}
                onChange={setNotify}
                options={[
                  { value: "mail", label: "Per Mail" },
                  { value: "push", label: "Auf dem Telefon" },
                ]}
              />
            </Field>
            <Field name="team" label="Beteiligt">
              <Choice
                name="team"
                multiple
                value={["jonas"]}
                options={[
                  { value: "anna", label: "Anna Berg", person: { name: "Anna Berg", color: "#0f766e" } },
                  { value: "jonas", label: "Jonas Wolf", person: { name: "Jonas Wolf", color: "#7c3aed" } },
                  { value: "mia", label: "Mia Lindqvist-Oswald", person: { name: "Mia Lindqvist-Oswald" } },
                ]}
              />
            </Field>
            {/* one of a few, as points */}
            <Field name="repeat" label="Wiederholen">
              <Choice name="repeat" value="Nie" options={["Nie", "Täglich", "Wöchentlich"]} />
            </Field>
            {/* a few kinds to compare, as one connected row of cards: symbol, words and a line each */}
            <Field name="source" label="Art der Quelle">
              <Choice
                name="source"
                cards
                value="poll"
                options={[
                  { value: "hook", label: "Webhook", icon: "webhook", hint: "Die Quelle meldet jede Änderung." },
                  { value: "poll", label: "Abruf", icon: "refresh", hint: "Cloud fragt in einem Takt nach." },
                  { value: "file", label: "Datei", icon: "file-upload", hint: "Einmal hochladen, von Hand." },
                  { value: "mail", label: "E-Mail", icon: "mail", hint: "Im Tarif nicht enthalten.", disabled: true },
                ]}
              />
            </Field>
            <Field name="hosts" label="Server">
              <TagsInput value={["mx1.example"]} />
            </Field>
            <Field name="locked" label="Gesperrte Server">
              <TagsInput value={["mx9.example"]} disabled />
            </Field>
            <Field name="banner" label="Banner" required>
              <ImageInput
                value={banner()}
                onChange={setBanner}
                transform={async (file) => {
                  await window.__k2Gate;
                  return `data:text/plain,${encodeURIComponent(await file.text())}`;
                }}
              />
            </Field>
            <Field name="level" label="Stufe" hint="Wie stark abgedunkelt wird.">
              <Slider value={30} step={10} />
            </Field>
            <Field name="zoom" label="Zoom">
              <Slider value={zoom()} onChange={setZoom} step={10} />
            </Field>
            <Field name="tone" label="Ton">
              <ColorInput value="#000000" />
            </Field>
          </Band>
        </form>
        <Section title="Fragen">
          <Disclosure title="Was passiert mit laufenden Sitzungen?">
            <Text type="body">Sie gelten bis zu ihrem Ende weiter.</Text>
          </Disclosure>
        </Section>
        <Section title="Lieferungen">
          <Group title="Lieferung 4711" folded>
            <Text type="body">Drei Pakete, zugestellt am 12. Nov.</Text>
          </Group>
        </Section>
      </Pane>
    </Workspace>
  );
}
