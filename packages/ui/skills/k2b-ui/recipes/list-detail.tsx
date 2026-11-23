// Recipe: list with detail. A sidebar, a head with views and the main action, a list beside the open entry.
// On the phone the detail pane leaves; open the entry as its own page (its own route) there.
import { Bar, Button, Chip, Facts, List, Nav, Notice, Pane, Row, Section, StatusRow, Tabs, Text, Workspace } from "@k2b/ui/v2";

type Source = { id: string; name: string; kind: string; seen: string; state: "ok" | "warn" | "bad" };

const sources: Source[] = [
  { id: "s1", name: "Lackfabrik Nordhaus", kind: "Webhook", seen: "09:42", state: "ok" },
  { id: "s2", name: "Holzwerk Brandt", kind: "Abruf alle 5 min", seen: "gestern", state: "bad" },
  { id: "s3", name: "Spedition Kraus", kind: "Webhook", seen: "08:10", state: "ok" },
];
const stateLabel = { ok: "Aktiv", warn: "Wartet", bad: "Gestört" } as const;
const open = sources[1]!;

export default function SourcesScreen() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Pulse"
          icon="activity"
          groups={[
            {
              items: [
                { label: "Quellen", icon: "plug", current: true, count: sources.length },
                { label: "Ereignisse", icon: "list" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <Tabs
              label="Ansichten"
              items={[
                { label: "Alle", count: 3, current: true },
                { label: "Gestört", count: 1 },
              ]}
            />
          }
          end={
            <Button variant="primary" icon="plus">
              Neue Quelle
            </Button>
          }
        />
      }
      primary={{ label: "Neue Quelle", icon: "plus" }}
    >
      <Pane.Split>
        <Pane
          label="Quellen"
          width={{ min: 320, default: 400 }}
          status={<StatusRow lead="3 Quellen" facts={[{ value: 1, after: "gestört" }]} />}
        >
          <List label="Quellen">
            {sources.map((source) => (
              <Row
                icon="plug"
                lines={[source.name, source.kind]}
                time={source.seen}
                selected={source.id === open.id}
                href={`#${source.id}`}
              />
            ))}
          </List>
        </Pane>
        <Pane
          detail
          label={open.name}
          head={
            <Bar
              start={<Text type="lead">{open.name}</Text>}
              end={
                <>
                  <Button icon="pencil">Bearbeiten</Button>
                  <Button variant="ghost" icon="x" label="Schließen" href="#" />
                </>
              }
            />
          }
        >
          <Notice tone="bad" title="Antwortet nicht" actions={[{ label: "Erneut prüfen", icon: "refresh" }]}>
            Seit gestern, 17:20 kommen keine Ereignisse an. Prüfe die Adresse oder den Schlüssel.
          </Notice>
          <Section icon="settings" title="Angaben">
            <Facts
              items={[
                { label: "Art", value: open.kind },
                { label: "Zustand", value: <Chip status={open.state}>{stateLabel[open.state]}</Chip> },
                { label: "Schlüssel", value: "pk_7f3a…c21", copy: "pk_7f3a9be0c21" },
              ]}
            />
          </Section>
          <Section icon="list" title="Letzte Ereignisse" count={2} more={{ label: "Alle Ereignisse", forward: true }}>
            <Row icon="alert-circle" lines={["Zeitüberschreitung", "nach 30 s"]} time="gestern" />
            <Row icon="check" lines={["38 Ereignisse angenommen"]} time="Mo." />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  );
}
