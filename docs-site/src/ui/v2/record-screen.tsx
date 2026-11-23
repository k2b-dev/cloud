import {
  Bar,
  Button,
  Canvas,
  Cells,
  Chip,
  Digest,
  Facts,
  Field,
  Group,
  Icon,
  Input,
  Nav,
  Notice,
  Pane,
  Progress,
  RecordHead,
  Row,
  Section,
  Steps,
  Table,
  Tabs,
  Text,
  Workspace,
} from "@k2b/ui/v2";
import type { JSX } from "solid-js";
import { MapDrawing } from "./drawings";

// The customer record of Warenfluss, overview, as in the approved mockup (akte.html, with Valentin's comments of
// 22.11.). Only primitives and layer-2 components of @k2b/ui/v2: no class, no style, no CSS of its own.

const deliveries = "#c2410c";

/** The record around its tabs: sidebar, identity in the head, the tabs as the head of the record's pane. */
const RecordFrame = (props: { tab: "overview" | "deliveries"; children: JSX.Element }) => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    primary={{ label: "Neu", icon: "plus" }}
    sidebar={
      <Nav
        title="Kunden"
        icon="users"
        groups={[
          {
            items: [
              { label: "Kunde anlegen", icon: "user-plus" },
              { label: "Kunden", icon: "users", current: true },
              { label: "Favoriten", icon: "star" },
              { label: "Posteingang", icon: "inbox", count: 2 },
              { label: "Todos", icon: "checkbox" },
              { label: "Empfangs-iPads", icon: "device-tablet" },
            ],
          },
        ]}
        foot={[{ label: "Alle Anrufe", icon: "phone" }]}
      />
    }
    head={
      <Bar
        start={
          <RecordHead
            name="Ottilie Brandner"
            avatar={{ name: "Ottilie Brandner", color: "#1d4ed8" }}
            kinds={["Einlieferung", "Privat"]}
            ids={[
              { label: "Kunde", value: "7K4QX", copy: true },
              { icon: "phone", value: "+49 30 5550 142" },
            ]}
          />
        }
        end={
          <>
            <Button variant="ghost" icon="search" label="In der Akte suchen" />
            <Button variant="ghost" icon="star" label="Favorit" />
            <Button variant="ghost" icon="dots" label="Weitere Aktionen" />
            <Button variant="primary" icon="plus" menu>
              Neu
            </Button>
            <Button variant="ghost" icon="x" label="Schließen" />
          </>
        }
      />
    }
  >
    <Pane
      label="Akte"
      head={
        <Tabs
          label="Bereiche der Akte"
          items={[
            { label: "Überblick", icon: "layout-grid", current: props.tab === "overview", href: "/en/ui/v2/screen/record" },
            { label: "Geld", icon: "currency-euro", count: 12 },
            {
              label: "Einlieferungen",
              icon: "package",
              count: 4,
              current: props.tab === "deliveries",
              href: "/en/ui/v2/screen/deliveries",
            },
            { label: "Verträge und Quittungen", icon: "file-text", count: 6 },
            { label: "Kontakt", icon: "messages", count: 14 },
            { label: "Angaben", icon: "id" },
            { label: "Verlauf", icon: "history" },
          ]}
        />
      }
    >
      {props.children}
    </Pane>
  </Workspace>
);

