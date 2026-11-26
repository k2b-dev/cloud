import { createSignal } from "solid-js";
import {
  Band,
  CodeInput,
  ColorInput,
  Disclosure,
  Field,
  Group,
  ImageInput,
  Input,
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
          {/* a field with a limit says how much is left once the text nears it */}
          <Field name="title" label="Titel der Seite">
            <Input maxLength={20} count value="Anmeldung" />
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
        <form id="sent" onSubmit={(event) => event.preventDefault()}>
          <Band>
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
