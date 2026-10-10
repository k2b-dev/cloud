---
id: grids-operations-troubleshooting
title: Betrieb und Fehlerbehebung
icon: ti ti-bolt
description: Untersuche häufige Probleme, ohne zu raten oder Arbeit zu verlieren.
order: 150
---
## Nach einer Strukturänderung der Base neu laden {icon="refresh"}

Ändert jemand anderes die Struktur des Bereichs, in dem du arbeitest, erscheint ein Hinweis **Neu laden**. Die Seite lädt nie von selbst neu, und das Speichern funktioniert weiter.

Struktur heißt: Name und Felder einer Tabelle, Quelle und Tabelle einer Ansicht oder die Definition einer App. Spaltenbreiten, Darstellungsmodi, Layouts von Ansichten, Feldreihenfolge und Änderungen an anderer Stelle der Base zeigen keinen Hinweis. Deine eigenen Änderungen in diesem Tab zeigen den Hinweis nie.

Offene Eingaben bleiben erhalten, bis du **Neu laden** bestätigst. Passt ein Speichern nicht mehr zur aktuellen Struktur, etwa ein Wert für ein gelöschtes Feld, lehnt der Server es mit einer klaren Meldung ab. Verlierst du den Zugriff oder wird eine aktive Ressource gelöscht, blendet Grids den betroffenen Arbeitsbereich sofort aus.

## Eine fehlende Ressource öffnen {icon="lifebuoy"}

Prüfe, ob die Ressource im Papierkorb liegt oder deaktiviert ist. Bestimme danach die Grenze:

- Tabellen, Ansichten, Formulare, Dokumente und Workflows im Arbeitsbereich der Base erfordern Zugriff auf die Base, zu der sie gehören.
- Eine veröffentlichte Grids App erfordert eigenen Zugriff **Offen**.
- Die Rolle als Cloud-Administration umgeht den Grids-Zugriff auf normalen App-Seiten nicht.

Prüfe bei einer Grids App, ob die angeforderte Seite oder der Block zum veröffentlichten Snapshot gehört. Prüfe außerdem, ob ihre `availableWhen`-Abfrage eine Zeile liefert. Eine nicht verfügbare Ressource liefert absichtlich einen Nicht-gefunden-Fehler und führt weder Datenquelle noch Aktion aus.

## Fehlende, doppelte oder falsch sortierte Datensätze finden {icon="lifebuoy"}

Lies die aktive Suche, die Filter, die Quellansicht, den Modus für gelöschte Datensätze und `limit`. Die Suche gilt innerhalb der aktuellen Abfrage. Sie findet deshalb keine Datensätze, die ein Filter schon entfernt hat.

Nutze exakte Filter für berechnete Werte, Lookups, Rollups, Dateien, Datumswerte und leere Werte. Ergänze eine aussagekräftige Sortierung, bevor du dich auf die Seitenreihenfolge oder `offset` verlässt. Jede Seite ist eine Live-Abfrage. Änderungen zwischen zwei Seitenaufrufen können passende Datensätze verschieben.

Datensatzergebnisse aktualisieren sich an Ort und Stelle, auch nach einer neuen Verbindung. Hat die Tabelle ein Suchfeld, wird dessen Lupe zu einem kleinen Ladesymbol, während Datensätze laden oder sich aktualisieren. Grids berechnet Filter, Sortierung und Summen neu, deshalb können Datensätze das Ergebnis verlassen. Offene Bearbeitungsdialoge behalten ihre Entwürfe und melden konkurrierende Änderungen. Schlägt eine automatische Aktualisierung fehl, wähle **Aktualisierungen verfügbar** neben der Datensatzanzahl, um es erneut zu versuchen. Stoppen die Live-Aktualisierungen, lade die Seite neu.

## Eine abgelehnte Bearbeitung speichern {icon="table"}

Eine andere Person oder ein anderer Tab kann eine neuere Version gespeichert haben. Der Bearbeitungsdialog behält deine Eingaben.

:::steps
1. Wähle **Aktuellen Datensatz vergleichen**.
2. Prüfe die neuesten Werte.
3. Übernimm deine Änderungen ausdrücklich auf diese Version.
4. Speichere erneut.
:::

Felder, die du nicht geändert hast, übernehmen ihren aktuellen Wert. So überschreibt ein älteres Formular keine neuere Arbeit unbemerkt.

