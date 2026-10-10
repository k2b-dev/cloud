---
id: mail-automation
title: Antworten und Postfacharbeit automatisieren
icon: ti ti-automation
description: Automatische Antworten, Verarbeitung eingehender E-Mails und sichere Workflow-Aktivierung einrichten.
order: 60
---

Öffne **Postfachwerkzeuge → Automatisierungen**. Die seitenbreite Übersicht zeigt, was aktiv ist, und öffnet genau die Einrichtung, die du wählst. **Automatische Antworten** und **Eingehende E-Mails** decken häufige Aufgaben ab. Mit Zugriff **Verwalten** siehst du unter Erweitert außerdem **Aktivität** und **Workflows**.

## Das passende Automatisierungswerkzeug wählen {icon="route"}

| Bedarf | Werkzeug |
| --- | --- |
| Abwesenheitsnotiz oder Empfangsbestätigung senden | **Automatische Antworten** |
| Eingehende E-Mails verschieben, markieren, kennzeichnen, zuweisen, klassifizieren oder daraus Entwürfe erstellen | Ein geführter Ablauf unter **Eingehende E-Mails** |
| Unterhaltungen dauerhafte IDs für Menschen geben | Empfangsbestätigung mit Referenznummer oder eigener **Workflow** |
| Aufgaben über die geführten Editoren hinaus verbinden oder die Zustellung bewusst automatisieren | Erweiterter **Workflow** |

Die Werkzeuge können zusammenarbeiten, aber keines aktiviert ein anderes. Einstellungen für Referenznummern legen das Format fest. Ein Workflow entscheidet weiterhin, wann eine Nummer vergeben wird. Das Speichern eines Workflows aktiviert ihn nicht.

## Eine Automatisierung für eingehende E-Mails erstellen {icon="mailbox"}

Mit Zugriff **Verwalten** erstellst du unter **Automatisierungen → Eingehende E-Mails** einen geführten Ablauf. Du kannst ihn auch direkt im Organisationsmenü einer Nachricht beginnen.

- Wähle **Alle eingehenden E-Mails**, wenn du keine Bedingung brauchst.
- Oder verbinde bis zu acht Bedingungen für Absender, Domain, Betreff, Nachrichtentext oder vorhandene Anhänge. Lege fest, ob alle oder eine Bedingung zutreffen müssen.

Eine Automatisierung für eingehende E-Mails läuft einmal pro empfangener Nachricht. E-Mails, die der Anbieter direkt in den Papierkorb oder in Spam zustellt, etwa Spam, den sein Filter erkannt hat, starten weder Automatisierungen für eingehende E-Mails noch automatische Antworten. Jemand kann die Nachricht in einem anderen E-Mail-Programm in einen anderen Ordner verschieben, etwa zurück in den Posteingang, nachdem die Automatisierung sie verschoben hat. Die Automatisierung läuft dann nicht erneut.

Füge Schritte in der Reihenfolge hinzu, in der sie laufen. Ein Ablauf kann frei mischen:

- **E-Mail-Aktion**, um zu verschieben, zu markieren, einen lokalen Tag hinzuzufügen, zuzuweisen oder den Status der Unterhaltung zu ändern.
- **Text mit KI erzeugen**, um begrenzten Text für spätere Schritte zu erzeugen.
- **Mit KI klassifizieren**, um genau eine eingerichtete Kategorie zu erzeugen.
- **Mit KI mehrfach klassifizieren**, um passende Kategorien bis zur eingerichteten Höchstzahl zu erzeugen.
- **Space-Element verknüpfen**, um die Unterhaltung mit einer vorhandenen Aufgabe oder einem Termin zu verbinden, für die die Automatisierung Zugriff **Bearbeiten** hat.
- **Termindaten mit KI extrahieren und Termin in Spaces erstellen**, um ein Ziel zu wählen, geprüfte Terminfelder zu extrahieren und einen verknüpften Termin anzulegen.
- **Antwortentwurf erstellen**, **Internen Kommentar hinzufügen** oder **Zusammenfassung der Unterhaltung festlegen** mit eigenem Text oder einer früheren Textausgabe.
- **Wenn die Ausgabe übereinstimmt**, um normale Mail- oder KI-Schritte in einem Dann- oder Sonst-Zweig auszuführen.

