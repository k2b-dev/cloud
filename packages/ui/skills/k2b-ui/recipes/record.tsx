// Recipe: a record (customer file), first tab. RecordHead in the head bar, the record's areas as tabs over the pane,
// the main column beside a side column with the details. What needs a person comes first ("Anstehend").
import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  Empty,
  Facts,
  Failed,
  Loading,
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

// `empty`: a customer created today, with nothing yet; `loading` and `failed`: the history that loads on its own.
type Props = { empty?: boolean; loading?: boolean; failed?: boolean };

export default function CustomerOverview(props: Props) {
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
              { label: "Einlieferungen", icon: "package", count: props.empty ? undefined : 4, href: "#einlieferungen" },
              { label: "Geld", icon: "currency-euro", count: props.empty ? undefined : 12, href: "#geld" },
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
            value={props.empty ? "0,00 €" : <Chip amount="out">532,30 €</Chip>}
            meta={props.empty ? "nichts offen" : "1 Rechnung offen"}
            href="#geld"
          />
          <Cells.Cell
            icon="package"
            color={area.deliveries}
            label="Einlieferungen"
            value={props.empty ? "keine" : "2 laufen"}
            meta={props.empty ? undefined : "Abrechnung am 15. Dez."}
            href="#einlieferungen"
          />
          <Cells.Cell icon="file-text" label="Vertrag" value={<Chip status="ok">Gültig</Chip>} meta="bis 31. Dez. 2027" />
        </Cells>
        <Pane.Split>
          <Pane label="Überblick">
            <Section
              icon="checklist"
              color={area.todo}
              title="Anstehend"
              count={props.empty ? undefined : 2}
              actions={[{ label: "Todo anlegen", icon: "plus" }]}
            >
              {props.empty ? (
                <Empty icon="checks" text="Für diesen Kunden steht nichts an." />
              ) : (
                <>
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
                </>
              )}
            </Section>
            {/* The history loads on its own: its states stand in this section, the rest of the record stays. */}
            <Section
              icon="list-details"
              color={area.deliveries}
              title="Vorgänge"
              more={props.empty || props.failed ? undefined : { label: "Alle Einlieferungen", forward: true }}
            >
              {props.failed ? (
                <Failed
                  text="Die Vorgänge konnten nicht geladen werden. Die übrige Akte bleibt, wie sie ist."
                  onRetry={() => location.reload()}
                />
              ) : props.loading ? (
                <Loading rows={2} lines={2} />
              ) : props.empty ? (
                <Empty icon="package" text="Noch keine Einlieferung." action={{ label: "Einlieferung erfassen", icon: "plus" }} />
              ) : (
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
              )}
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

// The states that Fibel's Example offers beside the default; the recipe test renders each one as well.
export const states = {
  empty: () => <CustomerOverview empty />,
  loading: () => <CustomerOverview loading />,
  failed: () => <CustomerOverview failed />,
};