Verlangt die Meldung einen Änderungskontext, beantworte die Fragen, die unter **Tabelleneinstellungen → Datenintegrität** konfiguriert sind. Geschützte Aktualisierungen, Papierkorbaktionen und Wiederherstellungen laufen ohne die erforderlichen Antworten nicht weiter.

Die Meldung kann sagen, dass diese Quelle die Tabelle nicht ändern darf. Dann muss eine Person mit Zugriff **Verwalten** auf die Base die passende Quelle unter **Tabelleneinstellungen → Datenintegrität → Datensatzänderungen** erlauben. Die Oberfläche der Base, API, CLI, Formulare, Workflows und Aktionen von Grids Apps folgen alle dieser Einstellung. Ein erneuter Versuch über einen anderen Client umgeht sie nicht.

### Sicher aus einer Integration schreiben

Ändere bei API- oder CLI-Integrationen nur die Felder, die der Integration gehören. Sende die aktuelle positive Datensatzversion als `If-Match` oder `--if-version`, wenn eine veraltete Projektion keine neuere Bearbeitung überschreiben darf. Eine veraltete Version führt zu einem Konflikt. Eine ungültig formatierte Version lehnt Grids als Eingabe ab. Sind die normalisierten skalaren Werte und Relationswerte bereits aktuell, liefert Grids den Datensatz. Es legt dann keine neue Version, keine Revision des dauerhaften Verlaufs, keinen Audit-Eintrag und kein Live-Ereignis an.

Nutze für einen Connector, der dasselbe externe Objekt wiederholt projiziert, den externen Datensatz-Upsert. Durchsuche kein sichtbares Feld, um danach einen Datensatz zu erstellen. Anbieter, Anbieterkonto, Ressourcenart und externe ID bilden eine gemeinsame Bindung, bei der Groß- und Kleinschreibung zählt. Der Datensatz behält seine eigene öffentliche Grids-ID.

- Verwende denselben Idempotenzschlüssel nur für eine unsichere Wiederholung derselben Anfrage.
- Eine spätere Projektion verwendet einen neuen Schlüssel und die aktuelle Datensatzversion.
- Ein wiederverwendeter Schlüssel mit anderer Eingabe, eine fehlende Version bei einer vorhandenen Bindung oder eine veraltete Version führen zu einem Konflikt. Ein Duplikat entsteht nicht.
- Das Ergebnis ist eine unveränderliche Quittung mit der öffentlichen Datensatz-ID und der Version, die diese Anfrage erzeugt hat. Lies den Datensatz getrennt, um die aktuellen Werte zu erhalten.
- Wiederholungsquittungen laufen nach 30 Tagen ab. Die Identitätsbindung läuft nicht ab.

Für bis zu 100 unabhängige Projektionen wendet `cld grids records upsert-external-batch` denselben Vertrag nacheinander an. Jedes Element hat einen eigenen Idempotenzschlüssel und ein geordnetes Ergebnis. Ein Konflikt setzt erfolgreiche Nachbarn nicht zurück. Wird die Anfrage unterbrochen, wiederhole den vollständigen unveränderten Stapel: Gespeicherte Elemente werden erneut ausgegeben, die übrigen fortgesetzt. `records import` verhält sich anders. Der Befehl erstellt einen einzigen Alles-oder-nichts-Stapel und ist nicht der wiederholungssichere Weg für externe Identitäten.

### Änderungen aus einer Integration verfolgen

Bewahre bei einer fortsetzbaren Integration den letzten undurchsichtigen Cursor von `cld grids records changes` auf. Der Feed enthält öffentliche IDs von Base, Tabelle und Datensatz sowie den gespeicherten Ereignistyp und die Datensatzversion. Einen Snapshot der Feldwerte enthält er nicht. Lies jeden aktuellen Datensatz erneut, bevor du ihn projizierst.

Grids prüft auf jeder Seite den Zugriff **Ansehen** auf die Base. `--table` grenzt nur den Feed dieser Base ein. Eine Änderung erscheint erst, wenn jeder frühere Schreibvorgang beendet ist. Ein langer Import verzögert deshalb die späteren Änderungen. Sie werden nicht übersprungen. Bleibt der Feed leer, obwohl sich Datensätze ändern, frage den Betreiber nach einer offen gebliebenen Transaktion auf dem Datenbankserver.

Cursor decken die letzten 30 Tage ab. Läuft ein Cursor ab, durchsuche alle Datensätze neu und beginne an der neuen Position im Feed. Begrenze das automatische Aufholen mit `--all --max-events N`.

## Ein falsches Ergebnis einer Ansicht oder Grids App korrigieren {icon="layout"}

