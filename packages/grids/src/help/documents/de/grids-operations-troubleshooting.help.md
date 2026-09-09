---
id: grids-operations-troubleshooting
title: Betrieb und Fehlerbehebung
icon: ti ti-bolt
description: Häufige Probleme ohne Vermutungen oder Arbeitsverlust untersuchen.
order: 150
---
Wenn sich Grids anders als erwartet verhält, bestimme zuerst die betroffene Oberfläche: Tabelle, Ansicht, Formular, Grids App, Dokument, Workflow oder Kombinierte Tabelle. Prüfe anschließend die aktuelle Abfrage, den Zustand und den Zugriff, bevor du die zugrunde liegenden Daten änderst.

Grids lehnt mehrdeutige Abfragen, veraltete Schreibvorgänge, ungültige Automatisierungen und nicht autorisierte Zugriffe ab, statt unbemerkt ein anderes Ergebnis zu wählen.

## Eine Ressource fehlt oder lässt sich nicht öffnen {icon="lifebuoy"}

Prüfe, ob sie im Papierkorb liegt oder deaktiviert ist, und bestimme anschließend die Berechtigungsgrenze. Unmittelbare Tabellen, Ansichten, Formulare, Dokumente und Workflows erfordern die Berechtigung ihrer Basis. Eine veröffentlichte Grids App erfordert eine eigene Lesefreigabe. Der Status als Cloud-Administrator umgeht den Grids-Zugriff auf normalen App-Seiten nicht.

Prüfe bei einer Grids App, ob die angeforderte Seite oder der Block zum veröffentlichten Snapshot gehört und die zugehörige `availableWhen`-Abfrage eine Zeile zurückgibt. Eine nicht verfügbare Ressource gibt absichtlich **Nicht gefunden** zurück und führt weder Datenquelle noch Aktion aus.

## Datensätze fehlen, sind doppelt oder falsch sortiert {icon="lifebuoy"}

Lies die aktive Suche, Filter, Quellansicht, den Modus für gelöschte Datensätze und `limit`. Die Suche berücksichtigt die aktuelle Abfrage und kann deshalb keine bereits herausgefilterten Datensätze finden.

Nutze exakte Filter für berechnete Werte, Lookups, Rollups, Dateien, Datumswerte und leere Werte. Ergänze eine aussagekräftige Sortierung, bevor du dich auf die Seitenreihenfolge oder `offset` verlässt. Seiten sind aktuelle Lesevorgänge; Änderungen zwischen Seitenanfragen können passende Datensätze verschieben.

Wenn eine Änderung nicht sichtbar ist, lade die Seite einmal neu. Live-Aktualisierungen behalten die aktuellen Abfrageregeln bei: Ein geänderter Datensatz kann berechtigt verschwinden, wenn er nicht mehr passt.

## Die Bearbeitung eines Datensatzes wurde abgelehnt {icon="table"}

Eine andere Person oder ein anderer Tab hat möglicherweise eine neuere Version gespeichert. Der Bearbeitungsdialog behält deine Eingaben. Wähle **Aktuellen Datensatz vergleichen**, prüfe die neuesten Werte und übernimm deine Änderungen ausdrücklich auf diese Version, bevor du erneut speicherst. Unveränderte Felder übernehmen ihren aktuellen Wert. So überschreibt ein älteres Formular keine neuere Arbeit unbemerkt.

Wenn die Meldung einen Änderungskontext verlangt, beantworte die unter **Tabelleneinstellungen → Datenintegrität** konfigurierten Fragen. Geschützte Aktualisierungen, Papierkorbaktionen und Wiederherstellungen können ohne die erforderlichen Antworten nicht fortfahren.

Wenn laut Meldung diese Quelle die Tabelle nicht ändern darf, muss eine Person mit Verwaltungsrechten für die Basis **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** öffnen und die passende Quelle erlauben. Basisoberfläche, API, CLI, Formulare, Workflows und Aktionen in Grids Apps folgen alle dieser Einstellung. Ein erneuter Versuch über einen anderen Client umgeht sie nicht.

