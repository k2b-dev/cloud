import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { PublicDocumentShare } from "./documents/[token]/PublicDocumentShare";
import { PublicFormScreen, PublicFormUnavailable } from "./forms/[token]/PublicFormScreen";

/**
 * The public document share and the public form for a browser test, inside the v2 scope MinimalLayout gives them
 * (`main.k2-ui`). The data is invented; `?worst` asks for long and unbreakable names.
 */
const host = document.getElementById("root");
if (!host) throw new Error("Missing harness root");
const worst = new URLSearchParams(location.search).has("worst");
const field = (id: string, name: string, type: string, position: number, config: Record<string, unknown> = {}) => ({
  id,
  tableId: "TABLE1",
  name,
  type,
  config,
  required: position === 0,
  description: position === 1 ? "Wann soll das Gerät abgeholt werden?" : null,
  deletedAt: null,
  createdAt: "2026-09-14T12:00:00Z",
  updatedAt: "2026-09-14T12:00:00Z",
  position,
  presentable: position === 0,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
});
const fields = [
  field("F1", worst ? "Name-der-anfragenden-Person-oder-Abteilung-mit-Kostenstelle" : "Name", "text", 0),
  field("F2", "Abholung", "date", 1),
  field("F3", "Anzahl", "number", 2),
  field("F4", "Notiz", "longtext", 3),
];

render(
  () => (
    <LocaleProvider locale="de">
      <main class="k2-ui minimal-layout-main">
        {location.pathname.includes("/documents/gone") ? (
          <PublicDocumentShare />
        ) : location.pathname.includes("/documents/") ? (
          <PublicDocumentShare
            filename={
              worst ? "Rechnung-2026-11-0042-Werkstatt-Nordhausen-Ersatzteile-Druckluftanlage-final-v3.pdf" : "Rechnung-2026-0042.pdf"
            }
            mimeType="application/pdf"
            expiresAt="2026-12-02T18:00:00.000Z"
            expiresAtLabel="2. Dezember 2026 um 19:00"
            downloadHref="/share/grids/documents/gdl_test/download"
          />
        ) : location.pathname.includes("/forms/gone") ? (
          <PublicFormUnavailable title="Formular nicht gefunden" text="Dieses Formular ist nicht mehr verfügbar." />
        ) : (
          <PublicFormScreen
            publicToken="frm_test"
            form={{
              id: "FORM01",
              name: "Geräteausleihe",
              config: {
                title: worst ? "Ausleihe-von-Messgeräten-und-Werkzeugen-für-Außeneinsätze-der-Werkstatt-Nord" : "Geräteausleihe",
                description: "Wir melden uns innerhalb eines Werktags.",
                fields: fields.map((each) => ({ kind: "user_input" as const, fieldId: each.id })),
              },
            }}
            fields={fields}
          />
        )}
      </main>
    </LocaleProvider>
  ),
  host,
);