Öffne die Quellabfrage und prüfe sie, bevor du die Darstellung änderst:

- Nutze Filter vor der Gruppierung für Quelldatensätze und `having` für Aggregatzeilen.
- Prüfe, ob eine Diagrammquelle gruppiert ist und die erwarteten Aggregatwerte enthält.
- Prüfe, ob ein Widget eine gespeicherte Ansicht oder eigenes lokales GQL verwendet.
- Reine Aggregat- und gruppierte Ergebnisse sind Zusammenfassungen, keine bearbeitbaren Datensätze.

Ein leeres Ergebnis ist etwas anderes als ein fehlgeschlagenes Ergebnis. Abfragediagnosen erklären Syntaxfehler, unbekannte Namen, inkompatible Vorgänge und Zugriffsfehler.

## Ein Formular absenden, das scheitert {icon="forms"}

Prüfe, ob das Formular aktiv ist. Prüfe danach den Weg:

- Eine Person, die in der Base arbeitet, braucht Zugriff **Bearbeiten** auf die Base.
- Ein Absenden über eine Grids App muss einen Formularblock verwenden, den die App enthält und der verfügbar ist.
- Ein öffentliches Formular muss weiter für Token-Zugriff aktiviert sein und über seine aktuelle öffentliche URL geöffnet werden.

Prüfe Pflichtfelder, die Regeln für das direkte Erstellen verknüpfter Datensätze und verborgene Werte. Personen, die das Formular absenden, können seine verborgenen Werte nicht überschreiben.

Funktioniert eine alte öffentliche URL nicht mehr, weil jemand den öffentlichen Zugriff deaktiviert hat, teile die neu erzeugte URL. Grids stellt den alten Link absichtlich nicht wieder her.

## Eine Dokumentvorschau oder einen Download reparieren {icon="lifebuoy"}

Wähle einen Vorschaudatensatz. Prüfe die Vorlage danach in dieser Reihenfolge:

:::steps
1. **Quelle** zeigt das GQL, nachdem Grids die Liquid-Werte des aktuellen Datensatzes eingesetzt hat.
2. **Daten** zeigt die genauen Pfade, die Liquid verwenden kann.
3. **Vorschau** zeigt das gerenderte PDF.
:::

Korrigiere die Quelle, wenn Zeilen leer sind. Kopiere Pfade aus **Daten**, statt sie zu raten. Prüfe bei Barcodes die Symbol-ID und einen kompatiblen Wert, der nicht leer ist. Teste Ausgaben mit mehreren Seiten mit genug Zeilen. Lege wiederholte Briefköpfe oder Seitenzahlen in die Kopf- und Fußzeilenteile.

Neu erzeugte Dokumente laden ihre exakt gespeicherten PDF-Bytes herunter. Spätere Änderungen an Datensatz, Vorlage oder Renderer können ein vorhandenes Artefakt nicht umschreiben.

Ist das Ergebnis der Erzeugung unklar, lass den Dialog offen und wähle **Erzeugung wiederholen**. Das wiederholt dieselbe Anfrage und erzeugt kein neues Dokument. Schließt du den Dialog, endet dieser Wiederholungskontext. Prüfe **Alle Dokumente**, bevor du einen neuen Versuch startest.

## Ein unerwartetes Workflow-Ergebnis untersuchen {icon="route"}

Öffne die Details des Laufs, bevor du ihn wiederholst. Prüfe Revision, Modus, Kanal, Eingaben, Schrittergebnisse, gespeicherte Ausgaben und Fehler. Der Lauf hat die Revision ausgeführt, die er beim Start festgelegt hat. Das ist nicht zwingend das YAML, das jetzt auf dem Bildschirm steht. Öffne die verknüpfte Revision des Laufs, um zu lesen, was tatsächlich lief.

Kann eine Aktion einer Grids App ihr Ergebnis nicht abrufen, wähle **Status prüfen**, solange die Seite offen bleibt. Das verfolgt den vorhandenen Vorgang und startet keinen weiteren Workflow. Ein Statusfehler beweist nicht, dass der Workflow fehlgeschlagen ist.

Ein `dryRun` zeichnet vorhergesagte Auswirkungen auf, führt aber keine Schreibvorgänge und keine externen Anfragen aus. Eine Wiederholung mit `execute` muss einen bewusst gewählten Idempotenzschlüssel verwenden. Empfänger externer HTTP-Anfragen müssen doppelte Anfragen so verarbeiten, dass sich ihre Wirkung nicht wiederholt.