Ändere bei API- oder CLI-Integrationen nur die Felder, die der Integration gehören. Sende die aktuelle positive Datensatzversion als `If-Match` oder `--if-version`, wenn eine veraltete Projektion keine neuere Bearbeitung überschreiben darf. Eine veraltete Version führt zu einem Konflikt; eine ungültig formatierte Version wird als Eingabe abgelehnt. Sind die normalisierten skalaren Werte und Relationswerte bereits aktuell, gibt Grids den Datensatz zurück, ohne eine neue Version, Durable-History-Revision, einen Audit-Eintrag oder ein Live-Ereignis anzulegen.

Nutze für einen Connector, der wiederholt dasselbe externe Objekt projiziert, den externen Datensatz-Upsert, statt ein sichtbares Feld zu durchsuchen und anschließend einen Datensatz zu erstellen. Anbieter, Anbieterkonto, Ressourcenart und externe ID bilden eine gemeinsame Bindung, bei der Groß- und Kleinschreibung berücksichtigt werden. Der Datensatz behält seine getrennte öffentliche Grids-ID. Verwende denselben Idempotenzschlüssel nur für die unsichere Wiederholung derselben Anfrage. Eine spätere Projektion verwendet einen neuen Schlüssel und die aktuelle Datensatzversion. Die Wiederverwendung eines Schlüssels mit anderer Eingabe, das Auslassen der Version bei einer vorhandenen Bindung oder das Senden einer veralteten Version führt zu einem Konflikt, ohne ein Duplikat zu erstellen. Das Ergebnis ist eine unveränderliche Quittung mit der öffentlichen Datensatz-ID und der von dieser Anfrage erzeugten Version. Lies den Datensatz getrennt, um die aktuellen Werte zu erhalten. Wiederholungsquittungen laufen nach 30 Tagen ab, die Identitätsbindung dagegen nicht.

Für bis zu 100 unabhängige Projektionen wendet `cld grids records upsert-external-batch` denselben Vertrag nacheinander an. Jedes Element besitzt einen eigenen Idempotenzschlüssel und ein geordnetes Ergebnis; ein Konflikt setzt erfolgreiche Nachbarn nicht zurück. Wenn die Anfrage unterbrochen wird, wiederhole den vollständigen unveränderten Batch: Bereits festgeschriebene Elemente werden erneut ausgegeben, verbleibende Elemente fortgesetzt. `records import` verhält sich anders: Der Befehl erstellt einen einzigen Alles-oder-nichts-Batch und ist nicht der wiederholungssichere Weg für externe Identitäten.

Bewahre bei einer fortsetzbaren Integration den letzten undurchsichtigen Cursor von `cld grids records changes` auf. Der Feed enthält öffentliche IDs für Basis, Tabelle und Datensatz sowie den festgeschriebenen Ereignistyp und die Datensatzversion, nicht aber einen Snapshot der Feldwerte. Lies jeden aktuellen Datensatz vor der Projektion erneut. Die Leseberechtigung für die Basis wird auf jeder Seite geprüft; `--table` grenzt nur diesen Basis-Feed ein. Cursor decken die letzten 30 Tage ab. Wenn ein Cursor abläuft, führe einen neuen vollständigen Datensatzscan durch und beginne an der neuen Feed-Position. Begrenze das automatisierte Aufholen mit `--all --max-events N`.

## Das Ergebnis einer Ansicht oder Grids App ist falsch {icon="layout"}

Öffne die Quellabfrage und prüfe sie, bevor du die Darstellung änderst:

