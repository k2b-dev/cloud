import { i18n } from "@k2b/stdlib";
import type { CustomAppDiagnostic } from "./contracts";

type DiagnosticParams = Readonly<Record<string, string | number>>;

const value = (params: DiagnosticParams, key: string) => String(params[key] ?? "");

const customAppDiagnosticMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      diagnostic: ({ code, params }: { code: string; params: DiagnosticParams }) => {
        const v = (key: string) => value(params, key);
        return (
          (
            {
              "schema.invalid": v("detail") || "The Grids App definition contains an invalid value.",
              "base.missing": "Base not found.",
              "resource.missing": `${v("kind")} not found.`,
              "limit.records.total": "A Grids App may contain at most 24 Records blocks.",
              "limit.records.page": "A Grids App page may contain at most 4 Records blocks.",
              "limit.forms": "A Grids App may contain at most 24 Form blocks.",
              "limit.insights": "A Grids App may contain at most 24 Metrics and Chart blocks.",
              "limit.scanners": "A Grids App may contain at most 24 Scanner blocks.",
              "limit.availability": "A Grids App may contain at most 256 availability queries.",
              "query.invalid": v("detail") || "The GQL query is invalid.",
              "query.table_limit.availability": "An availability query may reference at most 24 tables.",
              "record_parameter.table_invalid": "The record parameter table is missing or belongs to another Base.",
              "record_page.table_invalid": "The record page table is missing or belongs to another Base.",
              "field.missing": `Field ${v("fieldId")} is missing or belongs to another table.`,
              "field.not_writable": `Field ${v("fieldId")} is not a writable record field.`,
              "html_field.type": `Field ${v("fieldId")} is not an HTML template field.`,
              "html_field.missing": `HTML template field ${v("fieldId")} is missing or belongs to another table.`,
              "relation_target.table_invalid": `Relation target table ${v("tableId")} is missing or belongs to another Base.`,
              "document_template.invalid": `Document template ${v("templateId")} is missing or belongs to another table.`,
              "referenced_records.record_page_required": "Referenced records require a record page.",
              "referenced_records.relation_invalid": "Referenced records require an active Relation field targeting the record page table.",
              "referenced_records.fields_invalid": "Displayed fields must be active fields from the referenced records source table.",
              "view.invalid": "The View is missing or belongs to another Base.",
              "records.aggregate_source": "The Records source must return ordinary records.",
              "query.table_limit.records": "A Records source may reference at most 24 tables.",
              "navigation.record_table_mismatch": "Row record IDs may only populate parameters for the source table.",
              "navigation.relation_invalid": "Row relation navigation requires a selected single relation to the parameter table.",
              "cards.view_required": "Cards display requires a saved View configured for Cards.",
              "cards.field_unavailable": `Card field ${v("fieldId")} is unavailable.`,
              "cards.cover_file_required": "The card cover must use a file field.",
              "records.field_not_selected": `Displayed field ${v("fieldId")} is not selected by the Records query.`,
              "referenced_records.source_mismatch": "The referenced-records query must use the configured source table.",
              "metrics.aggregate_required": "The Metrics source must return ungrouped scalar aggregations.",
              "metrics.aggregation_limit": "The Metrics source may return at most 12 aggregations.",
              "chart.group_required": "The Chart source must group rows and include at least one aggregation.",
              "query.table_limit.insights": "Metrics and Chart sources may reference at most 24 tables.",
              "form.invalid": "The Form is missing, inactive, or belongs to another Base.",
              "form.input_limit": "A Grids App Form may expose at most 100 input fields.",
              "form.fixed_limit": "A Grids App Form may bind at most 30 fixed fields.",
              "form.field_invalid": `Form field ${v("fieldId")} is missing, deleted, unwritable, or belongs to another table.`,
              "form.inline_create_config_invalid": `Inline-create field ${v("fieldId")} has no valid relation target or target fields.`,
              "form.inline_create_field_invalid": `Inline-create field ${v("fieldId")} is missing, deleted, unwritable, or belongs to another table.`,
              "form.fixed_target_invalid": "A fixed value must target a user-input field in the referenced Form.",
              "form.current_user_target_invalid": "The current user may only be bound to a People and groups field.",
              "form.fixed_value_invalid": `The fixed value for Form field ${v("fieldId")} is invalid.`,
              "form.record_relation_required": "Record sources may only bind compatible relation fields.",
              "form.record_relation_mismatch": "The fixed relation field and record source must reference the same table.",
              "form.result_navigation_mismatch": "RESULT.recordId may only populate a record parameter for the Form table.",
              "workflow_launcher.invalid": "The workflow launcher is missing, disabled, invalid, unsupported, or belongs to another Base.",
              "workflow_launcher.revision_invalid": "The workflow launcher does not reference a ready workflow revision.",
              "workflow_launcher.fixed_inputs": "Fixed workflow launchers do not accept Grids App inputs.",
              "workflow_input.unknown": `Unknown workflow input “${v("name")}”.`,
              "workflow_input.invalid": `Workflow input “${v("name")}” is invalid.`,
              "workflow_input.record_binding_invalid": `Workflow input “${v("name")}” must be a record input bound to the referenced table.`,
              "scanner_launcher.invalid": "The scanner launcher is missing, disabled, invalid, unsupported, or belongs to another Base.",
              "scanner_launcher.revision_invalid": "The scanner launcher does not reference a ready workflow revision.",
              "scanner_launcher.record_prompt": `Scanner Apps cannot prompt for record input “${v("name")}”.`,
              "identity.immutable": "The Grids App identity cannot be changed.",
            } as Record<string, string>
          )[code] ?? "The Grids App definition is invalid."
        );
      },
    },
    de: {
      diagnostic: ({ code, params }) => {
        const v = (key: string) => value(params, key);
        const resourceKind =
          (
            {
              Table: "Tabelle",
              Field: "Feld",
              View: "Ansicht",
              Form: "Formular",
              Template: "Vorlage",
              Launcher: "Workflow-Ausführungsoption",
            } as Record<string, string>
          )[v("kind")] ?? v("kind");
        return (
          (
            {
              "schema.invalid": "Die Definition der Grids-App enthält einen ungültigen Wert.",
              "base.missing": "Die Base wurde nicht gefunden.",
              "resource.missing": `${resourceKind} wurde nicht gefunden.`,
              "limit.records.total": "Eine Grids-App darf höchstens 24 Datensatzblöcke enthalten.",
              "limit.records.page": "Eine Seite einer Grids-App darf höchstens vier Datensatzblöcke enthalten.",
              "limit.forms": "Eine Grids-App darf höchstens 24 Formularblöcke enthalten.",
              "limit.insights": "Eine Grids-App darf insgesamt höchstens 24 Kennzahlen- und Diagrammblöcke enthalten.",
              "limit.scanners": "Eine Grids-App darf höchstens 24 Scannerblöcke enthalten.",
              "limit.availability": "Eine Grids-App darf höchstens 256 Verfügbarkeitsabfragen enthalten.",
              "query.invalid": "Die GQL-Abfrage ist ungültig.",
              "query.table_limit.availability": "Eine Verfügbarkeitsabfrage darf höchstens 24 Tabellen referenzieren.",
              "record_parameter.table_invalid": "Die Tabelle des Datensatzparameters fehlt oder gehört zu einer anderen Base.",
              "record_page.table_invalid": "Die Tabelle der Datensatzseite fehlt oder gehört zu einer anderen Base.",
              "field.missing": `Das Feld ${v("fieldId")} fehlt oder gehört zu einer anderen Tabelle.`,
              "field.not_writable": `Das Feld ${v("fieldId")} kann nicht als Datensatzfeld bearbeitet werden.`,
              "html_field.type": `Das Feld ${v("fieldId")} ist kein HTML-Vorlagenfeld.`,
              "html_field.missing": `Das HTML-Vorlagenfeld ${v("fieldId")} fehlt oder gehört zu einer anderen Tabelle.`,
              "relation_target.table_invalid": `Die Zieltabelle ${v("tableId")} der Relation fehlt oder gehört zu einer anderen Base.`,
              "document_template.invalid": `Die Dokumentvorlage ${v("templateId")} fehlt oder gehört zu einer anderen Tabelle.`,
              "referenced_records.record_page_required": "Referenzierte Datensätze erfordern eine Datensatzseite.",
              "referenced_records.relation_invalid":
                "Referenzierte Datensätze erfordern ein aktives Relationsfeld zur Tabelle der Datensatzseite.",
              "referenced_records.fields_invalid":
                "Angezeigte Felder müssen aktive Felder aus der Quelltabelle der referenzierten Datensätze sein.",
              "view.invalid": "Die Ansicht fehlt oder gehört zu einer anderen Base.",
              "records.aggregate_source": "Die Quelle des Datensatzblocks muss normale Datensätze zurückgeben.",
              "query.table_limit.records": "Die Quelle eines Datensatzblocks darf höchstens 24 Tabellen referenzieren.",
              "navigation.record_table_mismatch": "Datensatz-IDs aus einer Zeile dürfen nur Parameter für die Quelltabelle befüllen.",
              "navigation.relation_invalid":
                "Die Zeilennavigation über eine Relation erfordert eine ausgewählte Einzelrelation zur Parametertabelle.",
              "cards.view_required": "Die Kartenansicht erfordert eine gespeicherte Ansicht mit der Darstellung „Karten“.",
              "cards.field_unavailable": `Das Kartenfeld ${v("fieldId")} ist nicht verfügbar.`,
              "cards.cover_file_required": "Das Titelbild einer Karte muss ein Dateifeld verwenden.",
              "records.field_not_selected": `Das angezeigte Feld ${v("fieldId")} wird von der Datensatzabfrage nicht ausgewählt.`,
              "referenced_records.source_mismatch":
                "Die Abfrage für referenzierte Datensätze muss die konfigurierte Quelltabelle verwenden.",
              "metrics.aggregate_required": "Die Quelle des Kennzahlenblocks muss ungruppierte skalare Aggregationen zurückgeben.",
              "metrics.aggregation_limit": "Die Quelle des Kennzahlenblocks darf höchstens zwölf Aggregationen zurückgeben.",
              "chart.group_required": "Die Quelle des Diagrammblocks muss Zeilen gruppieren und mindestens eine Aggregation enthalten.",
              "query.table_limit.insights": "Quellen für Kennzahlen- und Diagrammblöcke dürfen höchstens 24 Tabellen referenzieren.",
              "form.invalid": "Das Formular fehlt, ist inaktiv oder gehört zu einer anderen Base.",
              "form.input_limit": "Ein Formular einer Grids-App darf höchstens 100 Eingabefelder bereitstellen.",
              "form.fixed_limit": "Ein Formular einer Grids-App darf höchstens 30 Felder fest vorbelegen.",
              "form.field_invalid": `Das Formularfeld ${v("fieldId")} fehlt, wurde gelöscht, ist nicht beschreibbar oder gehört zu einer anderen Tabelle.`,
              "form.inline_create_config_invalid": `Für das Inline-Erstellungsfeld ${v("fieldId")} fehlt ein gültiges Relationsziel oder es sind keine Zielfelder konfiguriert.`,
              "form.inline_create_field_invalid": `Das Inline-Erstellungsfeld ${v("fieldId")} fehlt, wurde gelöscht, ist nicht beschreibbar oder gehört zu einer anderen Tabelle.`,
              "form.fixed_target_invalid": "Ein fester Wert muss ein Eingabefeld des referenzierten Formulars befüllen.",
              "form.current_user_target_invalid":
                "Die aktuelle Person kann nur an ein Feld des Typs „Personen und Gruppen“ gebunden werden.",
              "form.fixed_value_invalid": `Der feste Wert für das Formularfeld ${v("fieldId")} ist ungültig.`,
              "form.record_relation_required": "Datensatzquellen können nur an kompatible Relationsfelder gebunden werden.",
              "form.record_relation_mismatch": "Das feste Relationsfeld und die Datensatzquelle müssen dieselbe Tabelle referenzieren.",
              "form.result_navigation_mismatch": "RESULT.recordId darf nur einen Datensatzparameter für die Formulartabelle befüllen.",
              "workflow_launcher.invalid":
                "Die Workflow-Ausführungsoption fehlt, ist deaktiviert oder ungültig, wird nicht unterstützt oder gehört zu einer anderen Base.",
              "workflow_launcher.revision_invalid":
                "Die Workflow-Ausführungsoption verweist nicht auf eine einsatzbereite Workflow-Revision.",
              "workflow_launcher.fixed_inputs":
                "Workflow-Ausführungsoptionen mit festen Eingaben akzeptieren keine Eingaben aus der Grids-App.",
              "workflow_input.unknown": `Die Workflow-Eingabe „${v("name")}“ ist unbekannt.`,
              "workflow_input.invalid": `Die Workflow-Eingabe „${v("name")}“ ist ungültig.`,
              "workflow_input.record_binding_invalid": `Die Workflow-Eingabe „${v("name")}“ muss eine Datensatzeingabe sein, die an die referenzierte Tabelle gebunden ist.`,
              "scanner_launcher.invalid":
                "Die Scanner-Ausführungsoption fehlt, ist deaktiviert oder ungültig, wird nicht unterstützt oder gehört zu einer anderen Base.",
              "scanner_launcher.revision_invalid":
                "Die Scanner-Ausführungsoption verweist nicht auf eine einsatzbereite Workflow-Revision.",
              "scanner_launcher.record_prompt": `Scanner-Apps können die Datensatzeingabe „${v("name")}“ nicht interaktiv abfragen.`,
              "identity.immutable": "Die Identität der Grids-App kann nicht geändert werden.",
            } as Record<string, string>
          )[code] ?? "Die Definition der Grids-App ist ungültig."
        );
      },
    },
  },
});

export const customAppDiagnostic = (
  locale: string | undefined,
  code: string,
  path: Array<string | number>,
  params: DiagnosticParams = {},
): CustomAppDiagnostic => ({
  code,
  path,
  message: customAppDiagnosticMessages.resolve(locale ? [locale] : []).t.diagnostic({ code, params }),
});
