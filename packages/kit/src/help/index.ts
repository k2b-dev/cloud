import crud from "./examples/crud.script.js" with { type: "text" };
import en5 from "./documents/en/kit-sql-console.help.md" with { type: "text" };
import de5 from "./documents/de/kit-sql-console.help.md" with { type: "text" };
import { defineHelp } from "@k2b/cloud/server";
import { sdkHelp } from "./sdk";
import en0 from "./documents/en/kit-start.help.md" with { type: "text" };
import en1 from "./documents/en/kit-authoring.help.md" with { type: "text" };
import en2 from "./documents/en/kit-assistant.help.md" with { type: "text" };
import en3 from "./documents/en/kit-sharing.help.md" with { type: "text" };
import de0 from "./documents/de/kit-start.help.md" with { type: "text" };
import de1 from "./documents/de/kit-authoring.help.md" with { type: "text" };
import de2 from "./documents/de/kit-assistant.help.md" with { type: "text" };
import de3 from "./documents/de/kit-sharing.help.md" with { type: "text" };
import en4 from "./documents/en/kit-sdk-runtime.help.md" with { type: "text" };
import de4 from "./documents/de/kit-sdk-runtime.help.md" with { type: "text" };
function crudHelp(locale: "en" | "de") {
  const de = locale === "de";
  return `---
id: kit-crud-example
title: "${de ? "CRUD-Beispiel: gemeinsame Aufgabenliste" : "CRUD example: shared task list"}"
icon: ti ti-list-check
description: "${de ? "Vollständige RSQL-App mit Liste, Dialog, Filter und Fehlerbehandlung." : "Complete RSQL app with list, dialog, filter and error handling."}"
order: 191
---

${de ? "Nutze dieses Beispiel als Ausgangspunkt für kleine Datenbank-Apps. Lege eine neue App mit databaseEnabled an. Lies nur bei Abweichungen die Methodenreferenz." : "Start here for a small database app. Create a new app with databaseEnabled. Read method references only when your workflow differs."}

## ${de ? "Tabelle vorbereiten" : "Prepare the table"} {icon="database"}

${de ? "Ein App-Admin legt diese Tabelle einmal mit kit.database.write an; id und generation stammen aus app.create oder database.status. Keine Beispieldaten einfügen. Vorhandene Tabellen vorher prüfen. id, created_at und updated_at sind automatisch verwaltet. Die laufende App benötigt dadurch keine Admin-Rechte für die Tabellenerstellung." : "An app admin creates this table once with kit.database.write; use id and generation from app.create or database.status. Do not insert sample rows. Inspect existing tables before changing them. id, created_at and updated_at are managed automatically. The running app therefore does not need admin access to create tables."}

\`\`\`json
{"operation":"tables.create","name":"example_tasks","columns":[{"name":"title","type":"text","not_null":true},{"name":"status","type":"text","not_null":true}]}
\`\`\`

${de ? "Das JSON ist das request-Feld der Capability, kein Script-Code." : "This JSON is the capability request field, not script code."}

## main.script.js {icon="code"}

\`\`\`js
${crud}
\`\`\`

## ${de ? "Prüfen und anpassen" : "Verify and adapt"} {icon="check"}

${de ? "Validiere und speichere den vollständigen Stand. Starte die App und prüfe: leere Liste, Abbrechen, Pflichtfeld, Hinzufügen, Bearbeiten, Filter, Neuladen und Löschen mit Bestätigung. rows.list liefert ohne Treffer data: []. ui.select hat kein onChange; der Anwenden-Button liest getValue(). Bei Filtern bedeutet eine leere Liste nicht, dass die Datenbank leer ist." : "Validate and save the complete source. Launch and check: empty list, cancel, required field, add, edit, filter, reload and confirmed deletion. rows.list returns data: [] without matches. ui.select has no onChange; the Apply button reads getValue(). An empty filtered list does not mean the database is empty."}

${de ? "Andere Nutzer laden Änderungen mit Refresh. Gleichzeitige Änderungen desselben Datensatzes können sich überschreiben. Für die meist allein genutzte App keine Locks oder Queues ergänzen; bei echten Anforderungen an konkurrierende Änderungen zuerst das Konfliktverhalten festlegen." : "Other users load changes with Refresh. Concurrent edits to the same row can overwrite each other. Do not add locks or queues to a mostly single-user app; define conflict behavior first when concurrent editing is an actual requirement."}
`;
}
export const kitHelp = defineHelp({
  baseLocale: "en",
  documents: {
    en: [en0, en1, en2, en3, en4, en5, crudHelp("en"), ...sdkHelp("en")],
    de: [de0, de1, de2, de3, de4, de5, crudHelp("de"), ...sdkHelp("de")],
  },
});