- Nutze Filter vor der Gruppierung für Quelldatensätze und `having` für Aggregatzeilen.
- Prüfe, ob eine Diagrammquelle gruppiert ist und die erwarteten Aggregatwerte enthält.
- Prüfe, ob ein Widget eine gespeicherte Ansicht oder eigenes lokales GQL verwendet.
- Bedenke, dass reine Aggregat- und gruppierte Ergebnisse Zusammenfassungen und keine bearbeitbaren Datensätze sind.

Ein leeres Ergebnis unterscheidet sich von einem fehlgeschlagenen Ergebnis. Abfragediagnosen erklären Syntaxfehler, unbekannte Namen, inkompatible Operationen und Berechtigungsfehler.

## Ein Formular lässt sich nicht absenden {icon="forms"}

Prüfe, ob das Formular aktiv ist. Eine Person mit unmittelbarem Basiszugriff benötigt die Berechtigung Schreiben. Eine Eingabe über eine Grids App muss einen enthaltenen und verfügbaren Formularblock verwenden. Ein öffentliches Formular muss weiterhin für Token-Zugriff aktiviert sein und über seine aktuelle öffentliche URL geöffnet werden.

Prüfe Pflichtfelder, Regeln zum direkten Erstellen von Relationen und verborgene Werte. Personen, die das Formular absenden, können seine verborgenen Werte nicht überschreiben.

Wenn eine alte öffentliche URL nicht mehr funktioniert, nachdem der öffentliche Zugriff deaktiviert wurde, teile die neu erzeugte URL. Der alte Link wird absichtlich nicht wiederhergestellt.

## Eine Dokumentvorschau oder ein Download schlägt fehl {icon="lifebuoy"}

Wähle einen Vorschaudatensatz und prüfe die Vorlage anschließend in dieser Reihenfolge:

:::steps
1. **Quelle** zeigt das GQL, nachdem Werte des aktuellen Datensatzes aus Liquid eingesetzt wurden.
2. **Daten** zeigt die genauen Pfade, die Liquid zur Verfügung stehen.
3. **Vorschau** zeigt das gerenderte PDF.
:::

Korrigiere die Quelle, wenn Zeilen leer sind, und kopiere Pfade aus Daten, statt sie zu erraten. Prüfe bei Barcodes sowohl die Symbol-ID als auch einen nicht leeren, kompatiblen Wert. Teste mehrseitige Ausgaben mit ausreichend Zeilen und lege wiederholte Briefkopf- oder Seitenzahlinhalte in Kopf- und Fußzeilenteilen ab.

Neu generierte Dokumente laden ihre exakten gespeicherten PDF-Bytes herunter. Spätere Änderungen an Datensatz, Vorlage oder Renderer können ein vorhandenes Artefakt nicht umschreiben.

Ist das Ergebnis der Erzeugung unklar, lasse den Dialog offen und nutze **Erzeugung wiederholen**. Dadurch wird dieselbe Anfrage wiederholt, statt ein neues Dokument zu erzeugen. Beim Schließen geht dieser Wiederholungskontext verloren. Prüfe deshalb **Alle Dokumente**, bevor du einen neuen Versuch startest.

## Ein Workflow hat sich anders als erwartet verhalten {icon="route"}

Öffne die Ausführungsdetails, statt den Workflow sofort zu wiederholen. Prüfe Revision, Modus, Kanal, Eingaben, Schrittergebnisse, gespeicherte Ausgaben und Fehler. Die Ausführung hat die beim Start festgeschriebene Revision verwendet. Das ist nicht zwingend das derzeit auf dem Bildschirm sichtbare YAML. Öffne die verknüpfte Revision der Ausführung, um die tatsächlich ausgeführte Version zu lesen.

Kann eine Grids-App-Aktion ihr Ergebnis nicht abrufen, nutze **Status prüfen**, solange die Seite geöffnet bleibt. Das verfolgt den vorhandenen Vorgang, statt einen weiteren Workflow zu starten. Ein Statusfehler bedeutet nicht, dass der Workflow fehlgeschlagen ist.