export const RecordScreen = () => (
  <RecordFrame tab="overview">
    <Notice
      tone="note"
      icon="pin"
      title="Notiz"
      meta="angeheftet · Jule Amsel · 12. Nov. 2026"
      actions={[
        { label: "Ändern", icon: "pencil" },
        { label: "Alle 3 Notizen", forward: true },
      ]}
    >
      Ruft am liebsten nachmittags an. Ihr Sohn Corvin Maibach holt ab, er ist als Bote hinterlegt. Bitte keine Briefe, sie liest alles im
      Portal.
    </Notice>
    <Cells>
      <Cells.Cell
        icon="currency-euro"
        color="#8e1b6f"
        label="Geld · wir zahlen heute"
        href="#geld"
        value={<Chip amount="out">532,30 €</Chip>}
        meta="alle 4 offenen Belege zusammen · 1 überfällig seit 15. Okt."
      />
      <Cells.Cell
        icon="package"
        color={deliveries}
        label="Einlieferungen"
        href="#einlieferungen"
        value="8 Artikel laufen bis morgen"
        meta="Nächste Abrechnung am 15. Dez. · 38 von 53 verkauft"
      />
      <Cells.Cell
        icon="file-text"
        color="#7c3aed"
        label="Vertrag"
        href="#vertrag"
        value={
          <>
            <Icon name="check" tone="ok" /> Gültig
          </>
        }
        meta="Einlieferungsvertrag VT-2610-00031 · Standard"
      />
    </Cells>
    <Pane.Split>
      <Pane label="Überblick">
        <Section icon="checklist" color="#2563eb" title="Anstehend" count={2} actions={[{ label: "Todo anlegen", icon: "plus" }]}>
          <Row
            yours
            strong
            icon="signature"
            lines={["Quittung wartet auf Unterschrift", "Q-2611-00021 · Einlieferung EL-2611-00021 · seit 18. Nov."]}
            action={{ label: "Zur Quittung" }}
          />
          <Row
            strong
            icon="packages"
            lines={["3 nicht verkaufte Artikel sind abholbereit", "aus EL-2609-00017 · bis 12. Dez. 2026"]}
            action={{ label: "Herausgabe vorbereiten" }}
          />
        </Section>
        <Section icon="list-details" color={deliveries} title="Vorgänge" more={{ label: "Alle Einlieferungen", forward: true }}>
          <Digest
            label="Vorgänge"
            items={[
              {
                icon: "package",
                color: deliveries,
                date: "17. Nov.",
                title: "EL-2611-00021",
                state: { icon: "signature", label: "Quittung offen" },
                text: "Angekommen am 17. Nov. per Post. Noch nichts eingestellt.",
              },
              {
                icon: "package",
                color: deliveries,
                date: "3. Nov.",
                title: "EL-2611-00009",
                state: { icon: "gavel", label: "Läuft" },
                text: (
                  <>
                    8 Artikel laufen, die Auktion endet <Text weight="strong">morgen</Text>. 10 sind am 15. Nov. ausgelaufen: Abrechnung am{" "}
                    <Text weight="strong">15. Dez.</Text>, ca. 180,00 €.
                  </>
                ),
              },
              {
                icon: "package",
                color: deliveries,
                date: "6. Okt.",
                title: "EL-2610-00004",
                state: { icon: "file-dollar", label: "Teilweise abgerechnet" },
                text: (
                  <>
                    Abgerechnet am 17. Nov. Aus dieser Einlieferung zahlen wir <Text tone="ai">512,30 €</Text>, fällig ab{" "}
                    <Text weight="strong">heute</Text>. 2 Artikel sind wieder eingestellt.
                  </>
                ),
              },
              {
                icon: "package",
                color: deliveries,
                date: "9. Sept.",
                title: "EL-2609-00017",
                state: { icon: "circle-check", label: "Ausgezahlt", tone: "ok" },
                text: (
                  <>
                    Fertig: <Text weight="strong">1.028,30 €</Text> ausgezahlt, zuletzt am 12. Nov.
                  </>
                ),
              },
            ]}
          />
        </Section>
        <Section icon="messages" color="#0f766e" title="Kontaktverlauf" count={14}>
          <Field.Row>
            <Input icon="phone" placeholder="Was wurde besprochen?" label="Was wurde besprochen?" />
          </Field.Row>
          <Digest label="Kontaktverlauf">
            <Row
              strong
              icon="phone"
              lines={["Rückruf wegen Abholung", "Corvin holt die drei Artikel am Freitag ab."]}
              meta="Jule Amsel · 18. Nov."
            />
          </Digest>
        </Section>
      </Pane>
      <Pane side label="Breite der Angaben" width={{ min: 280, default: 360 }}>
        <Canvas label="Lage: Am Beispielhang 12, 12345 Beispielstadt" height={176}>
          <MapDrawing address="Am Beispielhang 12, 12345 Beispielstadt" />
        </Canvas>
        <Section
          icon="phone"
          title="Kontakt"
          actions={[{ label: "Ändern", icon: "pencil" }]}
          more={{ label: "Alle Angaben", meta: "Bank, Person, Ausweis, Boten, Portal" }}
        >
          <Facts
            items={[
              { label: "Telefon", value: "+49 30 5550 142", hint: "Standard", copy: "+49 30 5550 142" },
              { label: "E-Mail", value: "o.brandner@example.test", hint: "Standard", copy: "o.brandner@example.test" },
              {
                label: "Anschrift",
                value: (
                  <>
                    Am Beispielhang 12
                    <br />
                    12345 Beispielstadt
                  </>
                ),
                hint: "Standard",
                copy: "Am Beispielhang 12, 12345 Beispielstadt",
              },
              { label: "Sprache", value: "Deutsch" },
            ]}
          />
        </Section>
      </Pane>
    </Pane.Split>
  </RecordFrame>
);

