import { Bar, Button, Pane, Path, Text, Workspace } from "../src/v2";

// Paths that do not fit (Spaces, W3: "Space settin…" was cut before the long Space name): a deep path in the head
// beside its actions, and in the pane a long Space name before the settings, the same deep path, a page whose own name
// is too long with three and with five places, a path of short places that folds only on the phone, and a short deep
// path that fits. The names are invented.

const space = "Werkstatt Lindqvist-Oswald und Partner – Innenausbau, Möbelbau, Treppen, Fenster und Türen aus eigener Fertigung";
// a page whose own name is longer than the room of a pane at 1024 px
const page =
  "Einstellungen für Freigaben, Aufbewahrung, Benachrichtigungen und Mitglieder dieses Space mit allen Unterordnern, Vorlagen und Regeln der Werkstatt";
const deep = [
  { label: "Spaces", href: "#spaces" },
  { label: space, href: "#space" },
  { label: "Projekte", href: "#projekte" },
  { label: "Küche Familie Oswald", href: "#kueche" },
  { label: "Space-Einstellungen" },
];

// a crowded end beside a deep path: seven buttons that may fold and the primary, which never does
const Crowded = () => (
  <>
    <Button variant="ghost" icon="share" label="Teilen" />
    <Button variant="ghost" icon="printer" label="Drucken" />
    <Button variant="ghost" icon="download" label="Exportieren" />
    <Button variant="ghost" icon="history" label="Verlauf" />
    <Button variant="ghost" icon="copy" label="Duplizieren" />
    <Button variant="ghost" icon="star" label="Favorit" />
    <Button variant="ghost" icon="archive" label="Archivieren" />
    <Button variant="primary" label="Neu" />
  </>
);

export function Demo() {
  return (
    <Workspace
      head={
        <Bar
          start={<Path label="Ort im Kopf" items={deep} />}
          end={
            <>
              <Button variant="ghost" icon="share" label="Teilen" />
              <Button>Verwalten</Button>
            </>
          }
        />
      }
    >
      <Pane label="Pfade">
        <Bar start={<Path label="Ort lang" items={[{ label: space, href: "#space" }, { label: "Space-Einstellungen" }]} />} />
        <Bar start={<Path label="Ort tief" items={deep} />} />
        <Bar
          start={
            <Path label="Seite lang 3" items={[{ label: "Spaces", href: "#spaces" }, { label: space, href: "#space" }, { label: page }]} />
          }
        />
        <Bar start={<Path label="Seite lang 5" items={[...deep.slice(0, 4), { label: page }]} />} />
        <Bar
          start={
            <Path
              label="Ort mittel"
              items={[
                { label: "Spaces", href: "#spaces" },
                { label: "Werkstatt Nord", href: "#nord" },
                { label: "Projekte 2026", href: "#projekte" },
                { label: "Küche", href: "#kueche" },
                { label: "Angebot" },
              ]}
            />
          }
        />
        <Bar
          start={
            <Path
              label="Ort kurz"
              items={[
                { label: "Spaces", href: "#spaces" },
                { label: "Werkstatt", href: "#space" },
                { label: "Projekte", href: "#projekte" },
                { label: "Küche" },
              ]}
            />
          }
        />
        <Bar start={<Path label="Ort und Aktionen" items={deep} />} end={<Crowded />} />
        <Bar
          start={
            <Path
              label="Kurz und Aktionen"
              items={[
                { label: "Spaces", href: "#spaces" },
                { label: "Werkstatt", href: "#space" },
                { label: "Projekte", href: "#projekte" },
                { label: "Küche" },
              ]}
            />
          }
          end={<Crowded />}
        />
        {/* a long lead title beside a path, and an end that never folds (the bar's fold folds the end first, so only
            such an end leaves the shortage to the start): the title gives way first, down to its floor */}
        <Bar
          start={
            <>
              <Text type="lead">Angebot für den Einbauschrank im Flur der Familie Oswald mit Schiebetüren und Beleuchtung</Text>
              <Path label="Ort neben Titel" items={deep} />
            </>
          }
          end={<Button variant="primary">Neu</Button>}
        />
      </Pane>
    </Workspace>
  );
}