Antwortentwürfe und interne Kommentare sind normale Mail-Schritte und brauchen keine KI. Füge den Schritt direkt hinzu. Wähle dann **Eigener Text** oder eine passende frühere Workflow-Ausgabe als Textquelle.

KI-Ergebnisse bleiben normale Workflow-Ausgaben. **Ausgabe verwenden** und **Bedingung hinzufügen** sind Abkürzungen, die gewöhnliche nachfolgende Schritte hinzufügen. Sie verbergen kein weiteres Verhalten im KI-Block. Dann- und Sonst-Zweige können wieder Mail-Aktionen, KI-Schritte, Schritte, die Ausgaben nutzen, oder Bedingungen enthalten.

Der Editor schaltet Ergänzungen ab oder lässt sie weg, wenn sie die Grenzen für Ablauf, Zweige, Verschachtelung oder KI-Aufrufe überschreiten würden. Einen Schritt, der eine Ausgabe erzeugt, kannst du nicht entfernen, solange ein späterer Schritt diese Ausgabe nutzt. Benennst du eine Auswahl einer KI-Klassifizierung um, passt Mail die Bedingungen an, die sie nutzen. Bevor du eine genutzte Auswahl löschst, entferne oder ändere diese Bedingungen.

### Den Vertrag der geführten Definition kennen

Der geführte Editor und die CLI nutzen dieselbe strikte Definition. Mail lehnt unbekannte Felder ab. Eine Definition hat `name`, `enabled`, `scope` und `steps`. Der Name umfasst 1–120 Zeichen. Eine neue Definition setzt `enabled` standardmäßig auf `false`.