// The tab "Einlieferungen" (akte-einlieferungen.html): every delivery in its own framed group, the latest two open.
export const DeliveriesScreen = () => (
  <RecordFrame tab="deliveries">
    <Section
      icon="package"
      color={deliveries}
      title="Einlieferungen"
      count={4}
      actions={[
        { label: "Herausgabe erfassen", icon: "packages" },
        { label: "Einlieferung erfassen", icon: "plus" },
      ]}
      summary={
        <>
          <Text weight="strong">8 Artikel</Text> laufen bis morgen. <Text weight="strong">38</Text> von 53 Artikeln sind verkauft. Nächste
          Abrechnung am <Text weight="strong">15. Dez.</Text>
        </>
      }
    >
      <Group
        icon="package"
        title="EL-2611-00021"
        meta="angekommen am 17. Nov. 2026 · per Post · 2 Pakete"
        state={
          <Text weight="medium">
            <Icon name="signature" /> Quittung offen
          </Text>
        }
        menu={{ label: "Weitere Aktionen" }}
        actions={[{ label: "Zur Einlieferung", forward: true }]}
      >
        <Text type="body" weight="strong">
          Angekommen am 17. Nov. Die Quittung wartet auf Unterschrift, noch ist nichts eingestellt.
        </Text>
        <Steps
          label="Weg der Einlieferung"
          items={[
            { label: "Angekommen", meta: "17. Nov.", state: "done" },
            { label: "Eingestellt", meta: "noch nichts", state: "now" },
            { label: "Ausgelaufen", state: "next" },
            { label: "Abgerechnet", state: "next" },
            { label: "Ausgezahlt", state: "next" },
          ]}
        />
        <Row
          icon="signature"
          strong
          lines={[
            <>
              Quittung <Text href="#quittung">Q-2611-00021</Text> wartet auf Unterschrift
            </>,
            "per Post gesendet am 18. Nov.",
          ]}
          end={
            <Button variant="text" forward>
              Zur Quittung
            </Button>
          }
        />
      </Group>
      <Group
        icon="package"
        title="EL-2611-00009"
        meta="angekommen am 3. Nov. 2026 · Abholung · 18 Artikel"
        state={
          <Text weight="medium">
            <Icon name="gavel" /> Läuft
          </Text>
        }
        menu={{ label: "Weitere Aktionen" }}
        actions={[{ label: "Zur Einlieferung", forward: true }]}
      >
        <Text type="body" weight="strong">
          10 Artikel sind ausgelaufen, 8 laufen bis morgen. Die erste Abrechnung kommt am 15. Dez.
        </Text>
        <Steps
          label="Weg der Einlieferung"
          items={[
            { label: "Angekommen", meta: "3. Nov.", state: "done" },
            { label: "Eingestellt", meta: "18 von 18 · seit 8. Nov.", state: "done" },
            { label: "Ausgelaufen", meta: "10 von 18 · letzter Tag morgen", state: "now" },
            { label: "Abgerechnet", meta: "15. Dez. und 22. Dez.", state: "next" },
            { label: "Ausgezahlt", meta: "nach der Abrechnung", state: "next" },
          ]}
        />
        <Table
          label="Auslauftage"
          rows={[
            {
              day: "So., 15. Nov.",
              items: "10 Artikel · 8 verkauft, 2 nicht verkauft",
              when: "Abrechnung am 15. Dez.",
              progress: <Progress value={5} of={22} label="Arbeitstag 5 von 22" />,
              amount: (
                <Text weight="medium" tone="ai">
                  ca. 180,00 €
                </Text>
              ),
              note: "voraussichtlich",
            },
            {
              day: "So., 22. Nov.",
              items: "8 Artikel laufen · endet morgen",
              when: "Abrechnung am 22. Dez.",
              progress: "Information bis Mo., 23. Nov.",
              amount: undefined,
              note: "steht nach der Auktion fest",
            },
          ]}
          columns={[
            { title: "Auslauftag", cell: (row) => [<Text weight="strong">{row.day}</Text>, row.items] },
            { title: "Abrechnung", cell: (row) => [<Text weight="strong">{row.when}</Text>, row.progress] },
            { title: "Auszahlung", align: "end", cell: (row) => (row.amount ? [row.amount, row.note] : ["", row.note]) },
          ]}
        />
        <Row
          icon="arrow-back-up"
          strong
          lines={["2 Artikel liegen bei uns und gehen zurück", "nicht verkauft am 15. Nov."]}
          end={
            <Button variant="text" forward>
              Zu den Retouren
            </Button>
          }
        />
        <Facts
          inline
          items={[
            { label: "Quittung", value: <Text href="#quittung">Q-2611-00009</Text> },
            { label: "Vertrag", value: <Text href="#vertrag">VT-2610-00031</Text> },
          ]}
          end={<Button variant="ghost" icon="printer" label="Drucken" />}
        />
      </Group>
      <Group
        icon="package"
        title="EL-2610-00004"
        meta="angekommen am 6. Okt. 2026 · 12 Artikel · abgerechnet am 17. Nov."
        folded
        state={
          <>
            <Text weight="medium">
              <Icon name="file-dollar" /> Teilweise abgerechnet
            </Text>
            <Text weight="medium" tone="ai">
              512,30 €
            </Text>
          </>
        }
      />
      <Group
        icon="package"
        title="EL-2609-00017"
        meta="angekommen am 9. Sept. 2026 · 23 Artikel · ausgezahlt am 12. Nov."
        folded
        state={
          <>
            <Text weight="medium" tone="ok">
              <Icon name="circle-check" /> Ausgezahlt
            </Text>
            <Text weight="medium">1.028,30 €</Text>
          </>
        }
      />
    </Section>
  </RecordFrame>
);
