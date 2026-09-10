import { sdkReference } from "../sdk";
import { databaseNotes, type Detail, type Words } from "../sdk-details";
import type { z } from "zod";
type Locale = "en" | "de";
type Schema = z.core.JSONSchema.JSONSchema;
const pick = (locale: Locale, en: string, de: string) => (locale === "de" ? de : en);
const code = (value: string) => `\`${value.replaceAll("|", "\\|").replaceAll("`", "'")}\``;
const anchor = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
const labels = (l: Locale) => ({
  args: pick(l, "Arguments", "Argumente"),
  required: pick(l, "Required", "Pflicht"),
  optional: pick(l, "optional", "optional"),
  type: pick(l, "Type / allowed values", "Typ / erlaubte Werte"),
  meaning: pick(l, "Meaning", "Bedeutung"),
  returns: pick(l, "Returns", "Rückgabe"),
  example: pick(l, "Example", "Beispiel"),
  notes: pick(l, "Behavior and errors", "Verhalten und Fehler"),
});
const schemaPage = (key: string) =>
  key.startsWith("Modal.")
    ? "modals"
    : key === "ChartOptions"
      ? "charts"
      : ["TableDefinition", "SchemaChanges", "RowQuery", "ImportOptions"].includes(key)
        ? "db"
        : "ui-types";