Prüfe bei Scanner-, Massen- und Grids-App-Aktionen die Diagnosen der gespeicherten Ausführungsoption, nachdem du Workflow-Eingaben geändert hast.

## Einen Workflow-Lauf finden, der nie erschienen ist {icon="route"}

Ein automatischer Lauf existiert nur, wenn die veröffentlichte Revision des Workflows auf dieses Ereignis gewartet hat. Hat nichts gewartet, gibt es keinen fehlgeschlagenen Lauf zum Öffnen. Es gibt überhaupt keinen Lauf. Prüfe diese Bedingungen der Reihe nach:

:::steps
1. **Aktiviert:** Ein deaktivierter Workflow lehnt jeden `execute`-Lauf ab, auch Zeitpläne und Datensatzereignisse.
2. **Veröffentlicht:** Der Trigger muss im veröffentlichten YAML stehen. Bearbeitest du die Quelle ohne zu speichern, ändert das nichts an der Auslösung.
3. **Passender Trigger:** Vergleiche Datensatzereignis, optionale Tabellenbeschränkung und Filter mit deiner Änderung. Vergleiche Cron-Ausdruck und Zeitzone mit der erwarteten Zeit.
4. **Aktivierungsfenster:** Grids erfasst eine Datensatzänderung nur, wenn sie nach der Aktivierung des Triggers geschah. Das Aktivieren des Workflows oder das Veröffentlichen eines geänderten Datensatztriggers startet dieses Fenster neu. Frühere Änderungen spielt Grids nicht erneut ab.
5. **Verpasster Zeitplan:** Ein Zeitpunkt, der vergeht, während Grids nicht verfügbar ist, wird übersprungen und nicht nachgeholt. Der nächste Zeitpunkt läuft normal.
6. **Zugriff der verantwortlichen Person:** Zeitpläne und Datensatzereignisse laufen als verantwortliche Person des Workflows. Grids lehnt den Aufruf ab, bevor ein Lauf entsteht, wenn diese Person keinen Zugriff **Bearbeiten** auf die Base mehr hat. Grids lehnt ihn auch ab, wenn sie einen Datensatz nicht lesen kann, den der Trigger an eine Eingabe bindet.
:::

Sind alle sechs Bedingungen erfüllt und es gibt trotzdem keinen Lauf, lass die Cloud-Administration **Systembeobachtung → Workflows** prüfen. Dort stehen aufgezeichnete Ereignisse, aus denen kein Lauf entstand.

## Eine Workflow-Abfrage mit inkompatiblem Schema korrigieren {icon="alert-triangle"}

Meldet eine Abfrage ein inkompatibles Schema oder eine inkompatible Bindung, prüfe ihre Quelle und die referenzierten Felder. Veröffentliche den Workflow danach erneut. Starte einen neuen Lauf mit der neuen Revision. Bestehende Läufe behalten ihren ursprünglichen Plan. Das reine Umsortieren von Spalten macht eine Abfrage nicht ungültig.

:::danger Keine Hashes ändern
Ändere keine gespeicherten Hashes, um die Prüfung zu umgehen.
:::

Das ist eine fehlgeschlagene Abfrage, nicht der unten beschriebene Zustand `needs_attention`.

## Einen Lauf klären, der eine Prüfung braucht {icon="alert-triangle"}

`needs_attention` verlangt, dass eine Person den Grund prüft, bevor der Lauf weitergeht.

Lautet der Grund `WORKFLOW_MODULE_MISMATCH`, hat ein Update die verfügbaren Workflow-Aktionen geändert. Prüfe den Workflow und veröffentliche ihn erneut. Bestehende Läufe behalten ihren ursprünglichen Plan, und eine erneute Veröffentlichung aktualisiert sie nicht. Prüfe abgeschlossene Schritte und externe Auswirkungen, bevor du einen neuen Lauf startest.

### Über eine unterbrochene HTTP-Anfrage entscheiden

Bei einer unterbrochenen `httpRequest` hat die Anfrage Grids ohne vollständige Antwort verlassen. Grids kann deshalb nicht feststellen, ob der Empfänger sie verarbeitet hat. Grids wiederholt den Schritt absichtlich nicht und nennt ihn auch nicht fehlgeschlagen. Eine Wiederholung kann einen Empfänger doppelt belasten. Die Bezeichnung als Fehler würde behaupten, dass die Anfrage nicht angekommen ist.

