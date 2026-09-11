import { z } from "zod";
import { UiNode, UiColumn, SelectOption, LinkOptions, FileOpenOptions } from "./runtime/protocol";
import { ModalRequest } from "./runtime/modal-schema";
import { ChartOptions } from "./runtime/chart-schema";
import { DatabaseRequest, DbColumn, DbName } from "./database-contracts";
import { ImportOptions } from "./database-import";

export type Words = { en: string; de: string };
const words = (en: string, de: string): Words => ({ en, de });
export type Argument = { name: string; type: string; optional: boolean; default: string; description: Words };
const arg = (name: string, type: string, en: string, de: string, optional = false, fallback = "—"): Argument => ({
  name,
  type,
  optional,
  default: fallback,
  description: words(en, de),
});
export type Detail = { args: Argument[]; returns: string; example: string; schemas?: string[]; notes?: Words };
const options = (type: string, optional = true) =>
  arg("options", type, "Options; see the linked field table.", "Optionen; siehe verlinkte Feldtabelle.", optional, optional ? "{}" : "—");
const text = (name = "text") => arg(name, "string", "Text, at most 16000 characters.", "Text, höchstens 16000 Zeichen.");
const name = (key = "name") =>
  arg(
    key,
    "DbName",
    "Letter first, then letters/digits/underscore; 1–63 characters.",
    "Buchstabe zuerst, danach Buchstaben/Ziffern/Unterstrich; 1–63 Zeichen.",
  );
const path = (key = "path") =>
  arg(
    key,
    "string",
    "Relative path, 1–240 characters; no empty, dot, parent, backslash or NUL segments.",
    "Relativer Pfad, 1–240 Zeichen; keine leeren Segmente, Punkt, Elternpfade, Backslash oder NUL.",
  );
const money = (key = "value") =>
  arg(
    key,
    "Money",
    "Safe integer amount in minor units and supported uppercase currency.",
    "Sichere Ganzzahl in Untereinheiten und unterstützter Währungscode in Großbuchstaben.",
  );
const decimal = (key: string) =>
  arg(
    key,
    "string",
    "Decimal notation with dot, no exponent or currency symbol.",
    "Dezimalschreibweise mit Punkt, ohne Exponent oder Währungssymbol.",
  );
