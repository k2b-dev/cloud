import { Bar, Button, Pane, Path, Workspace } from "../src/v2";

// Paths that do not fit (Spaces, W3: "Space settin…" was cut before the long Space name): a deep path in the head
// beside its actions, and in the pane a long Space name before the settings, the same deep path, and a short deep path
// that fits. The names are invented.

const space = "Werkstatt Lindqvist-Oswald und Partner – Innenausbau, Möbelbau, Treppen, Fenster und Türen aus eigener Fertigung";
const deep = [
  { label: "Spaces", href: "#spaces" },
  { label: space, href: "#space" },
  { label: "Projekte", href: "#projekte" },
  { label: "Küche Familie Oswald", href: "#kueche" },
  { label: "Space-Einstellungen" },
];

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
      </Pane>
    </Workspace>
  );
}