:::steps
1. Prüfe im empfangenden System, ob die Anfrage angekommen ist.
2. Ist sie nicht angekommen, starte einen neuen Lauf.
3. Ist sie angekommen, ist nichts weiter nötig. Der Lauf bleibt als Aufzeichnung des Vorgangs.
:::

Die Details des Laufs können diese Frage nicht für dich beantworten. Genau deshalb hat der Lauf für eine Person angehalten.

Datensatzänderungen, erzeugte Dokumente und gesendete E-Mails haben dieses unklare HTTP-Ergebnis nicht. Die Unterbrechung macht diese Schritte rückgängig, oder sie lassen sich sicher einmal fortsetzen.

### Gestoppte Datensatzereignisse erneut einspielen

Die Cloud-Administration kann gespeicherte Zustellfehler mit `cld grids record-events failures <base-id> --json` prüfen. Gestoppte Workflow-Ereignisse bleiben bis 30 Tage nach ihrer Änderung in der Liste. So lange bewahrt Grids mindestens den Datensatzstand auf, den sie erneut einspielen. Lies weitere Seiten mit dem zurückgegebenen `nextOffset` über `--offset`.

Hast du die Ursache behoben, spielt `cld grids record-events replay <base-id> <failure-id> --yes` ein gestopptes Ereignis mit seinen ursprünglichen gespeicherten Daten erneut ein. Verwende die genaue Fehler-UUID aus der Liste. Die Annahme bedeutet nicht, dass die Verarbeitung abgeschlossen ist. Zugriff **Verwalten** auf die Base allein erlaubt diese Betreiberaktion nicht.

## Einen unbestimmten Testlauf lesen {icon="lifebuoy"}

Ein Testlauf endet unbestimmt, wenn Grids den Plan nicht entscheiden konnte, nicht wenn etwas schiefging. Der Lauf zeigt `failed` mit einem Fehlercode für Testläufe. Der Schritt, den Grids nicht planen konnte, enthält den Grund.

Zwei Ursachen erklären die meisten Fälle:

- Ein Schritt nennt eine Vorlage, eine Tabelle, ein Feld oder einen Datensatz, der gelöscht, mehrdeutig oder außerhalb des Zugriffs der Laufidentität ist. Der Schritt nennt diese Referenz als Grund.
- Grids konnte eine Bedingung bei der Planung nicht auswerten. Ein `if` oder `switch` ist dann unentscheidbar. Der Testlauf plant dann **jeden** Zweig und markiert den Kontrollschritt. Lies diese Zweige als Alternativen, nicht als Arbeit, die vollständig geschieht.

Korrigiere die genannte Referenz. Akzeptiere bei einem unentscheidbaren Zweig, dass ein Plan ihn nicht festlegen kann. Prüfe das Verhalten stattdessen mit einem kleinen echten Lauf.

## Eine kombinierte Tabelle reparieren {icon="lifebuoy"}

Eine kombinierte Tabelle sperrt, wenn eine veröffentlichte Quelle, Zuordnung oder ein Zugriff auf eine Quelle nicht mehr gültig ist. Sie liefert kein kleineres Teilergebnis.

:::steps
1. Öffne **Kombinierte Daten**.
2. Prüfe die Diagnosen der betroffenen Quelle und Felder.
3. Repariere den Entwurf.
4. Validiere ihn.
5. Veröffentliche eine vollständige neue Revision.
:::

Eine widerrufene Quelle muss erneut autorisiert werden, bevor du erneut veröffentlichst.

## Mit Dateien, Exporten und großen Ergebnissen arbeiten {icon="paperclip"}

Dateien folgen dem Zugriff auf die Base, zu der sie gehören, oder der exakten veröffentlichten Capability einer Grids App. Speichere Fakten, die Personen suchen oder filtern, in normalen Feldern, nicht nur in einem Dateinamen.

Exporte und Ergebnisseiten laden seitenweise. Eine Abfrage ohne `limit` kann alle passenden Zeilen durchlaufen. Ein `limit` begrenzt das vollständige Ergebnis bewusst. Nutze begrenzte Exporte und die CLI-Optionen für `--max-rows`, wenn ein automatischer Prozess sein eigenes Maximum durchsetzen muss.

:::note Den Fehlerkontext bewahren
Bewahre vor dem Bearbeiten einer Abfrage, Vorlage oder eines Workflows die Diagnose und die Eingabe auf, die sie erzeugt hat. Ein genauer Fehler mit der aktiven Quelle hilft mehr als ein Screenshot eines leeren Ergebnisses.
:::