const children = arg(
  "children",
  "UIHandle[]",
  "Existing handles; one parent per element, no cycles.",
  "Vorhandene Handles; ein Elternknoten pro Element, keine Zyklen.",
);
const input = arg(
  "callback",
  "() => unknown | Promise<unknown>",
  "Invoked on click; return your Promise. Other callbacks are not executed while it is pending.",
  "Wird beim Klick aufgerufen; Promise zurückgeben. Währenddessen werden andere Callbacks nicht ausgeführt.",
);
const localNotes = words(
  "Local to this app, user and browser. Missing reads/deletes return null. Invalid paths, non-JSON KV values, items over 16 MiB, unavailable OPFS and browser quota failures reject. Lists are sorted and reject above 1000 files. Stop discards queued calls; an accepted write may finish. No cross-tab transactions.",
  "Lokal für diese App, diesen Nutzer und Browser. Fehlende Lese-/Löschziele liefern null. Ungültige Pfade, nicht als JSON speicherbare KV-Werte, Einträge über 16 MiB, fehlendes OPFS und Quotenfehler lehnen das Promise ab. Listen sind sortiert und lehnen über 1000 Dateien ab. Stoppen verwirft wartende Aufrufe; angenommene Schreibvorgänge können fertig werden. Keine Transaktionen über Tabs hinweg.",
);
export const methodDetails: Record<string, Detail> = {
  script: {
    args: [
      arg(
        "definition",
        "{name: string, icon?: string, order?: number, run: () => unknown | Promise<unknown>}",
        "Literal name/icon/order metadata; run constructs UI after explicit Launch. Export the definition as default from *.script.js.",
        "Name/icon/order als statische Metadaten; run baut die UI nach explizitem Start auf. Definition in *.script.js als default exportieren.",
      ),
    ],
    returns: "ScriptDefinition",
    example: 'export default kit.script({ name: "Hello", icon: "ti ti-code", order: 10, run() { kit.ui.text("Hello"); } });',
  },
  "ui.text": { args: [text()], returns: "UIHandle", example: 'const message = kit.ui.text("Ready");\nmessage.set("Done");' },
  "ui.button": {
    args: [text("label"), input, options("ButtonOptions")],
    schemas: ["ButtonOptions"],
    returns: "UIHandle",
    example:
      'const button = kit.ui.button("Run", async () => {\n  button.setLoading(true);\n  try { await kit.store.set("lastRun", Date.now()); }\n  finally { button.setLoading(false); }\n}, { variant: "primary", icon: "ti ti-player-play" });',
  },
  "ui.input": {
    args: [text("label"), options("InputOptions & {onChange?: (value: string) => unknown | Promise<unknown>}")],
    schemas: ["InputOptions"],
    returns: "UIHandle",
    example:
      'const field = kit.ui.input("Name", { value: "Ada", onChange: value => console.log(value) });\nfield.set("Grace");\nconsole.log(field.getValue());',
    notes: words(
      "User input updates the value before onChange. set does not call onChange; keep input callbacks short to avoid dropped events during another pending callback.",
      "Nutzereingaben ändern den Wert vor onChange. set ruft onChange nicht auf; Eingabe-Callbacks kurz halten, da während eines wartenden Callbacks weitere Ereignisse nicht ausgeführt werden.",
    ),
  },
  "ui.select": {
    notes: words("No onChange callback or SelectOptions object. Read getValue() from an Apply button callback; set(value) updates the selection.", "Kein onChange-Callback und kein SelectOptions-Objekt. getValue() in einem Anwenden-Button lesen; set(value) ändert die Auswahl."),
    args: [
      text("label"),
      arg(
        "options",
        "SelectOption[]",
        "Up to 200 options; labels must be visible.",
        "Bis zu 200 Optionen; Beschriftungen müssen sichtbar sein.",
      ),
      arg(
        "initial",
        "string",
        "Initial option value; set later requires a declared value.",
        "Anfänglicher Optionswert; späteres set benötigt einen deklarierten Wert.",
        true,
        '""',
      ),
      arg("id", "string", "Unique UI id, at most 80 characters.", "Eindeutige UI-ID, höchstens 80 Zeichen.", true, "generated"),
    ],
    schemas: ["SelectOption"],
    returns: "UIHandle",
    example:
      'const separator = kit.ui.select("Separator", [{ value: "\\t", label: "Tab" }, { value: ";", label: "Semicolon" }], ";");\nconsole.log(separator.getValue());',
  },
  "ui.table": {
    args: [options("TableOptions", false)],
    schemas: ["TableOptions"],
    returns: "UIHandle",
    example:
      'const table = kit.ui.table({ rowKey: "id", columns: [{ key: "title", label: "Task" }] });\ntable.set([{ id: "a", title: "First" }]);\ntable.upsert([{ id: "a", title: "Changed" }]);\ntable.remove(["a"]);',
  },
  "ui.workbench": {
    args: [
      arg(
        "options",
        "{controls: UIHandle[], content: UIHandle[], footer?: {status?: UIHandle, actions?: UIHandle[]}}",
        "One root. Empty controls uses full width. Footer actions default to []. Children must have unique ownership.",
        "Eine Wurzel. Leere controls nutzen volle Breite. Footer-actions sind standardmäßig []. Kinder müssen eindeutig zugeordnet sein.",
      ),
    ],
    returns: "UIHandle",
    example:
      'const status = kit.ui.status("Ready");\nkit.ui.workbench({ controls: [kit.ui.input("Search")], content: [kit.ui.text("Results")], footer: { status } });',
  },
  "ui.section": {
    args: [
      arg(
        "options",
        "{title: string, description?: string}",
        "Heading and optional supporting text, each up to 16000 characters.",
        "Überschrift und optionaler Erklärungstext, jeweils bis 16000 Zeichen.",
      ),
      children,
    ],
    returns: "UIHandle",
    example: 'kit.ui.section({ title: "Input", description: "Choose a name" }, [kit.ui.input("Name")]);',
  },
  "ui.filePicker": {
    args: [
      text("label"),
      arg(
        "options",
        "FilePickerOptions & {onChange: (files: File[]) => unknown | Promise<unknown>}",
        "Callback receives selected files. Cancel keeps previous selection and does not call it.",
        "Callback erhält ausgewählte Dateien. Abbrechen erhält die vorige Auswahl und ruft ihn nicht auf.",
      ),
    ],
    schemas: ["FilePickerOptions"],
    returns: "UIHandle",
    example: 'kit.ui.filePicker("CSV", { accept: ".csv,text/csv", onChange: files => console.log(files.map(file => file.name)) });',
  },
  "ui.status": {
    args: [text()],
    returns: "UIHandle",
    example: 'const status = kit.ui.status("Ready");\nstatus.setState("error", "Choose another file");\nstatus.set("Import failed");',
  },
  "ui.list": {
    args: [
      options("ListOptions", false),
      arg(
        "items",
        "ListItem[]",
        "Up to 1000 items with unique ids; action is a handle, not a callback.",
        "Bis zu 1000 Einträge mit eindeutigen IDs; action ist ein Handle, kein Callback.",
      ),
    ],
    schemas: ["ListOptions", "ListItem"],
    returns: "UIHandle",
    example:
      'const action = kit.ui.button("Open", () => console.log("a"));\nconst list = kit.ui.list({ title: "Tasks" }, [{ id: "a", title: "First", action }]);\nlist.upsert([{ id: "a", title: "Changed", action }]);\nlist.remove();',
  },
  "ui.link": {
    args: [text("label"), options("LinkOptions", false)],
    schemas: ["LinkOptions"],
    returns: "UIHandle",
    example: 'kit.ui.link("Documentation", { href: "https://example.com", newTab: true });',
  },
  "ui.linkButton": {
    args: [text("label"), options("LinkButtonOptions", false)],
    schemas: ["LinkButtonOptions"],
    returns: "UIHandle",
    example: 'kit.ui.linkButton("Documentation", { href: "https://example.com", variant: "secondary" });',
  },
  "ui.markdown": {
    args: [text("source"), options("MarkdownOptions")],
    schemas: ["MarkdownOptions"],
    returns: "UIHandle",
    example: 'const document = kit.ui.markdown("## Notes\\nUse **CSV** files.");\ndocument.set("## Done");',
  },
  "ui.chart": {
    args: [options("ChartOptions", false)],
    schemas: ["ChartOptions"],
    returns: "UIHandle",
    example:
      'const chart = kit.ui.chart({ kind: "bar", data: [{ label: "Open", value: 3 }], showValues: true });\nchart.set({ kind: "bar", data: [{ label: "Open", value: 4 }], showValues: true });',
  },
  "ui.progress": {
    args: [],
    returns: "UIHandle",
    example: "const progress = kit.ui.progress();\nprogress.set(0.5);",
    notes: words("set accepts a fraction from 0 to 1, initially 0.", "set akzeptiert einen Anteil von 0 bis 1, anfangs 0."),
  },
  "ui.row": {
    args: [options("LayoutOptions", false), children],
    schemas: ["LayoutOptions"],
    returns: "UIHandle",
    example: 'kit.ui.row({ gap: "sm" }, [kit.ui.text("Left"), kit.ui.text("Right")]);',
  },
  "ui.column": {
    args: [options("LayoutOptions", false), children],
    schemas: ["LayoutOptions"],
    returns: "UIHandle",
    example: 'kit.ui.column({ gap: "md" }, [kit.ui.text("Top"), kit.ui.text("Bottom")]);',
  },
};
for (const kind of ["confirm", "text", "number", "dialog"] as const) {
  const config = {
    confirm: '{ title: "Continue?", message: "Start the next step?" }',
    text: '{ title: "Name", label: "Name", required: true }',
    number: '{ title: "Count", label: "Count", min: 1, max: 10, value: 1 }',
    dialog:
      '{ title: "New task", fields: { title: { type: "text", label: "Task", required: true }, priority: { type: "select", label: "Priority", default: "normal", options: [{ value: "normal", label: "Normal" }] } } }',
  }[kind];
  methodDetails[`ui.modal.${kind}`] = {
    args: [options(`Modal.${kind}`, false)],
    schemas: [`Modal.${kind}`],
    returns:
      kind === "confirm"
        ? "Promise<boolean>"
        : `Promise<${kind === "dialog" ? "Record<string, string | number | boolean | undefined>" : kind === "text" ? "string" : "number"} | null>`,
    example: `kit.ui.button("Open", async () => {\n  const value = await kit.ui.modal.${kind}(${config});\n  if (value === null || value === false) return;\n  console.log(value);\n});`,
    notes: words(
      "Confirm cancellation returns false; other cancellations return null. Optional blank scalar input also returns null; in a form the field may be undefined. Titles/labels must be nonblank. Validation stays in the dialog; malformed schemas reject before opening. min ≤ max, unique select values containing the default; 1–64 form fields with names matching [a-zA-Z][a-zA-Z0-9_]*. No functions in schemas. Stop/navigation closes the dialog. Host requests are serial, so finish a dialog before awaiting later host work.",
      "Abbrechen liefert bei confirm false, sonst null. Ein leeres optionales Einzelfeld liefert ebenfalls null; im Formular kann das Feld undefined sein. Titel/Beschriftungen dürfen nicht leer sein. Validierungsfehler bleiben im Dialog; ungültige Schemas werden vor dem Öffnen abgelehnt. min ≤ max, eindeutige Select-Werte einschließlich Default; 1–64 Formularfelder mit Namen gemäß [a-zA-Z][a-zA-Z0-9_]*. Keine Funktionen im Schema. Stoppen/Navigation schließt den Dialog. Host-Aufrufe laufen sequenziell; erst den Dialog beenden, bevor weitere Host-Arbeit abgewartet wird.",
    ),
  };
}
for (const method of ["open", "openMultiple", "openFolder", "save"]) {
  methodDetails[`file.${method}`] = {
    args:
      method === "openFolder"
        ? []
        : method === "save"
          ? [
              arg("blobOrText", "Blob | string", "Download content, at most 16 MiB.", "Downloadinhalt, höchstens 16 MiB."),
              arg("filename", "string", "Filename without path, 1–180 characters.", "Dateiname ohne Pfad, 1–180 Zeichen."),
            ]
          : [options("FileOpenOptions")],
    schemas: method === "open" || method === "openMultiple" ? ["FileOpenOptions"] : [],
    returns: method === "open" ? "Promise<File | null>" : method === "save" ? "Promise<null>" : "Promise<File[]>",
    example:
      method === "save"
        ? 'await kit.file.save("name;amount\\nExample;120", "example.csv");'
        : `const files = await kit.file.${method}(${method === "openFolder" ? "" : '{ accept: ".csv,text/csv" }'});\nconsole.log(files);`,
    notes: words(
      "Picker cancellation returns null for open and [] for multiple/folder. accept is a picker filter, not file validation. Folder files have webkitRelativePath. Calls require browser support; failures reject. save requests the download immediately, but browser policy decides whether it proceeds; it does not wait for a disk write. Stop ignores stale replies.",
      "Abbrechen liefert bei open null, bei multiple/folder []. accept filtert die Auswahl und validiert keine Dateiinhalte. Ordnerdateien haben webkitRelativePath. Browserunterstützung ist nötig; Fehler lehnen ab. save fordert den Download sofort an; Browserregeln entscheiden über die Ausführung, der Schreibvorgang auf Platte wird nicht abgewartet. Stoppen ignoriert veraltete Antworten.",
    ),
  };
}
methodDetails["sheet.fromCsv"] = {
  args: [
    arg(
      "fileOrText",
      "File | string",
      "CSV with a header row; empty lines skipped, values stay strings.",
      "CSV mit Kopfzeile; Leerzeilen werden übersprungen, Werte bleiben Strings.",
    ),
    arg(
      "options.delimiter",
      "string",
      "Papa Parse delimiter; omitted means auto-detect.",
      "Papa-Parse-Trennzeichen; weglassen für automatische Erkennung.",
      true,
      "auto",
    ),
  ],
  returns: "Promise<Record<string, string>[]>",
  example: 'const rows = await kit.sheet.fromCsv("name;amount\\nExample;120", { delimiter: ";" });\nconsole.log(rows);',
  notes: words(
    "First CSV parser error rejects. No automatic numeric/date conversion.",
    "Der erste CSV-Parserfehler lehnt ab. Keine automatische Zahlen-/Datumskonvertierung.",
  ),
};
methodDetails["sheet.toCsv"] = {
  args: [
    arg("rows", "Record<string, unknown>[]", "Rows to serialize.", "Zu serialisierende Zeilen."),
    arg("options.delimiter", "string", "Column separator.", "Spaltentrennzeichen.", true, '";"'),
    arg("options.bom", "boolean", "Prefix UTF-8 BOM.", "UTF-8-BOM voranstellen.", true, "true"),
  ],
  returns: "string",
  example: 'const csv = kit.sheet.toCsv([{ name: "Example", amount: "12,34" }]);\nconsole.log(csv);',
  notes: words(
    "CRLF line endings and formula escaping are always enabled. Invalid CSV options throw. Formatting numbers is the author's responsibility.",
    "CRLF-Zeilenenden und Schutz vor Tabellenformeln sind immer aktiv. Ungültige CSV-Optionen werfen Fehler. Zahlenformatierung ist Aufgabe des Autors.",
  ),
};
for (const ns of ["store", "opfs"])
  for (const method of ns === "store" ? ["get", "set", "delete", "keys"] : ["read", "write", "delete", "list"]) {
    const listing = method === "keys" || method === "list",
      writing = method === "set" || method === "write",
      key = ns === "store" ? '"example"' : '"exports/example.txt"';
    methodDetails[`${ns}.${method}`] = {
      args: listing
        ? []
        : [
            path(ns === "store" ? "key" : "path"),
            ...(writing
              ? [
                  arg(
                    "value",
                    ns === "store" ? "JSON" : "Blob | string",
                    "Replacement value, up to 16 MiB; not a merge.",
                    "Ersatzwert, bis 16 MiB; kein Zusammenführen.",
                  ),
                ]
              : []),
          ],
      returns: listing
        ? "Promise<string[]>"
        : method === "get"
          ? "Promise<JSON | null>"
          : method === "read"
            ? "Promise<File | null>"
            : "Promise<null>",
      notes: localNotes,
      example: `console.log(await kit.${ns}.${method}(${listing ? "" : key + (writing ? (ns === "store" ? ", { count: 1 }" : ', "Example"') : "")}));`,
    };
  }
