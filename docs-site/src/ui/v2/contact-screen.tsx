import { Bar, Facts, Nav, Pane, RecordHead, Section, Workspace } from "@k2b/ui/v2";

// A person's details as label and value: contact data in the main column, roomy with a hair between
// the pairs; bank data in the side column, dense. Every value says its kind, so `Facts` makes its link and its copy
// button. The worst case puts long labels, an address that cannot break, six lines of an address, a web address with a
// query, empty values and a long note into the same places.

const KundenNav = () => (
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
        ],
      },
    ]}
  />
);

export const ContactScreen = (props: { worst?: boolean }) => (
  <Workspace
    sidebarLabel="Breite der Seitenleiste"
    sidebar={<KundenNav />}
    head={
      <Bar
        start={
          <RecordHead
            name={props.worst ? "Kaori Wolkenstein-Überlingen-Fürstenberg" : "Ottilie Brandner"}
            avatar={{ name: props.worst ? "Kaori Wolkenstein" : "Ottilie Brandner" }}
          />
        }
      />
    }
  >
    <Pane.Split>
      <Pane label="Angaben">
        <Section title="Kontakt" actions={[{ label: "Ändern", icon: "pencil" }]}>
          <Facts
            items={
              props.worst
                ? [
                    {
                      label: "E-Mail",
                      kind: "email",
                      value: "kaori.wolkenstein-ueberlingen-fuerstenberg.rechnungen@sehr-lange-subdomain.beispiel-verwaltung.example.org",
                    },
                    {
                      label: "Abweichende Rechnungsanschrift für Sammelrechnungen",
                      kind: "address",
                      value: [
                        "Verwaltungsgemeinschaft Oberes Tal",
                        "z. Hd. Buchhaltung, Raum 4.17",
                        "Hauptstraße 1–3, Hinterhaus",
                        "Postfach 12 34 56",
                        "78901 Fürstenberg-Überlingen",
                        "Deutschland",
                      ],
                    },
                    {
                      label: "Website",
                      kind: "url",
                      value: "https://www.beispiel-verwaltung.example.org/kunden/portal/rechnungen?jahr=2026&sortierung=faellig",
                    },
                    { label: "Telefon", kind: "phone", value: "" },
                    { label: "X", value: "Ein Schlüssel aus einem Zeichen 🦊" },
                    {
                      label: "Notiz",
                      kind: "note",
                      value:
                        "Sehr lange Notiz ohne Absatz, die über viele Zeilen läuft und trotzdem lesbar bleibt, weil sie die Messbreite hält und links eine ruhige Linie hat, statt als grauer Block die ganze Breite der Seite zu füllen. Ruft nie vor zehn an.",
                    },
                  ]
                : [
                    { label: "E-Mail", kind: "email", value: "o.brandner@example.org" },
                    {
                      label: "Telefon",
                      kind: "phone",
                      value: [
                        { value: "+49 30 5550 142", note: "mobil" },
                        { value: "+49 30 5550 990", note: "Büro" },
                      ],
                    },
                    { label: "Anschrift", kind: "address", value: ["Am Beispielhang 12", "12345 Beispielstadt", "Deutschland"] },
                    { label: "Website", kind: "url", value: "https://brandner-antik.example.org/ueber-uns" },
                    { label: "Kundennr.", value: "7K4QX", mono: true, copy: "7K4QX" },
                    { label: "Steuer-ID", value: undefined },
                    {
                      label: "Notiz",
                      kind: "note",
                      value:
                        "Ruft am liebsten nachmittags an. Ihr Sohn Corvin holt ab, er ist als Bote hinterlegt. Bitte keine Briefe, sie liest alles im Portal.",
                    },
                  ]
            }
          />
        </Section>
      </Pane>
      <Pane side label="Bank" width={{ min: 300, default: 340 }}>
        <Section title="Bank">
          <Facts
            items={[
              { label: "Inhaberin", value: props.worst ? "Kaori Wolkenstein-Überlingen-Fürstenberg" : "Ottilie Brandner" },
              { label: "IBAN", value: "DE12 5001 0517 0648 4898 90", mono: true, copy: "DE12500105170648489890" },
              { label: "BIC", value: "INGDDEFFXXX", mono: true, copy: "INGDDEFFXXX" },
              { label: "Mandat", value: "SEPA, seit 03.2021", hint: "gültig" },
              { label: "Gläubiger-ID", value: null },
            ]}
          />
        </Section>
      </Pane>
    </Pane.Split>
  </Workspace>
);