Ein `dryRun` zeichnet vorhergesagte Auswirkungen auf, führt aber keine Schreibvorgänge oder externen Anfragen aus. Eine Wiederholung mit `execute` sollte einen bewusst gewählten Idempotenzschlüssel verwenden. Empfänger externer HTTP-Anfragen sollten auch doppelte Anfragen sicher verarbeiten.

Prüfe bei Scanner-, Bulk- und Grids-App-Aktionen nach einer Änderung der Workflow-Eingaben die gespeicherten Diagnosen der Ausführungsoption.

## Eine Workflow-Ausführung ist nie erschienen {icon="route"}

Eine automatische Ausführung existiert nur, wenn die veröffentlichte Revision des Workflows auf das Ereignis gewartet hat. Wenn nichts darauf gewartet hat, gibt es keine fehlgeschlagene Ausführung zum Öffnen, sondern überhaupt keine Ausführung. Prüfe die Bedingungen der Reihe nach:

:::steps
1. **Aktiviert:** Ein deaktivierter Workflow lehnt jede `execute`-Ausführung ab, einschließlich Zeitplänen und Datensatzereignissen.
2. **Veröffentlicht:** Der Trigger muss im veröffentlichten YAML stehen. Das Bearbeiten der Quelle im Editor ohne Speichern ändert nicht, was ausgelöst wird.
3. **Passender Trigger:** Vergleiche Datensatzereignis, optionale Tabellenbeschränkung und Filter mit deiner Änderung. Vergleiche Cron-Ausdruck und Zeitzone mit dem erwarteten Zeitpunkt.
4. **Aktivierungszeitraum:** Eine Datensatzänderung wird nur erfasst, wenn sie nach der Aktivierung des Triggers stattgefunden hat. Das Aktivieren des Workflows oder Veröffentlichen eines geänderten Datensatzereignis-Triggers startet diesen Zeitraum neu. Frühere Änderungen werden nicht erneut abgespielt.
5. **Verpasster Zeitplan:** Ein Zeitpunkt, der verstreicht, während Grids nicht verfügbar ist, wird übersprungen und später nicht nachgeholt. Der nächste Zeitpunkt läuft normal.
6. **Berechtigung der verantwortlichen Person:** Zeitpläne und Datensatzereignisse laufen als verantwortliche Person des Workflows. Wenn sie keine Schreibberechtigung für die Basis mehr besitzt oder einen Datensatz nicht lesen kann, den der Trigger an eine Eingabe bindet, wird der Aufruf abgelehnt, bevor eine Ausführung entsteht.
:::

Wenn alle sechs Bedingungen erfüllt sind und weiterhin nichts erscheint, bitte eine Person mit Cloud-Administrationsrechten, **Observability → Workflows** zu prüfen. Dort werden aufgezeichnete Ereignisse angezeigt, aus denen keine Ausführung entstand.

## Eine Workflow-Ausführung benötigt Aufmerksamkeit {icon="alert-triangle"}

Plattformadministratoren prüfen gespeicherte Zustellfehler mit `cld grids record-events failures <base-id> --json`. Weitere Seiten liest du mit dem zurückgegebenen `nextOffset` über `--offset`. Nach Behebung der Ursache spielt `cld grids record-events replay <base-id> <failure-id> --yes` ein gestopptes Ereignis mit seinen ursprünglichen Daten erneut ein. Verwende die genaue Fehler-UUID aus der Liste. Die Annahme bestätigt noch keine abgeschlossene Verarbeitung; Base-Admin-Zugriff allein erlaubt diese Betreiberaktion nicht.

`needs_attention` ist kein Fehler. Der Status bedeutet, dass ein Schritt etwas außerhalb von Grids ausgeführt hat und nicht festgestellt werden kann, ob es angekommen ist. In der Praxis betrifft das eine `httpRequest`, die den Prozess verlassen hat, ohne dass eine vollständige Antwort zurückkam. Grids wiederholt den Schritt bewusst nicht und bezeichnet ihn nicht als fehlgeschlagen: Eine Wiederholung kann eine empfangende Stelle doppelt belasten, und die Bezeichnung als Fehler würde behaupten, dass die Anfrage nicht angekommen ist.

