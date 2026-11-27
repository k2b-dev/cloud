import { createSignal } from "solid-js";
import { LocaleProvider } from "../src/intl/locale";
import { Bar, Button, Menu, Pane, Tabs, Text, Workspace } from "../src/v2";

// Heads that do not fit on the phone, each in a box of its own (`.case`):
// - "record": three tabs and seven actions that stay on the phone (`keep`), then the primary action. The start stays
//   whole; what does not fit folds into "…". "Favorit" is a toggle (`window.__k2Press()` flips it), "Archivieren"
//   can be locked (`window.__k2Lock(true)`). Every action writes its name to `window.__deeds`.
// - "book": the head of a notebook page, a title and a button "1.000 Kommentare" in the start, five actions at its
//   end. All of them fold, and then the start shortens down to its least.
// - "menu": a title, four actions and the head's own menu "…" at the end: the folded actions are its first section.
// - "before": a draft's head whose plain "…" stands before the primary "Senden": the "…" takes the folded actions,
//   among them a link ("Vorschau") that `window.__k2Lock(true)` disables.
// - "reader": Mail's reader in small: a long subject, the primary "Erledigt", four actions, a menu with words
//   ("Später") and the head's own "…".
// - "tabs": four tabs, two actions, the primary and a menu with a symbol of its own ("Filter") at the very end.
// - "history": Notebooks' version history: a fixed label "Versionsverlauf" and a long note title in the start, two
//   actions at the end. The title takes the shortage; the label stays whole.

declare global {
  interface Window {
    __deeds?: string[];
    __k2Press?: () => void;
    __k2Lock?: (locked: boolean) => void;
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
];

export function Fixture() {
  const [favourite, setFavourite] = createSignal(false);
  const [locked, setLocked] = createSignal(false);
  if (typeof window !== "undefined") {
    window.__k2Press = () => setFavourite((on) => !on);
    window.__k2Lock = setLocked;
  }
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
                  <Button keep icon="copy" label="Duplizieren" onClick={deed("Duplizieren")} />
                  <Button
                    keep
                    icon="star"
                    label={favourite() ? "Favorit entfernen" : "Favorit"}
                    pressed={favourite()}
                    onClick={deed("Favorit")}
                  />
                  <Button keep icon="archive" label="Archivieren" disabled={locked()} onClick={deed("Archivieren")} />
                  <Button keep variant="primary" icon="plus" onClick={deed("Neu")}>
                    Neu
                  </Button>
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
                  <Button keep icon="printer" label="Drucken" onClick={deed("Drucken")} />
                  <Button keep icon="history" label="Verlauf" onClick={deed("Verlauf")} />
                  <Button keep icon="archive" label="Archivieren" onClick={deed("Archivieren")} />
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
      <div class="case" data-case="menu">
        <Workspace
          head={
            <Bar
              start={
                <Text type="row" weight="strong">
                  Angebot Lackfabrik Nordhaus
                </Text>
              }
              end={
                <>
                  {actions.map((action) => (
                    <Button keep icon={action.icon} label={action.label} onClick={deed(action.label)} />
                  ))}
                  <Menu
                    items={[
                      { label: "Umbenennen", icon: "pencil", onClick: deed("Umbenennen") },
                      { label: "Löschen", icon: "trash", danger: true, onClick: deed("Löschen") },
                    ]}
                  />
                </>
              }
            />
          }
        >
          <Pane label="Angebot">
            <Text>Das Angebot.</Text>
          </Pane>
        </Workspace>
      </div>
      <div class="case" data-case="before">
        <Workspace
          head={
            <Bar
              start={
                <Text type="row" weight="strong">
                  Entwurf an Lackfabrik Nordhaus
                </Text>
              }
              end={
                <>
                  <Button keep icon="paperclip" label="Anhängen" onClick={deed("Anhängen")} />
                  <Button keep icon="clock" label="Planen" onClick={deed("Planen")} />
                  <Button keep icon="external-link" label="Vorschau" href="#preview" disabled={locked()} />
                  <Menu items={[{ label: "Verwerfen", icon: "trash", danger: true, onClick: deed("Verwerfen") }]} />
                  <Button keep variant="primary" icon="send" onClick={deed("Senden")}>
                    Senden
                  </Button>
                </>
              }
            />
          }
        >
          <Pane label="Entwurf">
            <Text>Der Entwurf.</Text>
          </Pane>
        </Workspace>
      </div>
      <div class="case" data-case="history">
        <Workspace
          head={
            <Bar
              start={
                <>
                  <Text type="row">Versionsverlauf</Text>
                  <Text type="row" weight="strong">
                    Wochenplan Lager Nord mit allen Lieferungen bis Ende Dezember
                  </Text>
                </>
              }
              end={
                <>
                  <Button keep icon="restore" label="Wiederherstellen" onClick={deed("Wiederherstellen")} />
                  <Button keep icon="x" label="Schließen" onClick={deed("Schließen")} />
                </>
              }
            />
          }
        >
          <Pane label="Version">
            <Text>Eine frühere Version.</Text>
          </Pane>
        </Workspace>
      </div>
      <div class="case" data-case="reader">
        <Workspace
          head={
            <Bar
              start={
                <Text type="row" weight="strong">
                  Rückfrage zur Lieferung der Fronten für die Küche Familie Oswald in Auental
                </Text>
              }
              end={
                <>
                  <Button keep variant="primary" icon="check" label="Erledigt" onClick={deed("Erledigt")} />
                  <Button keep icon="archive" label="Archiv" onClick={deed("Archiv")} />
                  <Button keep icon="trash" label="Löschen" onClick={deed("Löschen")} />
                  <Menu icon="clock" label="Später" items={[{ label: "Morgen früh", onClick: deed("Morgen früh") }]} />
                  <Button keep icon="user-plus" label="Zuweisen" onClick={deed("Zuweisen")} />
                  <Menu items={[{ label: "Weiterleiten", icon: "share-3", onClick: deed("Weiterleiten") }]} />
                </>
              }
            />
          }
        >
          <Pane label="Nachricht">
            <Text>Die Nachricht.</Text>
          </Pane>
        </Workspace>
      </div>
      <div class="case" data-case="tabs">
        <Workspace
          head={
            <Bar
              start={
                <Tabs
                  label="Bereiche"
                  items={[
                    { label: "Eingang", href: "#in", current: true },
                    { label: "Geplant", href: "#planned" },
                    { label: "Gesendet", href: "#sent" },
                    { label: "Archiv", href: "#archive" },
                  ]}
                />
              }
              end={
                <>
                  <Button keep icon="refresh" label="Aktualisieren" onClick={deed("Aktualisieren")} />
                  <Button keep icon="download" label="Exportieren" onClick={deed("Exportieren")} />
                  <Button keep variant="primary" icon="plus" onClick={deed("Neu")}>
                    Neu
                  </Button>
                  <Menu icon="filter" label="Filter" items={[{ label: "Nur ungelesene", onClick: deed("Nur ungelesene") }]} />
                </>
              }
            />
          }
        >
          <Pane label="Liste">
            <Text>Die Liste.</Text>
          </Pane>
        </Workspace>
      </div>
    </LocaleProvider>
  );
}