:::reference
- **Umfang:** `scope.mode: all` braucht keine Bedingungen. `scope.mode: matching` braucht ein `conditions`-Objekt mit `mode: all|any` und einer `items`-Liste mit 1–8 eindeutigen Bedingungen, zum Beispiel `conditions: { mode: all, items: [{ field: sender_address, operator: is, value: user@example.com }] }`.
- **Felder der Bedingungen:** `sender_address`, `sender_domain`, `subject`, `body_text` und `attachment_presence`. Absenderadresse und Domain nutzen `operator: is`. Betreff und Nachrichtentext erlauben `is`, `contains`, `starts_with` oder `ends_with`. Vorhandene Anhänge nutzen `is` mit einem booleschen `value`.
- **Werte der Bedingungen:** Adressen umfassen 1–320 Zeichen, Domains 1–253 und Werte für Betreff oder Nachrichtentext 1–1.000.
- **Schritte:** Jeder Schritt hat in `id` eine eindeutige UUID. Schrittarten sind `mail_action`, `ai_generate_text`, `ai_classify`, `ai_classify_many`, `ai_extract_event`, `link_space_item`, `create_space_event`, `create_reply_draft`, `add_comment`, `set_summary` und `if`.
- **Mail-Aktionen:** Eine `mail_action` ist `junk`, `trash`, `mark_read`, `add_keyword`, `move_to_folder`, `add_local_tag`, `assign_user` oder `set_status`. Aktionen aus dem Katalog nutzen `folderId`, `tagId` oder `userId`. `move_to_folder.folderId` und `add_local_tag.tagId` akzeptieren auch einen exakten Ordner- oder Tag-Namen, und Mail speichert ihn als ID. Teilen sich mehrere Ordner oder Tags einen Namen, ist die ID nötig. Der Status ist `needs_action`, `waiting` oder `done`.
- **Schlüsselwörter:** Der geführte Editor empfiehlt lokale Tags und bietet `add_keyword` für neue Schritte nicht mehr an. Vorhandene Definitionen mit diesem Wert kannst du weiter bearbeiten. CLI und erweiterte Workflow-Aufrufer können ihn für die Kompatibilität mit dem Anbieter weiter nutzen. Ein Schlüsselwort umfasst 1–100 Zeichen und muss gültige Schlüsselwortsyntax des Anbieters nutzen.
- **KI-Text und Klassifizierung:** `ai_generate_text.instructions` umfasst 1–4.000 Zeichen, und `maxOutputChars` liegt bei 200–10.000. `ai_classify` und `ai_classify_many` erlauben 2–10 Auswahlen mit Namen, die ohne Beachtung der Groß- und Kleinschreibung eindeutig sind. Ein Name umfasst 1–80 Zeichen, seine Beschreibung 1–500. `ai_classify_many.maxChoices` liegt zwischen 1 und der Anzahl der Auswahlen.
- **Termine extrahieren:** `ai_extract_event` erlaubt 1–4.000 Zeichen Anweisungen und eine ausdrückliche IANA-`timeZone`. Die strukturierte Ausgabe enthält `ready`, den Titel, optional Beschreibung und Ort, Beginn, Ende und den Ganztagsstatus. Fehlen Titel oder Zeiten oder sind sie unklar, setzt Mail `ready: false`. Der folgende Terminschritt stoppt dann und erfindet keinen Termin.
- **Spaces-Schritte:** `link_space_item.itemId` bezeichnet eine vorhandene Aufgabe oder einen Termin mit Zugriff **Bearbeiten**. `create_space_event` braucht eine `spaceId` mit Zugriff **Bearbeiten**, eine offene `columnId` und entweder ausdrückliche Termindaten oder über `sourceStepId` die Ausgabe eines früheren `ai_extract_event`. Der geführte Editor zeigt diese IDs schreibgeschützt. Wähle **Element ändern** oder **Ziel ändern**, um ein anderes Ziel mit aktuellem Zugriff **Bearbeiten** zu wählen.
- **Termindaten:** Ausdrückliche Termindaten nutzen `title`, optional `description` und `location`, ISO-`startsAt` und -`endsAt` sowie `allDay`. Der erstellte Termin enthält eine stabile Referenz zurück zur Mail-Unterhaltung.
- **Textschritte:** `create_reply_draft`, `add_comment` und `set_summary` nutzen `body: { kind: custom, value: ... }` mit 1–50.000 Zeichen oder `body: { kind: step_output, sourceStepId: ... }` für einen früheren KI-Schritt, der Text erzeugt. Ein Ergebnis mit mehreren Auswahlen ist keine Textquelle. Antwortentwürfe brauchen zusätzlich eine `senderIdentityId` aus dem Katalog.
- **Bedingungen:** Eine `if`-Bedingung verweist auf eine frühere KI-`sourceStepId`. Nutze `equals` für erzeugten Text oder eine einzelne Klassifizierung. Nutze `includes` für eine Mehrfachklassifizierung. `value` umfasst 1–500 Zeichen und muss bei einer Klassifizierung eine erklärte Auswahl nennen. `then` und `else` enthalten jeweils höchstens 12 Schritte.
- **Größe:** Eine Definition enthält 1–20 Schritte auf oberster Ebene, höchstens 40 Schritte über alle Zweige, höchstens 4 Zweigebenen und höchstens 10 KI-Aufrufe.
- **Ein Pfad:** Ein erreichbarer Pfad kann nur eine Nachrichtenaktion beim Anbieter, eine Zuweisung, eine Statusänderung und einen Ersatz der Zusammenfassung enthalten. Er kann denselben lokalen Tag nicht zweimal hinzufügen. Aufeinanderfolgende `if`-Schritte liegen auf demselben Pfad, weil beide zutreffen können. Setze Aktionen, die sich ausschließen, in `then` und `else` eines einzigen `if`. `set_status` ist eine lokale Statusänderung, keine Nachrichtenaktion beim Anbieter, und darf deshalb mit `mark_read` auf einem Pfad stehen.
:::

Mail erzeugt aus dem Ablauf kanonisches Workflow-YAML und zeigt es im Editor schreibgeschützt. Die Schritte laufen von oben nach unten in der gemeinsamen Workflow-Laufzeit.