Prüfe im empfangenden System, ob die Anfrage angekommen ist, und entscheide anschließend. Wenn sie nicht angekommen ist, starte eine neue Ausführung. Wenn sie angekommen ist, ist keine weitere Aktion erforderlich; die Ausführung bleibt als Aufzeichnung des Vorgangs erhalten. Die Ausführungsdetails können diese Frage nicht beantworten. Genau deshalb wurde der Vorgang für eine Person angehalten.

Datensatzänderungen, generierte Dokumente und versendete E-Mails enden niemals in diesem Zustand. Diese Schritte werden durch die Unterbrechung entweder rückgängig gemacht oder können sicher fortgesetzt werden.

## Ein Testlauf meldet ein unbestimmtes Ergebnis {icon="lifebuoy"}

Ein Testlauf endet unbestimmt, wenn der Plan nicht entschieden werden konnte, nicht wenn ein Fehler aufgetreten ist. Die Ausführung erscheint als `failed` mit einem Testlauf-Fehlercode. Der nicht planbare Schritt enthält die Begründung.

Zwei Ursachen erklären die meisten Fälle. Ein Schritt, der eine gelöschte, mehrdeutige oder für die Ausführungsidentität unzugängliche Vorlage, Tabelle, ein Feld oder einen Datensatz benennt, nennt diese Referenz als Grund. Unabhängig davon macht eine während der Planung nicht auswertbare Bedingung ein `if` oder `switch` unentscheidbar. Der Testlauf plant dann **jeden** Zweig und kennzeichnet den Kontrollschritt. Lies diese Zweige als Alternativen und nicht als Arbeit, die vollständig ausgeführt wird.

Korrigiere die genannte Referenz. Akzeptiere bei einem unentscheidbaren Zweig, dass ein Plan ihn nicht festlegen kann, und prüfe das Verhalten stattdessen mit einer kleinen tatsächlichen Ausführung.

## Eine Kombinierte Tabelle benötigt Aufmerksamkeit {icon="lifebuoy"}

Eine Kombinierte Tabelle schließt im Fehlerfall, wenn eine veröffentlichte Quelle, Zuordnung oder Quellenberechtigung nicht mehr gültig ist. Sie gibt kein kleineres Teilergebnis zurück.

Öffne **Kombinierte Daten**, prüfe die Diagnosen der betroffenen Quelle und Felder, repariere den Entwurf, validiere ihn und veröffentliche eine vollständige neue Revision. Eine widerrufene Quelle muss vor der erneuten Veröffentlichung wieder autorisiert werden.

## Dateien, Exporte und große Ergebnisse {icon="paperclip"}

Dateien folgen der Berechtigungsgrenze der zugehörigen Basis oder der exakten veröffentlichten Capability der Grids App. Speichere Fakten, die Personen suchen oder filtern müssen, in normalen Feldern und nicht nur in einem Dateinamen.

Exporte und Ergebnisseiten laden Daten seitenweise. Eine Abfrage ohne `limit` kann alle passenden Zeilen durchlaufen; ein `limit` begrenzt bewusst das vollständige Ergebnis. Nutze begrenzte Exporte und CLI-Optionen für `--max-rows`, wenn ein automatisierter Prozess sein eigenes Maximum durchsetzen muss.

:::note Fehlerkontext erhalten
Bewahre vor dem Bearbeiten einer Abfrage, Vorlage oder eines Workflows die Diagnose und die zugehörige Eingabe auf. Ein genauer Fehler zusammen mit der aktiven Quelle ist hilfreicher als ein Screenshot eines leeren Ergebnisses.
:::