function argumentTable(detail: Detail, l: Locale) {
  const t = labels(l);
  if (!detail.args.length) return pick(l, "No arguments.", "Keine Argumente.");
  return (
    `| ${t.args} | ${t.type} | ${t.required} | Default | ${t.meaning} |\n|---|---|---|---|---|\n` +
    detail.args
      .map(
        (a) =>
          `| ${code(a.name)} | ${code(a.type)} | ${a.optional ? t.optional : pick(l, "yes", "ja")} | ${code(a.default)} | ${a.description[l]} |`,
      )
      .join("\n")
  );
}
function method(name: string, signature: string, description: string, detail: Detail, l: Locale) {
  const t = labels(l);
  const links = detail.schemas?.map((key) => `[${code(key)}](/app/kit/help/kit-sdk-${schemaPage(key)}#${anchor(key)})`).join(", ");
  return `## ${name} {icon="code"}\n\n${description}\n\n\`\`\`js\n${signature}\n\`\`\`\n\n${argumentTable(detail, l)}\n\n**${t.returns}:** ${code(detail.returns)}\n\n${links ? `${pick(l, "Fields", "Felder")}: ${links}.\n\n` : ""}${detail.notes ? `**${t.notes}**\n\n${detail.notes[l]}\n\n` : ""}### ${t.example}\n\n\`\`\`js\n${detail.example}\n\`\`\`\n`;
}
const meanings: Record<string, Words> = Object.fromEntries(
  [
    ["id", "Unique UI id; generated when omitted.", "Eindeutige UI-ID; wird ohne Angabe erzeugt."],
    ["label", "Visible label.", "Sichtbare Beschriftung."],
    ["title", "Visible heading.", "Sichtbare Überschrift."],
    ["description", "Supporting text.", "Erklärungstext."],
    ["value", "Value to display or edit.", "Anzuzeigender oder bearbeiteter Wert."],
    [
      "default",
      "Initial field value; omitted fields start empty (boolean: false).",
      "Anfänglicher Feldwert; ohne Angabe leer (boolean: false).",
    ],
    ["type", "Field or column value type.", "Typ des Feldes oder Spaltenwerts."],
    ["placeholder", "Hint inside an empty field.", "Hinweis im leeren Feld."],
    ["disabled", "Prevent input and callbacks.", "Eingaben und Callbacks verhindern."],
    ["loading", "Show loading state and suppress callbacks.", "Ladezustand zeigen und Callbacks unterdrücken."],
    ["icon", "Tabler icon classes, e.g. ti ti-plus.", "Tabler-Iconklassen, etwa ti ti-plus."],
    [
      "variant",
      "Visual action style; modal variants differ from button variants.",
      "Darstellung der Aktion; Modalvarianten unterscheiden sich von Buttonvarianten.",
    ],
    ["key", "Property name in each table row.", "Eigenschaftsname in jeder Tabellenzeile."],
    ["columns", "Columns to display or create.", "Anzuzeigende oder anzulegende Spalten."],
    ["align", "Text alignment; omitted uses the table default.", "Textausrichtung; ohne Angabe gilt der Tabellenstandard."],
    ["rowKey", "Property containing the stable row identity.", "Eigenschaft mit der stabilen Zeilenidentität."],
    ["empty", "Empty state heading and supporting text.", "Überschrift und Erklärung im Leerzustand."],
    ["action", "Existing UI action handle, optionally a row of buttons.", "Vorhandenes UI-Aktionshandle, optional eine Zeile mit Buttons."],
    [
      "href",
      "Relative URL or HTTP(S)/mailto; other protocols rejected.",
      "Relative URL oder HTTP(S)/mailto; andere Protokolle werden abgelehnt.",
    ],
    ["newTab", "Open a new browser tab.", "Neuen Browser-Tab öffnen."],
    ["headingScale", "Markdown heading size.", "Größe der Markdown-Überschriften."],
    ["gap", "Space between child elements.", "Abstand zwischen Kindelementen."],
    [
      "accept",
      "HTML file filter, e.g. .csv,text/csv; not content validation.",
      "HTML-Dateifilter, etwa .csv,text/csv; keine Inhaltsvalidierung.",
    ],
    ["multiple", "Allow several files.", "Mehrere Dateien erlauben."],
    ["message", "Confirmation question.", "Bestätigungsfrage."],
    ["confirmText", "Confirm action label; omitted uses Cloud locale.", "Text der Bestätigungsaktion; ohne Angabe in Cloud-Sprache."],
    ["cancelText", "Cancel action label; omitted uses Cloud locale.", "Text der Abbruchaktion; ohne Angabe in Cloud-Sprache."],
    [
      "required",
      "Require a value; required boolean must be checked.",
      "Wert erforderlich; ein erforderliches Boolean-Feld muss aktiviert sein.",
    ],
    ["minLength", "Minimum text length.", "Mindestlänge des Textes."],
    ["maxLength", "Maximum text length.", "Höchstlänge des Textes."],
    ["multiline", "Use a textarea.", "Mehrzeiliges Textfeld verwenden."],
    ["min", "Lower bound; omitted form values are unbounded.", "Untere Grenze; ohne Angabe bei Formularen unbegrenzt."],
    ["max", "Upper bound; omitted form values are unbounded.", "Obere Grenze; ohne Angabe bei Formularen unbegrenzt."],
    ["step", "Native number-input step.", "Schrittweite des nativen Zahlenfeldes."],
    ["options", "Declared select choices.", "Deklarierte Select-Auswahlmöglichkeiten."],
    ["fields", "Named form fields.", "Benannte Formularfelder."],
    ["name", "Table or column identifier.", "Tabellen- oder Spaltenname."],
    ["not_null", "Reject null values.", "Null-Werte ablehnen."],
    ["unique", "Require unique column values.", "Eindeutige Spaltenwerte verlangen."],
    ["index", "Create a column index.", "Spaltenindex anlegen."],
    ["rename", "New table name.", "Neuer Tabellenname."],
    ["add_columns", "New columns.", "Neue Spalten."],
    ["drop_columns", "Columns to delete, including their data.", "Zu löschende Spalten einschließlich ihrer Daten."],
    ["rename_columns", "Old-to-new column name mapping.", "Zuordnung alter zu neuen Spaltennamen."],
    ["createTable", "Create a missing table; requires admin.", "Fehlende Tabelle anlegen; benötigt Admin."],
    ["notify", "Show progress toast and cancellation control.", "Fortschritts-Toast und Abbruchaktion zeigen."],
    ["kind", "Chart type.", "Diagrammtyp."],
    ["data", "Data points in source order.", "Datenpunkte in Eingabereihenfolge."],
    ["series", "Named data series.", "Benannte Datenreihen."],
    ["subtitle", "Secondary chart title.", "Untertitel des Diagramms."],
    ["padding", "Internal chart margins, not outer UI spacing.", "Innere Diagrammränder, keine äußeren UI-Abstände."],
    ["top", "Top padding.", "Oberer Innenabstand."],
    ["right", "Right padding.", "Rechter Innenabstand."],
    ["bottom", "Bottom padding.", "Unterer Innenabstand."],
    ["left", "Left padding.", "Linker Innenabstand."],
    ["x", "X coordinate or category.", "X-Koordinate oder Kategorie."],
    ["y", "Y coordinate or category.", "Y-Koordinate oder Kategorie."],
    ["xAxis", "Horizontal axis options.", "Optionen der horizontalen Achse."],
    ["yAxis", "Vertical axis options.", "Optionen der vertikalen Achse."],
    ["ticks", "Target tick count; scale chooses nice intervals.", "Angestrebte Teilstrichanzahl; Skala wählt passende Intervalle."],
    ["scale", "Axis scale.", "Achsenskalierung."],
    ["minorTicks", "Show intermediate tick marks.", "Zwischenteilstriche anzeigen."],
    ["size", "Marker magnitude.", "Markergröße."],
    ["sizeRange", "Minimum and maximum rendered marker sizes.", "Kleinste und größte dargestellte Markergröße."],
    ["marker", "Point shape.", "Punktform."],
    ["lineStyle", "Line pattern.", "Linienmuster."],
    ["references", "Reference lines.", "Referenzlinien."],
    ["axis", "Reference axis, default y.", "Referenzachse, Standard y."],
    ["legend", "Show series/state legend.", "Legende der Reihen/Zustände anzeigen."],
    ["smooth", "Interpolate smooth curves.", "Glatte Kurven interpolieren."],
    ["area", "Fill under the curve.", "Fläche unter der Kurve füllen."],
    ["autoVariant", "Vary series shapes or line styles automatically.", "Punktformen oder Linienmuster automatisch variieren."],
    ["errorBand", "Render uncertainty as a band.", "Unsicherheit als Band darstellen."],
    ["interactive", "Enable shared chart interactions.", "Interaktionen des gemeinsamen Diagramms aktivieren."],
    ["trendline", "Show fitted trendline.", "Angepasste Trendlinie anzeigen."],
    ["colorByBar", "Vary colors by bar.", "Farben nach Balken variieren."],
    ["colorByBox", "Vary colors by box.", "Farben nach Box variieren."],
    ["showValues", "Display numeric labels.", "Zahlenwerte anzeigen."],
    ["showLabels", "Display segment labels.", "Segmentbeschriftungen anzeigen."],
    ["innerRadius", "Hole radius relative to chart radius.", "Lochradius relativ zum Diagrammradius."],
    ["showLast", "Mark the last point.", "Letzten Punkt markieren."],
    ["showMinMax", "Mark minimum and maximum.", "Minimum und Maximum markieren."],
    ["bins", "Bin count or explicit boundaries.", "Anzahl der Klassen oder explizite Grenzen."],
    ["groups", "Named sample groups.", "Benannte Stichprobengruppen."],
    ["values", "Numeric samples.", "Numerische Stichprobenwerte."],
    ["showOutliers", "Show outlying observations.", "Ausreißer anzeigen."],
    ["unit", "Display unit suffix.", "Angezeigte Einheit als Suffix."],
    ["thresholds", "Threshold values, optional labels/colors.", "Schwellenwerte, optionale Beschriftungen/Farben."],
    ["color", "Hex or named color; no CSS resources.", "Hex- oder benannte Farbe; keine CSS-Ressourcen."],
    ["showNeedle", "Show gauge needle.", "Zeiger anzeigen."],
    ["delta", "Change value shown with the statistic.", "Änderungswert neben der Kennzahl."],
    ["trend", "Direction of change.", "Änderungsrichtung."],
    ["sparkline", "Small accompanying data series.", "Kleine begleitende Datenreihe."],
    ["xLabels", "Explicit horizontal category order.", "Explizite Reihenfolge horizontaler Kategorien."],
    ["yLabels", "Explicit vertical category order.", "Explizite Reihenfolge vertikaler Kategorien."],
    ["latitude", "Latitude in degrees.", "Breitengrad in Grad."],
    ["longitude", "Longitude in degrees.", "Längengrad in Grad."],
    ["viewport", "Map center and zoom.", "Kartenmittelpunkt und Zoom."],
    ["zoom", "Map zoom.", "Kartenzoom."],
    ["rows", "Timeline rows.", "Zeilen der Zeitleiste."],
    ["intervals", "Intervals within a row.", "Intervalle innerhalb einer Zeile."],
    ["from", "Interval start, same numeric unit as to.", "Intervallbeginn, gleiche numerische Einheit wie to."],
    ["to", "Interval end, same numeric unit as from.", "Intervallende, gleiche numerische Einheit wie from."],
    ["state", "State identifier.", "Zustandskennung."],
    ["states", "Optional state labels and colors.", "Optionale Zustandsbeschriftungen und Farben."],
    ...["errY", "errYHigh", "errYLow", "errX", "errXHigh", "errXLow"].map((k) => [
      k,
      "Symmetric or upper/lower uncertainty in axis units.",
      "Symmetrische oder obere/untere Unsicherheit in Achseneinheiten.",
    ]),
  ].map(([key, en, de]) => [key!, { en: en!, de: de! }]),
);
function schemaTable(schema: Schema, l: Locale, chart = false) {
  const rows: string[] = [];
  const walk = (s: Schema, path: string, required: boolean) => {
    const variants = s.oneOf ?? s.anyOf;
    if (variants) {
      variants.forEach((v, i) => {
        const discriminator = v.properties?.kind ?? v.properties?.type;
        const label = typeof discriminator === "object" ? discriminator.const : undefined;
        walk(v, `${path} (${label ?? i + 1})`, required);
      });
      return;
    }
    const bounds = [
      s.minLength !== undefined && `length ≥ ${s.minLength}`,
      s.maxLength !== undefined && `length ≤ ${s.maxLength}`,
      s.minimum !== undefined && `≥ ${s.minimum}`,
      s.maximum !== undefined && `≤ ${s.maximum}`,
      s.exclusiveMinimum !== undefined && `> ${s.exclusiveMinimum}`,
      s.minItems !== undefined && `items ≥ ${s.minItems}`,
      s.maxItems !== undefined && `items ≤ ${s.maxItems}`,
      s.pattern && `/${s.pattern}/`,
    ]
      .filter(Boolean)
      .join("; ");
    const type =
      s.const !== undefined
        ? JSON.stringify(s.const)
        : s.enum
          ? s.enum.map((v) => JSON.stringify(v)).join(" | ")
          : s.$ref
            ? "JSON"
            : Array.isArray(s.type)
              ? s.type.join(" | ")
              : (s.type ?? "JSON");
    const key =
      path
        .split(".")
        .at(-1)
        ?.replace(/\[\].*| \(\d+\)/g, "") ?? "";
    const chartMeaning =
      chart && key === "step"
        ? pick(l, "Step interpolation between points.", "Stufeninterpolation zwischen Punkten.")
        : chart && ["min", "max"].includes(key)
          ? pick(l, "Explicit axis or gauge bound; see chart defaults.", "Explizite Achsen- oder Anzeigegrenze; siehe Diagramm-Defaults.")
          : undefined;
    const meaning =
      chartMeaning ??
      meanings[key]?.[l] ??
      (path.endsWith("[]")
        ? pick(l, "Array entry.", "Array-Eintrag.")
        : pick(l, "See nested fields below.", "Siehe verschachtelte Felder unten."));
    if (path)
      rows.push(
        `| ${code(path)} | ${code(type)}${bounds ? `<br>${code(bounds)}` : ""} | ${required ? pick(l, "yes", "ja") : "—"} | ${s.default === undefined ? "—" : code(JSON.stringify(s.default))} | ${meaning} |`,
      );
    for (const [k, v] of Object.entries(s.properties ?? {})) {
      if (typeof v !== "boolean") walk(v, path ? `${path}.${k}` : k, s.required?.includes(k) ?? false);
    }
    if (s.items && typeof s.items === "object" && !Array.isArray(s.items)) walk(s.items, `${path}[]`, true);
    s.prefixItems?.forEach((v, i) => {
      if (typeof v !== "boolean") walk(v, `${path}[${i}]`, true);
    });
    if (s.additionalProperties && typeof s.additionalProperties === "object") walk(s.additionalProperties, `${path}.*`, false);
  };
  walk(schema, "", true);
  return `| ${pick(l, "Field", "Feld")} | ${labels(l).type} | ${labels(l).required} | Default | ${labels(l).meaning} |\n|---|---|---|---|---|\n${rows.join("\n")}`;
}
function schemas(page: string, l: Locale) {
  return Object.entries(sdkReference.schemas)
    .filter(([key]) => schemaPage(key) === page)
    .map(
      ([key, schema]) =>
        `## ${key} {icon="list"}\n\n${
          key === "ChartOptions" && schema.oneOf
            ? schema.oneOf
                .map((variant) => {
                  const kind = variant.properties?.kind;
                  const name = typeof kind === "object" ? kind.const : "Chart";
                  return `### ${name}: ${pick(l, "options", "Optionen")}

${schemaTable(variant, l, true)}`;
                })
                .join("\n\n")
            : schemaTable(schema, l, key === "ChartOptions")
        }`,
    )
    .join("\n\n");
}
function document(id: string, title: string, body: string, order: number) {
  return `---\nid: kit-sdk-${id}\ntitle: "${title}"\nicon: ti ti-code\ndescription: "${title}"\norder: ${order}\n---\n\n${body}\n`;
}
export function sdkHelp(l: Locale) {
  const intro = pick(
    l,
    "Examples belong inside async run() or a callback, unless they include export default. Database examples use a disposable example_tasks table; create it first with the tables.create example. They are real writes. Read [runtime and limits](/app/kit/help/kit-sdk-runtime) first.",
    "Beispiele gehören in async run() oder einen Callback, sofern sie kein export default enthalten. Datenbankbeispiele nutzen die entbehrliche Tabelle example_tasks; zuerst mit dem tables.create-Beispiel anlegen. Sie schreiben echte Daten. Lies zuerst [Laufzeit und Grenzen](/app/kit/help/kit-sdk-runtime).",
  );
  const pageFor = (name: string) => (name.startsWith("ui.modal.") ? "modals" : name === "ui.chart" ? "charts" : name.split(".")[0]!);
  const pages = ["script", "ui", "modals", "charts", "file", "sheet", "money", "store", "opfs", "pdf", "db"];
  const docs = pages.map((page, index) => {
    let body = sdkReference.methods
      .filter(([name]) => pageFor(name) === page)
      .map(([name, signature, description]) =>
        method(
          `kit.${name}`,
          `kit.${signature}`,
          l === "de" ? sdkReference.descriptions.de[name]! : description,
          sdkReference.details[name]!,
          l,
        ),
      )
      .join("\n");
    if (page === "db")
      body +=
        `\n\n${databaseNotes[l]}\n\n` +
        Object.entries(sdkReference.tableMethods)
          .map(([name, details]) =>
            method(
              `TableHandle.${name}`,
              `kit.db.table(name).${name}(${details.args.map((a) => a.name).join(", ")})`,
              pick(l, "Method on the selected table.", "Methode der ausgewählten Tabelle."),
              details,
              l,
            ),
          )
          .join("\n");
    if (page === "charts" || page === "db")
      body += `\n\n## ${pick(l, "Detailed behavior", "Verhalten im Detail")} {icon="info-circle"}\n\n${sdkReference.notes[page][l]}`;
    if (page === "charts")
      body +=
        "\n\n" +
        sdkReference.chartExamples
          .map((config) => `### ${config.kind}\n\n\`\`\`js\nkit.ui.chart(${JSON.stringify(config, null, 2)});\n\`\`\``)
          .join("\n\n");
    if (["modals", "charts", "db"].includes(page)) body += `\n\n${schemas(page, l)}`;
    return document(
      page,
      `Kit API: ${page}`,
      `${intro}\n\n${page === "ui" ? pick(l, "See [UI handles](/app/kit/help/kit-sdk-handles) for updates and [field types](/app/kit/help/kit-sdk-ui-types) for options.", "Siehe [UI-Handles](/app/kit/help/kit-sdk-handles) für Updates und [Feldtypen](/app/kit/help/kit-sdk-ui-types) für Optionen.") : ""}\n\n${body}`,
      200 + index,
    );
  });
  docs.push(
    document(
      "ui-types",
      pick(l, "Kit API: UI field types", "Kit API: UI-Feldtypen"),
      pick(
        l,
        "Tables are derived from the current schemas. Required is relative to the containing object. A dash means no explicit Kit default: omit optional fields; it does not mean null is accepted. Generated ids must remain unique. UI actions are handles, not JSON. Custom schema refinements and runtime behavior are described with each method.",
        "Tabellen stammen aus den aktuellen Schemas. Pflicht bezieht sich auf das umgebende Objekt. Ein Strich bedeutet keinen expliziten Kit-Default: optionale Felder weglassen; null ist dadurch nicht erlaubt. Generierte IDs müssen eindeutig bleiben. UI-Aktionen sind Handles, kein JSON. Zusätzliche Schemaregeln und Laufzeitverhalten stehen bei der jeweiligen Methode.",
      ) +
        "\n\n" +
        schemas("ui-types", l),
      212,
    ),
  );
  docs.push(
    document(
      "handles",
      pick(l, "Kit API: updating UI handles", "Kit API: UI-Handles aktualisieren"),
      pick(
        l,
        "Every UI constructor returns a worker-local handle with a stable id. Methods are synchronous and return void unless noted; errors throw. Changes are batched into the next UI snapshot. Handles are not DOM nodes and cannot be sent in modal schemas. The following methods are exposed on each handle; only use them for the indicated element kinds.",
        "Jeder UI-Konstruktor liefert ein lokales Worker-Handle mit stabiler id. Methoden sind synchron und liefern void, sofern nicht anders angegeben; Fehler werden geworfen. Änderungen werden im nächsten UI-Snapshot gebündelt. Handles sind keine DOM-Knoten und dürfen nicht in Modal-Schemas stehen. Die folgenden Methoden sind auf jedem Handle vorhanden; nur für die angegebenen Elementtypen verwenden.",
      ) +
        "\n\n" +
        sdkReference.handleMethods
          .map(
            ([sig, result, en, de]) =>
              `## ${sig} {icon="code"}\n\n${code(sig)} → ${code(result)}\n\n${pick(l, en, de)}\n\n\`\`\`js\n${sdkReference.handleExamples[sig.split("(")[0]!]}\n\`\`\``,
          )
          .join("\n\n"),
      213,
    ),
  );
  return docs;
}