- **Mehrere passende Automatisierungen:** Die älteste Automatisierung entscheidet, wohin die Nachricht kommt. Eine spätere Automatisierung überspringt ihren Schritt zum Verschieben, Löschen oder Verschieben in Spam, statt zu scheitern. Ihre übrigen Schritte laufen weiter.
- **Fehlgeschlagener Schritt:** Schlägt ein späterer Schritt fehl, bleiben die Wirkungen früherer abgeschlossener Schritte.
- **Versionen:** Eine Änderung am Ablauf veröffentlicht eine neue unveränderliche Workflow-Version. Änderst du nur den Namen oder den Aktivstatus, entsteht keine doppelte identische Quelle.
- **Geschützte Ziele:** Zerstörende Aktionen dürfen keine Absenderidentität des Postfachs, keine eingerichtete interne Domain, keine ihrer Subdomains und keine unsichere übergeordnete Domain treffen.

Textbedingungen unterstützen exakte Übereinstimmung, Enthält, Beginnt mit und Endet mit. Reguläre Ausdrücke sind bewusst nicht verfügbar, bis Mail einen begrenzten RE2-kompatiblen Abgleich erzwingen kann.

Neue Automatisierungen für eingehende E-Mails starten inaktiv. Ein Ablauf ohne KI-Schritte kann vorhandene passende Nachrichten mit einem fortsetzbaren Backfill in der Vorschau prüfen und verarbeiten:

- Ein Backfill übergibt höchstens 100 Nachrichten an die Automatisierung. Passen mehr Nachrichten, endet er mit **Limit erreicht** und zeigt, wie viele offen sind. Starte ihn erneut, um mit den nächsten Nachrichten weiterzumachen.
- Ein Backfill übersteht Neustarts. Mail wiederholt eine fehlgeschlagene Nachricht, ohne andere Workflow-Läufe zu stoppen.
- Ein wiederholter Backfill überspringt Nachrichten, die für dieselbe unveränderliche Version schon angenommen wurden.
- **Abgeschlossen** bedeutet, dass Mail jede passende Nachricht an die Automatisierung übergeben hat. Die Aktionen selbst laufen danach in der Workflow-Laufzeit und erscheinen unter **Aktivität**.
- Die Fortschrittszahlen wachsen während eines Backfills nur. Das Menü der Automatisierung zeigt den Fortschritt und lässt dich den Backfill abbrechen oder erneut starten.

Ein Ablauf mit einem KI-Schritt verarbeitet nur künftige Nachrichten. Mail prüft die Bedingungen, bevor die KI läuft. Der Bereich Sicherheit zeigt die höchste Zahl an KI-Aufrufen pro passender Nachricht.

:::warning KI kann falsch klassifizieren oder schreiben
Formuliere Kategoriebeschreibungen genau und prüfe die ersten Läufe unter **Aktivität**.
:::

Eine erzeugte Textausgabe wirkt erst, wenn ein späterer Schritt sie nutzt. Die Antwortautomatisierung erstellt nur Entwürfe zur Prüfung durch Menschen und sendet sie nie.

Spaces-Schritte laufen mit einer Delegation der Person, die die Automatisierung eingerichtet hat, und diese Person kann sie widerrufen. Mail speichert das Token verschlüsselt. Es widerruft das Token, wenn jemand den letzten Spaces-Schritt entfernt oder die Automatisierung löscht. Jeder Lauf prüft trotzdem den aktuellen Zugriff in Mail und in Spaces. Verknüpfen aktualisiert eine vorhandene Verknüpfung oder legt eine an, und das Erstellen von Terminen nutzt einen dauerhaften Idempotenzschlüssel, damit Wiederholungen keine doppelten Termine anlegen. Widerruft jemand den delegierten API-Schlüssel oder entfernt den Zugriff auf den Space, schlagen künftige Läufe fehl, statt ohne diesen Zugriff zu handeln.

Nutze `set_status: done`, um eine Unterhaltung abzuschließen. Nutze `needs_action` oder `waiting`, um sie ausdrücklich wieder zu öffnen. Eine bestätigte neue eingehende Nachricht setzt eine abgeschlossene Unterhaltung schon zurück auf Handlungsbedarf. Ein eigener Schritt, der Erledigt bei eingehender E-Mail aufhebt, ist deshalb normalerweise nicht nötig.