methodDetails["pdf.text"] = {
  args: [
    arg(
      "file",
      "Blob | File",
      "PDF up to 16 MiB, 1000 pages; extracted text up to 16 MiB.",
      "PDF bis 16 MiB, 1000 Seiten; extrahierter Text bis 16 MiB.",
    ),
    arg(
      "options.onProgress",
      "(page: number, total: number) => void",
      "Called after each extracted page, 1-based page numbers.",
      "Nach jeder ausgelesenen Seite, Seitennummern ab 1.",
      true,
    ),
  ],
  returns: "Promise<{page: number, text: string}[]>",
  example:
    'const file = await kit.file.open({ accept: ".pdf,application/pdf" });\nif (file) console.log(await kit.pdf.text(file, { onProgress: (page, total) => console.log(page, total) }));',
  notes: words(
    "No OCR or upload. Unsupported, encrypted, damaged or oversized PDFs reject; Stop terminates extraction. Text order follows PDF.js and is not a table parser.",
    "Keine OCR und kein Upload. Nicht unterstützte, verschlüsselte, beschädigte oder zu große PDFs lehnen ab; Stoppen beendet das Auslesen. Die Textreihenfolge folgt PDF.js; dies ist kein Tabellenparser.",
  ),
};
const currency = arg(
  "currency",
  "string",
  "Supported uppercase currency, e.g. EUR; Intl determines precision.",
  "Unterstützte Währung in Großbuchstaben, etwa EUR; Intl bestimmt Nachkommastellen.",
);
const rounding = arg(
  "options.rounding",
  '"half-up" | "half-even" | "toward-zero"',
  "Tie away from zero / tie to even / truncate.",
  "Gleichstand von null weg / zur geraden Zahl / abschneiden.",
);
const locale = arg("options.locale", "string", "Explicit supported locale, e.g. de-DE.", "Explizite unterstützte Sprache, etwa de-DE.");
const m = 'kit.money.fromMinor(1200, "EUR")';
const moneyExamples: Record<string, string> = {
  fromMinor: '1200, "EUR"',
  fromDecimal: '"12.00", { currency: "EUR" }',
  toDecimal: m,
  currencyDigits: '"EUR"',
  parse: '"1.234,56", { locale: "de-DE", currency: "EUR" }',
  format: `${m}, { locale: "de-DE" }`,
  add: `${m}, ${m}`,
  subtract: `${m}, ${m}`,
  sum: `[${m}]`,
  compare: `${m}, ${m}`,
  multiply: `${m}, "1.5", { rounding: "half-up" }`,
  divide: `${m}, "3", { rounding: "half-even" }`,
  taxFromNet: `${m}, { percent: "19", rounding: "half-up" }`,
  taxFromGross: `${m}, { percent: "19", rounding: "half-up" }`,
  allocate: `${m}, [1, 2]`,
};
for (const [method, call] of Object.entries(moneyExamples)) {
  const args: Argument[] =
    method === "fromMinor"
      ? [
          arg(
            "amount",
            "number",
            "Signed safe integer minor units, e.g. cents.",
            "Vorzeichenbehaftete sichere Ganzzahl in Untereinheiten, etwa Cent.",
          ),
          currency,
        ]
      : method === "currencyDigits"
        ? [currency]
        : method === "fromDecimal" || method === "parse"
          ? [
              decimal(method === "parse" ? "text" : "decimal"),
              { ...currency, name: "options.currency" },
              ...(method === "parse" ? [locale] : []),
              { ...rounding, optional: true, default: "reject excess precision" },
            ]
          : method === "sum"
            ? [
                arg("values", "Money[]", "Same currency; [] needs options.currency.", "Gleiche Währung; [] benötigt options.currency."),
                { ...currency, name: "options.currency", optional: true, default: "first value" },
              ]
            : method === "add" || method === "subtract" || method === "compare"
              ? [money("a"), money("b")]
              : method === "multiply" || method === "divide"
                ? [money(), decimal(method === "multiply" ? "factor" : "divisor"), rounding]
                : method.startsWith("tax")
                  ? [
                      money(),
                      arg(
                        "options.percent",
                        "string",
                        "Nonnegative decimal percentage; no rate lookup.",
                        "Nichtnegativer Dezimal-Prozentsatz; keine Ermittlung von Steuersätzen.",
                      ),
                      rounding,
                    ]
                  : method === "allocate"
                    ? [
                        money(),
                        arg(
                          "weights",
                          "(number | string)[]",
                          "Nonnegative safe integers or decimal strings; positive total.",
                          "Nichtnegative sichere Ganzzahlen oder Dezimalstrings; positive Summe.",
                        ),
                      ]
                    : [money(), ...(method === "format" ? [locale] : [])];
  methodDetails[`money.${method}`] = {
    args,
    returns:
      method === "format" || method === "toDecimal"
        ? "string"
        : method === "currencyDigits"
          ? "number"
          : method === "compare"
            ? "-1 | 0 | 1"
            : method.startsWith("tax")
              ? "{net: Money, tax: Money, gross: Money}"
              : method === "allocate"
                ? "Money[]"
                : "Money",
    example: `console.log(kit.money.${method}(${call}));`,
    notes: words(
      "Synchronous; invalid input, mixed currencies and unsafe results throw. divide rejects zero. Parsing is strict and accepts no currency symbols; parse uses locale digits/grouping, fromDecimal uses a dot. Allocation preserves the exact total, ties follow input order. No exchange conversion. No persistence or network effects.",
      "Synchron; ungültige Eingaben, gemischte Währungen und unsichere Ergebnisse werfen Fehler. divide lehnt null als Divisor ab. Parsing ist strikt und erlaubt keine Währungssymbole; parse nutzt lokale Ziffern/Gruppierung, fromDecimal den Punkt. Aufteilung erhält die exakte Summe, Gleichstände folgen der Eingabereihenfolge. Keine Währungsumrechnung. Keine Speicher- oder Netzwerkeffekte.",
    ),
  };
}
const dbNotes = words(
  "Requires Use access and both global rsql and this app's database enabled. Schema mutations require App Admin. One shared database per app; all Use users see the same rows. No automatic row permissions. Calls reject on permission, validation, unavailable server, limits or stale generation after reset; restart on stale generation. Writes are not retried. A failed/aborted request may have committed: inspect before repeating. Use simple sequential writes for single-user tools; read-then-write is not atomic.",
  "Benötigt Use-Zugriff sowie globales rsql und eine aktivierte App-Datenbank. Schemaänderungen benötigen App-Admin. Eine gemeinsame Datenbank pro App; alle Use-Nutzer sehen dieselben Zeilen. Keine automatischen Zeilenrechte. Fehlende Rechte, Validierung, unerreichbarer Server, Limits oder eine veraltete Generation nach Reset lehnen ab; bei veralteter Generation neu starten. Keine Schreib-Retries. Ein fehlgeschlagener/abgebrochener Aufruf kann bereits geschrieben haben: vor Wiederholung prüfen. Für Ein-Personen-Werkzeuge einfache sequenzielle Schreibvorgänge nutzen; Lesen und anschließendes Schreiben sind nicht atomar.",
);
const row = arg(
  "row",
  "Record<string, JSON>",
  "Column values; omit managed id, created_at, updated_at. Update changes supplied columns only.",
  "Spaltenwerte; verwaltete id, created_at, updated_at weglassen. Update ändert nur übergebene Spalten.",
);
const id = arg("id", "number", "Positive integer id returned by rsql.", "Positive ganzzahlige ID aus rsql.");
Object.assign(methodDetails, {
  "db.tables.list": { args: [], returns: "Promise<Record<string, unknown>[]>", example: "console.log(await kit.db.tables.list());" },
  "db.tables.create": {
    args: [options("TableDefinition", false)],
    schemas: ["TableDefinition"],
    returns: "Promise<{created: string, type: string}>",
    example:
      'console.log(await kit.db.tables.create({ name: "example_tasks", columns: [{ name: "title", type: "text", not_null: true }] }));',
  },
  "db.tables.delete": {
    args: [name()],
    returns: "Promise<null>",
    example:
      'if (await kit.ui.modal.confirm({ title: "Delete table", message: "Delete example_tasks and all its rows?", variant: "danger" })) {\n  await kit.db.tables.delete("example_tasks");\n}',
  },
  "db.table": {
    args: [name()],
    returns: "TableHandle",
    example: 'const tasks = kit.db.table("example_tasks");\nconsole.log(await tasks.rows.list({ limit: 10 }));',
  },
  "db.query": {
    args: [
      text("sql"),
      arg(
        "params",
        "JSON[]",
        "Positional ? parameters, at most 1000 values; no string interpolation.",
        "Positionale ?-Parameter, höchstens 1000 Werte; keine String-Interpolation.",
        true,
        "[]",
      ),
    ],
    returns: "Promise<{data: Record<string, unknown>[] }>",
    example: 'console.log(await kit.db.query("SELECT * FROM example_tasks WHERE title = ?", ["Example"]));',
  },
  "db.importData": {
    args: [
      name("table"),
      arg(
        "rows",
        "Record<string, JSON>[]",
        "Up to 16 MiB JSON. [] completes with zero writes. Managed columns are rejected.",
        "Bis 16 MiB JSON. [] endet ohne Schreibvorgänge. Verwaltete Spalten werden abgelehnt.",
      ),
      options("ImportOptions & {onProgress?: (progress: ImportProgress) => void}"),
    ],
    schemas: ["ImportOptions"],
    returns: 'Promise<{confirmedRows: number, totalRows: number, status: "complete" | "cancelled" | "failed" | "unknown", error?: string}>',
    example:
      'const result = await kit.db.importData("example_tasks", [{ title: "Example" }], { createTable: true, onProgress: progress => console.log(progress) });\nconsole.log(result);',
    notes: words(
      "Validates before inserting sequential batches (≤1000 rows and <2 MiB each). createTable defaults false; columns omitted means infer text/integer/real/boolean/json (date strings remain text). Existing schema is not changed. notify defaults true and supplies the cancel action. Progress is {confirmedRows,totalRows,phase: validating|writing}. confirmedRows counts acknowledged batches only. failed means a definite failure, unknown means a write may have committed; do not replay blindly. cancelled preserves previous batches. Preflight errors can reject instead of returning a result. No batch replay or durable resume.",
      "Validiert vor dem Einfügen sequenzieller Batches (≤1000 Zeilen und <2 MiB je Batch). createTable ist standardmäßig false; ohne columns werden text/integer/real/boolean/json abgeleitet (Datumsstrings bleiben text). Bestehende Schemas bleiben unverändert. notify ist standardmäßig true und stellt Abbrechen bereit. Fortschritt: {confirmedRows,totalRows,phase: validating|writing}. confirmedRows zählt nur bestätigte Batches. failed bedeutet einen eindeutigen Fehler, unknown einen möglicherweise bereits geschriebenen Batch; nicht blind wiederholen. cancelled erhält vorherige Batches. Vorprüfungsfehler können das Promise ablehnen. Kein Batch-Replay oder dauerhaftes Fortsetzen.",
    ),
  },
} satisfies Record<string, Detail>);
export const tableMethods = {
  "schema.get": {
    args: [],
    returns: "Promise<Record<string, unknown>>",
    example: 'console.log(await kit.db.table("example_tasks").schema.get());',
  },
  "schema.update": {
    args: [options("SchemaChanges", false)],
    schemas: ["SchemaChanges"],
    returns: "Promise<{updated: boolean}>",
    example: 'await kit.db.table("example_tasks").schema.update({ add_columns: [{ name: "done", type: "boolean" }] });',
  },
  "rows.list": {
    notes: words("data is always an array, including [] when no rows match. Pagination metadata is preserved.", "data ist immer ein Array, auch [] ohne Treffer. Metadaten zur Seiteneinteilung bleiben erhalten."),
    args: [options("RowQuery")],
    schemas: ["RowQuery"],
    returns:
      "Promise<{data: Record<string, unknown>[], meta?: {limit: number, offset: number, total_count?: number, filter_count?: number}}>",
    example: 'console.log(await kit.db.table("example_tasks").rows.list({ title: "eq.Example", order: "id.asc", limit: 10, offset: 0 }));',
  },
  "rows.get": {
    args: [id],
    returns: "Promise<Record<string, unknown>>",
    example:
      'const { data } = await kit.db.table("example_tasks").rows.list({ limit: 1 });\nif (data.length) console.log(await kit.db.table("example_tasks").rows.get(data[0].id));',
  },
  "rows.insert": {
    args: [{ ...row, name: "rowOrRows", type: "Record<string, JSON> | Record<string, JSON>[]" }],
    returns: "Promise<{data: Record<string, unknown>[]} | {inserted: number}>",
    example: 'console.log(await kit.db.table("example_tasks").rows.insert({ title: "Example" }));',
  },
  "rows.update": {
    args: [id, row],
    returns: "Promise<{data: Record<string, unknown>[]} | {updated: number}>",
    example:
      'const tasks = kit.db.table("example_tasks");\nconst { data } = await tasks.rows.list({ limit: 1 });\nif (data.length) await tasks.rows.update(data[0].id, { title: "Changed" });',
  },
  "rows.delete": {
    args: [id],
    returns: "Promise<{data: Record<string, unknown>[]} | {deleted: number}>",
    example:
      'const tasks = kit.db.table("example_tasks");\nconst { data } = await tasks.rows.list({ limit: 1 });\nif (data.length && await kit.ui.modal.confirm({ title: "Delete row", message: "Delete this example row?", variant: "danger" })) await tasks.rows.delete(data[0].id);',
  },
} satisfies Record<string, Detail>;
for (const [method, details] of Object.entries(methodDetails))
  if (method.startsWith("db."))
    details.notes = details.notes ? words(`${dbNotes.en} ${details.notes.en}`, `${dbNotes.de} ${details.notes.de}`) : dbNotes;
