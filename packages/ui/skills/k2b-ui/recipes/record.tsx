// Recipe: a record (customer file), first tab. RecordHead in the head bar, the record's areas as tabs over the pane,
// the main column beside a side column with the details. What needs a person comes first ("Anstehend").
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  Facts,
  Nav,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";

const area = { money: "#8e1b6f", deliveries: "#c2410c", todo: "#2563eb" };

export default function CustomerOverview() {
  return (
    <Workspace
      sidebar={
        <Nav
          title="Kunden"
          icon="users"
          groups={[
            {
              items: [
                { label: "Alle Kunden", icon: "users", current: true, count: 412 },
                { label: "Zuletzt", icon: "clock" },
              ],
            },
          ]}
        />
      }
      head={
        <Bar
          start={
            <RecordHead
              name="Ottilie Brandner"
              avatar={{ name: "Ottilie Brandner", color: "#1d4ed8" }}
              kinds={["Privat"]}
              ids={[{ label: "Kunde", value: "7K4QX", copy: true }]}
            />
          }
          end={
            <Button variant="primary" icon="plus" menu>
              Neu
            </Button>
          }
        />
      }
      primary={{ label: "Neu", icon: "plus" }}
    >
      <Pane
        label="Kundenakte"
        head={
          <Tabs
            label="Bereiche"
            items={[
              { label: "Überblick", icon: "layout-grid", current: true },
              { label: "Einlieferungen", icon: "package", count: 4, href: "#einlieferungen" },
              { label: "Geld", icon: "currency-euro", count: 12, href: "#geld" },
            ]}
          />
        }
      >
        {/* Note and key statements span both columns; the split below holds the main and the side column. */}
        <Notice tone="note" icon="pin" title="Notiz" meta="Ada Renz, 12. Nov." actions={[{ label: "Bearbeiten" }]}>
          Ruft lieber an, als Mails zu schreiben. Abholung nur samstags.
        </Notice>
        <Cells>
          <Cells.Cell
            icon="currency-euro"
            color={area.money}
            label="Geld heute"
            value={<Chip amount="out">532,30 €</Chip>}
            meta="1 Rechnung offen"
            href="#geld"
          />
          <Cells.Cell
            icon="package"
            color={area.deliveries}
            label="Einlieferungen"
            value="2 laufen"
            meta="Abrechnung am 15. Dez."
            href="#einlieferungen"
          />
          <Cells.Cell icon="file-text" label="Vertrag" value={<Chip status="ok">Gültig</Chip>} meta="bis 31. Dez. 2027" />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section icon="checklist" color={area.todo} title="Anstehend" count={2} actions={[{ label: "Todo anlegen", icon: "plus" }]}>
              <Row
                yours
                strong
                icon="signature"
                lines={["Quittung wartet auf Unterschrift", "Q-2611-00021 · seit 18. Nov."]}
                action={{ label: "Zur Quittung" }}
              />
              <Row
                strong
                icon="packages"
                lines={["3 Artikel sind abholbereit", "bis 12. Dez."]}
                action={{ label: "Herausgabe vorbereiten" }}
              />
            </Section>
            <Section icon="list-details" color={area.deliveries} title="Vorgänge" more={{ label: "Alle Einlieferungen", forward: true }}>
              <Digest
                items={[
                  {
                    icon: "package",
                    color: area.deliveries,
                    date: "3. Nov.",
                    title: "EL-2611-00009",
                    state: { icon: "gavel", label: "Läuft" },
                    text: (
                      <>
                        8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>.
                      </>
                    ),
                  },
                  {
                    icon: "package",
                    color: area.deliveries,
                    date: "14. Okt.",
                    title: "EL-2610-00031",
                    state: { icon: "check", label: "Abgerechnet", tone: "ok" },
                    text: "Ausgezahlt am 15. Nov.",
                  },
                ]}
              />
            </Section>
          </Pane>
          <Pane side label="Angaben" width={{ min: 280, default: 360 }}>
            <Canvas label="Karte mit der Adresse" height={176}>
              <span />
            </Canvas>
            <Section
              icon="phone"
              title="Kontakt"
              actions={[{ label: "Ändern", icon: "pencil" }]}
              more={{ label: "Alle Angaben", meta: "Bank, Person" }}
            >
              <Facts
                items={[
                  { label: "Telefon", value: "+49 30 5550 142", hint: "Standard", copy: "+49 30 5550 142" },
                  { label: "E-Mail", value: "o.brandner@example.de", copy: "o.brandner@example.de" },
                  { label: "Sprache", value: "Deutsch" },
                ]}
              />
            </Section>
          </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}