Für Automatisierung über `cld` nutzt du `mail automation catalog`, um gültige IDs zu finden. `mail automation create` und `mail automation update` akzeptieren die vollständige geführte Definition als JSON oder YAML über `--definition-file` oder `--definition-stdin`, einschließlich `scope` und des geordneten `steps`-Baums. CLI und Oberfläche verhalten sich dadurch gleich, auch bei Ausgabeverweisen und verschachtelten Bedingungen. Bei einer ungültigen Definition nennt Mail jedes betroffene Feld mit seinem Pfad, etwa `scope.conditions.items`, und den Grund.

Mail nutzt das Workflow-Modell der Plattform automatisch und bietet keine eigene Modellauswahl. Nutze erweiterte **Workflows** nur, wenn die geführten Bausteine die Aufgabe nicht abdecken.

## Eine automatische Antwort einrichten {icon="send"}

:::steps
1. Bitte jemanden mit Zugriff **Verwalten**, eine Absenderidentität zu prüfen und dafür **Automatische Antworten** einzuschalten. Das geht unter **Einstellungen → Konten und Identitäten → Absenderidentitäten**.
2. Öffne **Automatisierungen → Automatische Antworten**.
3. Wähle **Automatische Antwort hinzufügen**.
4. Wähle **Abwesenheitsnotiz**, **Empfangsbestätigung zu Bürozeiten**, **Empfangsbestätigung mit Referenznummer** oder **Eigene automatische Antwort**.
5. Prüfe Absenderidentität, Betreff, Text, Zeitplan, Schutz vor Wiederholungen und das Verhalten außerhalb aktiver Zeiten.
6. Nutze **Vorschau** für Markdown-Inhalte.
7. Wähle **Automatische Antwort speichern**.
:::

Betreff und Nachrichten sind Liquid-Vorlagen. Nutze die Variablen, die du im Editor kopieren kannst, zum Beispiel `{{ inputs.message.subject }}`. Nachdem eine Referenz vergeben wurde, steht auch `{{ reference.value }}` zur Verfügung. Mail lehnt ungültige Syntax und nicht verfügbare Variablen ab, bevor es die Antwort speichert.

In einem Postfach kann nur eine automatische Antwort gleichzeitig eingeschaltet sein. Schalte die aktive Einrichtung aus, bevor du eine andere einschaltest. Standardmäßig können nur Personen mit Zugriff **Verwalten** automatische Antworten ändern. Sie können das unter **Einstellungen → Zugriff → Verwaltungszugriff für automatische Antworten** auch Personen mit Zugriff **Bearbeiten** erlauben.

Mail antwortet nicht auf Nachrichten, die für automatische Antworten unsicher sind. Dazu gehören E-Mails von Mailinglisten, Massen-E-Mails, Zustellberichte, Nachrichten aus dem Postfach selbst und Nachrichten, die automatische Antworten ausdrücklich unterdrücken. Eine unterdrückte Antwort bleibt Teil der Aktivität und des Laufverlaufs. Mail macht daraus nicht still einen normalen Entwurf.

## Tage und Wochenzeiten festlegen {icon="point"}

Automatische Antworten und Antwortfenster in Workflows nutzen dieselben Zeitregeln:

- **Zeitzone** legt fest, wie Mail alle Daten und Uhrzeiten auswertet.
- **Aktive Zeiträume** begrenzen den Zeitplan auf eine Abwesenheit oder Kampagne. Ohne Zeitraum wiederholen sich die Wochenzeiten ohne Ende.
- **Wochenzeiten** führen jeden Wochentag einzeln auf. Eine angehakte Karte für einen Wochentag ist eingeschaltet. Schalte **Ganztägig** für `00:00–24:00` ein oder füge für diesen Tag ein oder mehrere Zeitfenster hinzu, die sich nicht überschneiden. Eine Karte mit **Deaktiviert** sendet nie eine Antwort.
- **Ausnahmen für einzelne Tage** schließen ein Datum oder ersetzen die normalen Zeiten dieses Datums.
- **Nicht antworten** unterdrückt Nachrichten, die außerhalb eines aktiven Zeitfensters eingehen.
- **Im nächsten aktiven Zeitfenster antworten** hält die Antwort bis zum nächsten aktiven Zeitfenster zurück.

