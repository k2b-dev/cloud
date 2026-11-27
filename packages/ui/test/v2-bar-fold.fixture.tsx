import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, Pane, Tabs, Text, Workspace } from "../src/v2";

// Two heads that do not fit on the phone, each in a box of its own (`.case`):
// - "record": three tabs and six actions that stay on the phone (`keep`), then the primary action. What does not fit
//   folds into "…"; every action writes its name to `window.__deeds`.
// - "book": the head of a notebook page, a title and a button "1.000 Kommentare" in the start, two actions at its end.
//   The start gives way: its words shorten with "…".

declare global {
  interface Window {
    __deeds?: string[];
  }
}

const deed = (name: string) => () => {
  window.__deeds = [...(window.__deeds ?? []), name];
};

const actions = [
  { icon: "share", label: "Teilen" },
  { icon: "printer", label: "Drucken" },
  { icon: "download", label: "Exportieren" },
  { icon: "history", label: "Verlauf" },
  { icon: "copy", label: "Duplizieren" },
  { icon: "archive", label: "Archivieren" },
];

export function Fixture() {
  return (
    <LocaleProvider locale="de">
      <div class="case" data-case="record">
        <Workspace
          head={
            <Bar
              start={
                <Tabs
                  label="Ansichten"
                  items={[
                    { label: "Übersicht", href: "#overview", current: true },
                    { label: "Aktivität", href: "#activity" },
                    { label: "Dateien", href: "#files" },
                  ]}
                />
              }
              end={
                <>
                  {actions.map((action) => (
                    <Button keep icon={action.icon} label={action.label} onClick={deed(action.label)} />
                  ))}
                  <Button keep variant="primary" icon="plus" label="Neuer Auftrag" onClick={deed("Neuer Auftrag")} />
                </>
              }
            />
          }
        >
          <Pane label="Auftrag">
            <Text>Der Auftrag A-26-0447.</Text>
          </Pane>
        </Workspace>
      </div>
      <div class="case" data-case="book">
        <Workspace
          head={
            <Bar
              start={
                <>
                  <Text type="row" weight="strong">
                    Wochenplan Lager Nord
                  </Text>
                  <Button variant="text" icon="message" onClick={deed("Kommentare")}>
                    1.000 Kommentare
                  </Button>
                </>
              }
              end={
                <>
                  <Button keep icon="share" label="Teilen" onClick={deed("Teilen")} />
                  <Button keep icon="star" label="Merken" onClick={deed("Merken")} />
                </>
              }
            />
          }
        >
          <Pane label="Seite">
            <Text>Die Seite des Notizbuchs.</Text>
          </Pane>
        </Workspace>
      </div>
    </LocaleProvider>
  );
}
