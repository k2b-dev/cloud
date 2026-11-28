import { render } from "solid-js/web";
import { Facts, Pane, Section, Workspace } from "../src/v2";

// Facts as the key-value detail: contact data with kinds in the main column, bank data in a side
// column, and the worst case in the same places (a label of six words, an address that cannot break, six lines of an
// address, a web address with a query and one with a scheme that may not open, nothing set, a long note).

declare global {
  interface Window {
    __k2Mounted?: boolean;
  }
}

// `?loading` renders the same facts while their values are on their way
const loading = new URLSearchParams(location.search).has("loading") || document.body.dataset.loading !== undefined;

const root = document.getElementById("root");
if (!root) throw new Error("facts: #root is missing");
render(
  () => (
    <Workspace>
      <Pane.Split>
        <Pane label="Angaben">
          <Section title="Kontakt">
            <Facts
              loading={loading}
              items={[
                { label: "E-Mail", kind: "email", value: "o.brandner@example.org" },
                {
                  label: "Telefon",
                  kind: "phone",
                  value: [
                    { value: "+49 30 5550 142", note: "mobil" },
                    { value: "+49 30 5550 990", note: "Büro" },
                  ],
                },
                { label: "Anschrift", kind: "address", value: ["Am Beispielhang 12", "12345 Beispielstadt"] },
                { label: "Website", kind: "url", value: "https://www.beispiel-verwaltung.example.org/kunden/portal/rechnungen?jahr=2026" },
                { label: "Skript", kind: "url", value: "javascript:alert(1)" },
                { label: "Port", kind: "url", value: "example.org:8080/status" },
                { label: "Kopie", kind: "email", value: "anna@example.org?bcc=mallory@example.org" },
                { label: "Zentrale", kind: "phone", value: "+49 (0) 30 1234567" },
                { label: "Leerzeichen", kind: "phone", value: " +49 30 555" },
                { label: "Durchwahl", kind: "phone", value: "+49 30 5550 ext. 12" },
                { label: "Dw", kind: "phone", value: "+49 30 5550 Dw. 12" },
                { label: "Strichpunkt-Durchwahl", kind: "phone", value: "+49 30 5550;ext=12" },
                { label: "Komma-Durchwahl", kind: "phone", value: "+49 30 5550,12" },
                { label: "Zwei Nummern", kind: "phone", value: "+49 30 5550 oder 0151 222" },
                { label: "Vorwort", kind: "phone", value: "Tel: +49 30 5550" },
                { label: "Striche", kind: "phone", value: "+49-(0)-30-5550" },
                { label: "Buchstaben", kind: "phone", value: "+1 800 FLOWERS" },
                { label: "Telefax", kind: "phone", value: "+49 30 5551" },
                { label: "Schrägstrich", kind: "phone", value: "030 / 5550 142" },
                { label: "Zwei mit Strich", kind: "phone", value: "+49 30 5550 / 0151 222" },
                { label: "Zwei Zeilen", kind: "phone", value: "+49 30 5550\n0151 222" },
                { label: "Unsichtbar", kind: "email", value: "anna\u200b@example.org" },
                { label: "Mit Rand", kind: "email", value: " anna@example.org " },
                { label: "Komma", kind: "email", value: "anna@example.org,mallory@example.org" },
                { label: "Strichpunkt", kind: "email", value: "anna@example.org;mallory@example.org" },
                { label: "Prozent", kind: "email", value: "anna%2Cmallory@example.org" },
                { label: "Zeilenumbruch", kind: "email", value: "anna@example.org%0D%0Abcc:mallory@example.org" },
                { label: "Steuer-ID", value: undefined },
                { label: "Fax", kind: "phone", value: "" },
                {
                  label: "Abweichende Rechnungsanschrift für Sammelrechnungen",
                  kind: "email",
                  value: "kaori.wolkenstein-ueberlingen-fuerstenberg.rechnungen@sehr-lange-subdomain.beispiel-verwaltung.example.org",
                },
                {
                  label: "Notiz",
                  kind: "note",
                  value: "Ruft am liebsten nachmittags an. Ihr Sohn Corvin holt ab, er ist als Bote hinterlegt. Bitte keine Briefe.",
                },
              ]}
            />
          </Section>
        </Pane>
        <Pane side label="Bank" width={{ min: 300, default: 340 }}>
          <Section title="Bank">
            <Facts
              items={[
                { label: "Inhaberin", value: "Ottilie Brandner" },
                { label: "BIC", value: "INGDDEFFXXX", mono: true, copy: "INGDDEFFXXX" },
                { label: "Gläubiger-ID", value: null },
              ]}
            />
          </Section>
        </Pane>
      </Pane.Split>
    </Workspace>
  ),
  root,
);
window.__k2Mounted = true;