Eine Ausnahme hat Vorrang vor den normalen Wochenzeiten. Zeiten können nicht über Mitternacht gehen. Lege ein Zeitfenster bis Mitternacht und ein weiteres am nächsten Tag an.

## Den Schutz vor Wiederholungen verstehen {icon="shield-lock"}

**Schutz vor Wiederholungen** ist die Mindestzeit, bevor derselbe Absender eine weitere automatische Antwort aus diesem Postfach bekommen kann.

- Die Vorlage **Abwesenheitsnotiz** nutzt 96 Stunden, also 4 Tage. Wer während einer Abwesenheit mehrmals schreibt, bekommt deshalb nicht jeden Tag dieselbe Nachricht.
- **Empfangsbestätigung zu Bürozeiten** und **Eigene automatische Antwort** nutzen 24 Stunden.
- Der kürzeste Abstand ist 1 Stunde.
- Mail antwortet außerdem auf jede eingehende Nachricht höchstens einmal. Es sendet höchstens 100 automatische Antworten pro Stunde für das ganze Postfach. Alles darüber unterdrückt Mail und zeigt es im Aktivitätsverlauf.

Wähle einen kürzeren Abstand nur, wenn wiederholte Bestätigungen dem Empfänger helfen. Der Wert gilt für das ganze Postfach bei dieser automatischen Antwort. Er ist keine Verzögerung vor der ersten Antwort.