export const databaseNotes = dbNotes;
const control = UiNode.pick({ id: true, description: true, disabled: true, loading: true, icon: true }).partial({ id: true });
const button = control.extend({ variant: UiNode.shape.variant });
// These are documentation projections, not new runtime validators. Nested values come from the owning schemas.
export const referenceSchemas = {
  ButtonOptions: z.toJSONSchema(button, { io: "input" }),
  InputOptions: z.toJSONSchema(control.extend({ value: UiNode.shape.value, placeholder: UiNode.shape.placeholder }), { io: "input" }),
  SelectOption: z.toJSONSchema(SelectOption, { io: "input" }),
  TableOptions: z.toJSONSchema(
    UiNode.pick({ rowKey: true, id: true, label: true, empty: true })
      .partial({ id: true })
      .extend({ columns: z.array(UiColumn).max(64) }),
    { io: "input" },
  ),
  ListOptions: z.toJSONSchema(
    z.object({
      title: z.string().max(16000),
      description: UiNode.shape.description,
      empty: UiNode.shape.empty,
      id: UiNode.shape.id.optional(),
    }),
    { io: "input" },
  ),
  ListItem: z.toJSONSchema(
    UiNode.shape.items
      .unwrap()
      .element.omit({ action: true })
      .extend({
        action: z.object({ id: z.string() }).describe("UIHandle, including its worker methods; not a JSON object or callback.").optional(),
      }),
    { io: "input" },
  ),
  LinkOptions: z.toJSONSchema(LinkOptions.extend({ icon: UiNode.shape.icon.optional() }), { io: "input" }),
  LinkButtonOptions: z.toJSONSchema(button.extend(LinkOptions.shape), { io: "input" }),
  MarkdownOptions: z.toJSONSchema(UiNode.pick({ id: true, headingScale: true }).partial({ id: true }), { io: "input" }),
  LayoutOptions: z.toJSONSchema(UiNode.pick({ gap: true }), { io: "input" }),
  FilePickerOptions: z.toJSONSchema(control.extend({ accept: FileOpenOptions.shape.accept, multiple: z.boolean().default(false) }), {
    io: "input",
  }),
  FileOpenOptions: z.toJSONSchema(FileOpenOptions, { io: "input" }),
  ...Object.fromEntries(
    ModalRequest.options.map((schema) => {
      const { kind, ...shape } = schema.shape;
      return [`Modal.${kind.value}`, z.toJSONSchema(z.object(shape).strict(), { io: "input" })];
    }),
  ),
  ChartOptions: z.toJSONSchema(ChartOptions, { io: "input" }),
  TableDefinition: z.toJSONSchema(z.object({ name: DbName, columns: z.array(DbColumn).min(1).max(1000) }), { io: "input" }),
  SchemaChanges: z.toJSONSchema(DatabaseRequest.options[2].shape.changes, { io: "input" }),
  RowQuery: z.toJSONSchema(DatabaseRequest.options[5].shape.query, { io: "input" }),
  ImportOptions: z.toJSONSchema(ImportOptions, { io: "input" }),
};
export const handleMethods = [
  [
    "set(value)",
    "void",
    "Text/label for text, status, button, links, section; string value for input/select/markdown; fraction for progress; full config for chart; complete items/rows for list/table. Unsupported kinds throw. No input callback.",
    "Text/Beschriftung für text, status, button, Links, section; Stringwert für input/select/markdown; Anteil für progress; vollständige Konfiguration für chart; komplette Einträge/Zeilen für list/table. Nicht unterstützte Typen werfen Fehler. Kein Eingabe-Callback.",
  ],
  [
    "upsert(items)",
    "void",
    "List/table only. Complete replacement per key, not a partial merge. Preserve position, append new keys. Tables need rowKey. Duplicate/missing keys reject atomically.",
    "Nur list/table. Vollständiger Ersatz pro Schlüssel, kein partielles Zusammenführen. Position erhalten, neue Schlüssel anhängen. Tabellen benötigen rowKey. Doppelte/fehlende Schlüssel lehnen atomar ab.",
  ],
  [
    "remove(ids?)",
    "void",
    "List/table only. Omitted or undefined clears visible data; [] does nothing; null is invalid. Unknown keys ignored. Tables need rowKey for nonempty ids. Never deletes storage, DB rows or handles.",
    "Nur list/table. Weglassen oder undefined leert sichtbare Daten; [] ändert nichts; null ist ungültig. Unbekannte Schlüssel ignorieren. Tabellen benötigen rowKey bei nichtleeren IDs. Löscht niemals Speicher, DB-Zeilen oder Handles.",
  ],
  [
    "getValue()",
    "string",
    "Read input/select value. Other nodes normally return an empty string. No side effect.",
    "Wert von input/select lesen. Andere Knoten liefern normalerweise einen leeren String. Keine Nebenwirkung.",
  ],
  [
    "setDescription(text)",
    "void",
    "Supporting text; string up to 16000 characters. Visibility depends on element type.",
    "Erklärungstext; String bis 16000 Zeichen. Sichtbarkeit hängt vom Elementtyp ab.",
  ],
  [
    "setColumns(columns)",
    "void",
    "Table columns: at most 64 {key:string,label:string,align?:left|center|right}; key/label up to 120 characters. Does not rewrite rows.",
    "Tabellenspalten: höchstens 64 {key:string,label:string,align?:left|center|right}; key/label bis 120 Zeichen. Ändert keine Zeilen.",
  ],
  [
    "setDisabled(boolean)",
    "void",
    "Disable input/action events; default false. Does not cancel a callback already running.",
    "Eingabe-/Aktionsereignisse deaktivieren; Standard false. Bricht keinen laufenden Callback ab.",
  ],
  [
    "setLoading(boolean)",
    "void",
    "Loading appearance and suppress callbacks; default false. Reset in finally after async work.",
    "Ladeanzeige und Callbacks unterdrücken; Standard false. Nach asynchroner Arbeit in finally zurücksetzen.",
  ],
  [
    "setState(state, description?)",
    "void",
    "ready|empty|loading|error. Omitted description preserves previous text. Tables start empty; set(rows) derives ready/empty. No persistence effect.",
    "ready|empty|loading|error. Ohne description bleibt der vorige Text erhalten. Tabellen starten empty; set(rows) leitet ready/empty ab. Keine Speicherwirkung.",
  ],
] as const;
export const chartExamples = [
  {
    kind: "line",
    series: [
      {
        label: "Trend",
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 4 },
        ],
      },
    ],
  },
  {
    kind: "scatter",
    series: [
      {
        label: "Samples",
        data: [
          { x: 1, y: 2 },
          { x: 2, y: 3 },
        ],
      },
    ],
  },
  { kind: "bar", data: [{ label: "Open", value: 3 }] },
  {
    kind: "pie",
    data: [
      { label: "Open", value: 3 },
      { label: "Done", value: 2 },
    ],
  },
  {
    kind: "donut",
    data: [
      { label: "Open", value: 3 },
      { label: "Done", value: 2 },
    ],
  },
  { kind: "sparkline", data: [1, 3, 2, 4] },
  { kind: "histogram", data: [1, 2, 2, 3, 5], bins: 3 },
  { kind: "boxplot", groups: [{ label: "Samples", values: [1, 2, 3, 4, 8] }] },
  { kind: "gauge", value: 42, min: 0, max: 100, unit: "%" },
  { kind: "barGauge", data: [{ label: "Storage", value: 42 }], max: 100 },
  { kind: "stat", label: "Open", value: 3, delta: -1 },
  { kind: "heatmap", data: [{ x: "Mon", y: "AM", value: 2 }] },
  { kind: "map", series: [{ label: "Places", data: [{ latitude: 48.4, longitude: 10, label: "Example" }] }] },
  {
    kind: "stateTimeline",
    rows: [
      {
        label: "Import",
        intervals: [
          { from: 0, to: 10, state: "working" },
          { from: 10, to: 12, state: "done" },
        ],
      },
    ],
  },
];
export const referenceNotes = {
  charts: words(
    "Kit validates ChartOptions and accepts no additional keys. All numbers are finite, strings ≤16000 characters. The sum of all array lengths, including nested series, is ≤1000. Formatter functions, custom HTML/CSS, links and resources are unavailable. set replaces the complete configuration; it does not merge. Theme, size and empty state belong to the shared UI. Invalid options throw synchronously. Array data is not persisted.\n\nEffective renderer defaults: smooth=true for line/sparkline; showOutliers=true for boxplot; legend=true for stateTimeline (using supplied states), otherwise flags default false. Series marker=circle, lineStyle=solid unless autoVariant selects a per-series style. Axes use linear scale and approximately 5 ticks, bounds from the data. Gauge min=0/max=100, barGauge item bounds override top-level bounds. innerRadius=0 for pie and 0.6 for donut. sizeRange=[3,12]. Histogram bins default to ceil(log2(n))+1, with constant samples in one bin. Category labels and heatmap bounds derive from data; a map without viewport fits its data. stat derives trend from a numeric delta. Missing error upper/lower values use symmetric errX/errY. Missing threshold colors use the theme palette. Missing labels/unit/optional data add no extra content. Padding defaults {top:16,right:16,bottom:32,left:40}; heatmap uses {36,16,32,54}, map {12,16,12,16}, stateTimeline {36,16,28,74}. Set options explicitly when a particular visual is required.",
    "Kit validiert ChartOptions und akzeptiert keine zusätzlichen Schlüssel. Alle Zahlen sind endlich, Strings ≤16000 Zeichen. Die Summe aller Arraylängen einschließlich verschachtelter Reihen ist ≤1000. Formatter-Funktionen, eigenes HTML/CSS, Links und Ressourcen sind nicht verfügbar. set ersetzt die gesamte Konfiguration und führt sie nicht zusammen. Theme, Größe und Leerzustand gehören zur gemeinsamen UI. Ungültige Optionen werfen synchron Fehler. Arraydaten werden nicht gespeichert.\n\nEffektive Renderer-Defaults: smooth=true für line/sparkline; showOutliers=true für boxplot; legend=true für stateTimeline (mit angegebenen states), sonst sind Flags standardmäßig false. Reihen nutzen marker=circle und lineStyle=solid, sofern autoVariant keinen Stil pro Reihe wählt. Achsen nutzen lineare Skalen und etwa 5 Teilstriche, Grenzen aus den Daten. Gauge min=0/max=100; bei barGauge überschreiben Eintragsgrenzen die globalen Grenzen. innerRadius=0 bei pie und 0.6 bei donut. sizeRange=[3,12]. Histogrammklassen sind standardmäßig ceil(log2(n))+1; konstante Stichproben liegen in einer Klasse. Kategoriebeschriftungen und Heatmapgrenzen folgen den Daten; Karten ohne viewport passen sich den Daten an. stat leitet trend aus numerischem delta ab. Fehlende obere/untere Fehlerwerte nutzen symmetrisches errX/errY. Fehlende Schwellenfarben nutzen die Theme-Palette. Fehlende Beschriftungen/Einheiten/optionale Daten ergänzen keinen Inhalt. Padding ist standardmäßig {top:16,right:16,bottom:32,left:40}; heatmap nutzt {36,16,32,54}, map {12,16,12,16}, stateTimeline {36,16,28,74}. Setze Optionen explizit, wenn eine bestimmte Darstellung nötig ist.",
  ),
  db: words(
    "RowQuery: column keys accept eq.value, neq.value, gt.value, gte.value, lt.value, lte.value, like.pattern, ilike.pattern, in.(a,b), is.null, is.true, is.false and not.<operator>. Use and/or groups, e.g. {and: '(amount.gte.10,amount.lte.20)'}, not repeated column keys for ranges. select controls projection/aggregates; order uses column.asc or column.desc; search searches text. limit defaults 50 (1–1000), offset defaults 0. Invalid filters reject; metadata may contain total_count/filter_count, and is optional for aggregate responses. Table schema is the rsql object containing columns; list tables returns rsql table objects (name and available diagnostics). Kit unwraps the client result, not an {ok,data} envelope.\n\nInsert accepts one row or an atomic batch of 1–1000 rows. Update is partial: omitted columns remain, null writes SQL null if permitted. Mutations return the rsql data/count response; table deletion returns null. Do not assume a missing get returns null: server errors reject. Individual requests have a 2 MiB body budget; results ≤16 MiB and ≤1000 rows.\n\nquery accepts one SELECT, positional ? parameters, an optional trailing semicolon; no comments, CTEs, writes or internal objects. Supported function names: count, sum, avg, min, max, total, abs, round, coalesce, nullif, ifnull, lower, upper, length, substr, substring, trim, ltrim, rtrim, date, datetime, time, strftime, julianday, unixepoch, json_extract, json_type, json_array_length, cast. SQLite validates expressions after this allowlist. Results beyond 1000 rows reject; use filtering/pagination. No raw write SQL, batch SQL, transaction, SSE or schema index API is exposed through kit.db.\n\nSchemaChanges: omitted changes preserve existing schema; drop_columns deletes column data. rename_columns maps old names to new names. id, created_at, updated_at are managed. JSON row keys are bounded to 63 characters and must refer to real writable columns. Use integer columns for money minor units.",
    "RowQuery: Spaltenschlüssel akzeptieren eq.value, neq.value, gt.value, gte.value, lt.value, lte.value, like.pattern, ilike.pattern, in.(a,b), is.null, is.true, is.false und not.<operator>. Nutze and/or-Gruppen, etwa {and: '(amount.gte.10,amount.lte.20)'}, statt wiederholter Spaltenschlüssel für Bereiche. select steuert Projektion/Aggregate; order nutzt column.asc oder column.desc; search durchsucht Text. limit ist standardmäßig 50 (1–1000), offset 0. Ungültige Filter lehnen ab; Metadaten können total_count/filter_count enthalten und fehlen bei Aggregaten gegebenenfalls. Das Tabellenschema ist das rsql-Objekt mit columns; Tabellenlisten liefern rsql-Tabellenobjekte (name und verfügbare Diagnosewerte). Kit entpackt das Clientergebnis; kein {ok,data}-Umschlag.\n\nInsert akzeptiert eine Zeile oder einen atomaren Batch mit 1–1000 Zeilen. Update ist partiell: fehlende Spalten bleiben, null schreibt SQL-null, falls erlaubt. Mutationen liefern die rsql-Daten-/Zählantwort; Tabellenlöschen liefert null. Ein fehlendes get liefert nicht garantiert null: Serverfehler lehnen ab. Einzelanfragen haben 2 MiB Bodybudget; Ergebnisse ≤16 MiB und ≤1000 Zeilen.\n\nquery akzeptiert ein SELECT, positionale ?-Parameter, ein optionales abschließendes Semikolon; keine Kommentare, CTEs, Schreibzugriffe oder internen Objekte. Erlaubte Funktionsnamen: count, sum, avg, min, max, total, abs, round, coalesce, nullif, ifnull, lower, upper, length, substr, substring, trim, ltrim, rtrim, date, datetime, time, strftime, julianday, unixepoch, json_extract, json_type, json_array_length, cast. SQLite validiert Ausdrücke nach dieser Erlaubnisliste. Ergebnisse über 1000 Zeilen lehnen ab; Filter/Paginierung nutzen. Kein rohes Schreib-SQL, Batch-SQL, Transaktionen, SSE oder Schemaindex-API über kit.db.\n\nSchemaChanges: fehlende Änderungen erhalten das Schema; drop_columns löscht Spaltendaten. rename_columns ordnet alte Namen neuen zu. id, created_at, updated_at sind verwaltet. JSON-Zeilenschlüssel sind auf 63 Zeichen begrenzt und müssen echte beschreibbare Spalten benennen. Gelduntereinheiten in integer-Spalten speichern.",
  ),
};
export const handleExamples: Record<string, string> = {
  set: 'const label = kit.ui.text("Before");\nlabel.set("After");',
  upsert:
    'const table = kit.ui.table({ rowKey: "id", columns: [{ key: "title", label: "Task" }] });\ntable.set([{ id: 1, title: "Before" }]);\ntable.upsert([{ id: 1, title: "After" }, { id: 2, title: "New" }]);',
  remove:
    'const list = kit.ui.list({ title: "Tasks" }, [{ id: "a", title: "First" }]);\nlist.remove([]); // no change\nlist.remove(["a"]); // one id\nlist.remove(); // all visible items',
  getValue: 'const field = kit.ui.input("Name", { value: "Ada" });\nconsole.log(field.getValue());',
  setDescription: 'const field = kit.ui.input("Name");\nfield.setDescription("Enter your name");',
  setColumns: 'const table = kit.ui.table({ columns: [] });\ntable.setColumns([{ key: "name", label: "Name", align: "left" }]);',
  setDisabled: 'const action = kit.ui.button("Continue", () => {});\naction.setDisabled(true);',
  setLoading:
    'const action = kit.ui.button("Save", async () => {\n  action.setLoading(true);\n  try { await kit.store.set("saved", true); }\n  finally { action.setLoading(false); }\n});',
  setState: 'const status = kit.ui.status("Ready");\nstatus.setState("loading", "Preparing data");',
};