Für einen YAML-Workflow legst du diese Regeln direkt unter `automaticReply.schedule` fest. Der Zeitplan ist Teil der unveränderlichen Workflow-Version. Prüfst und aktivierst du diese Version, prüfst und aktivierst du auch ihren Zeitplan. Die vollständige YAML-Form steht unter [Mail-Workflows erstellen](/app/mail/help/mail-workflows#send-a-guarded-automatic-reply).

## Referenzen für Unterhaltungen erstellen {icon="square-plus"}

Eine Referenz ist eine dauerhafte Kennung für eine Unterhaltung im Postfach, etwa `REF-K7M3-P9QX-2F4N`. Damit können Menschen eine Unterhaltung zitieren, suchen und prüfen, auch wenn sich der Betreff ändert.

:::steps
1. Öffne **Automatisierungen → Automatische Antworten** und wähle **Empfangsbestätigung mit Referenznummer**. Für eigenes YAML öffne stattdessen **Workflows**.
2. Gibt es noch kein Referenzformat, richte es im selben Antworteditor oder im Referenzbereich der Workflows-Seite ein.
3. Gib ein Liquid-Muster mit genau einer Kennungsausgabe ein. Der Standard, der die Privatsphäre schützt, ist `REF-{{ short_id }}`.
4. Prüfe im Editor die Erklärung jedes Platzhalters und die Vorschau.
5. Speichere das Format. Du bleibst in der Antwort und behältst deine Eingaben.
6. Schließe die automatische Antwort ab oder ergänze `ensureConversationReference` in deinem eigenen Workflow.
:::

Unterstützte Teile des Musters:

- `{{ short_id }}` fügt eine kurze, lesbare Zufalls-ID ein. Sie verrät weder Menge noch Vergabezeitpunkt.
- `{{ uuid }}` fügt eine undurchsichtige zufällige UUID ein.
- `{{ uuid_v7 }}` fügt eine sortierbare UUID ein, die ihren Vergabezeitpunkt verrät.
- `{{ ulid }}` fügt eine kompakte sortierbare ID ein, die ihren Vergabezeitpunkt verrät.
- `{{ sequence }}` fügt die nächste Nummer des Postfachs ein und verrät deshalb Reihenfolge und ungefähre Menge.
- `{{ sequence | pad_start: 6 }}` füllt den Zähler auf sechs Stellen auf. Die Breite kann 1 bis 120 sein.
- `{{ year }}`, `{{ month }}`, `{{ month_name }}` und `{{ day }}` fügen Teile des Vergabedatums in UTC ein.
- Buchstaben, Zahlen, Leerzeichen, `.`, `_`, `-` und `/` funktionieren als feste Trennzeichen.

Nutze genau eine der fünf Kennungsausgaben. Datumsteile sind optional und machen eine Referenz nicht eindeutig.

- **Gleiches Ergebnis bei Wiederholung:** Läuft dieselbe Aktion erneut, liefert sie die vorhandene Referenz der Unterhaltung und vergibt keine neue.
- **Zusammenführen:** Referenzen bleiben nach dem Zusammenführen von Unterhaltungen als Aliasse erhalten.
- **Vergabe ausschalten:** Mail vergibt keine neuen Referenzen, ändert aber vorhandene Werte nicht.

Die Vorlage **Empfangsbestätigung mit Referenznummer** vergibt die Referenz vor dem Senden und fügt `{{ reference.value }}` in die Nachricht ein. Eigenes YAML bietet dieselbe Ergebnisbindung. Hat eine Unterhaltung eine Referenz, nutzen neue Antwortbetreffzeilen standardmäßig `Re: [REF-K7M3-P9QX-2F4N] Original subject`. Mail ordnet Antworten weiterhin über die Standard-Header `Message-ID`, `In-Reply-To` und `References` zu.

## Einen Workflow sicher speichern und aktivieren {icon="route"}

:::steps
1. Öffne **Automatisierungen → Workflows** und wähle **Neuer Workflow**.
2. Gib Name, Beschreibung, Priorität, YAML und Wirkungsbudgets ein.
3. Wähle **Prüfen** und behebe jede Diagnose in ihrer Zeile.
4. Wähle **Workflow erstellen** oder **Version speichern**.
5. Prüfe die neue Version unter **Versionen**.
6. Wähle **Aktivieren** oder **Aktuelle Version aktivieren**.
7. Prüfe den ersten passenden Lauf unter **Automatisierungen → Aktivität**. Betreiber der Plattform nutzen auch **Administration → Systembeobachtung → Workflows**.
:::

Speichern aktiviert nie eine Version. Eine aktive Version läuft weiter, bis jemand mit Zugriff **Verwalten** die neuere ausdrücklich aktiviert. **Aktualisierung verfügbar** bedeutet, dass sich die gespeicherte aktuelle Version und die aktive Version unterscheiden.

Wirkungsbudgets sind harte Obergrenzen für Verschiebungen, Sendungen, Änderungen an Schlüsselwörtern, Änderungen an der Zusammenarbeit und KI-Aufrufe während eines Laufs. Ein Lauf stoppt, bevor er eine Wirkung anwendet, die sein Budget überschreiten würde. KI-Ausgaben bleiben Daten, bis eine spätere Mail-Aktion sie nutzt. Klassifizieren, Taggen, Zuweisen, Entwerfen und Senden bleiben deshalb Schritte, die du einzeln prüfen kannst.

## Workflow-Läufe beobachten und stoppen {icon="activity"}

Mit Zugriff **Verwalten** nutzt du **Automatisierungen → Aktivität** für die automatischen Antworten, Automatisierungen für eingehende E-Mails, eigenen Workflows und fortsetzbaren Backfills des Postfachs. Die Tabelle zeigt Typ der Automatisierung, Status, Dauer, Zeitpunkt und eine kurze Fehler- oder Ergebnismeldung. Die Cloud-Administration behält die Detailansicht über alle Apps unter **Administration → Systembeobachtung → Workflows**.

Wähle **Abbrechen**, wenn keine weiteren Wirkungen beginnen sollen. Das Abbrechen macht bereits abgeschlossene Verschiebungen, Sendungen oder Änderungen an der Zusammenarbeit nicht rückgängig. Ein Lauf mit Klärungsbedarf wartet, bis die Cloud-Administration festhält, ob eine unklare externe Wirkung eingetreten ist. Das Ausschalten eines Mail-Workflows verhindert neue passende Auslöser. Es ändert den abgeschlossenen Verlauf nicht.

Das vollständige YAML-Vokabular und geprüfte Beispiele stehen in der [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows).
