---
id: mail-automation
title: Antworten und Postfacharbeit automatisieren
icon: ti ti-automation
description: Automatische Antworten, Verarbeitung eingehender E-Mails und sichere Workflow-Aktivierung einrichten.
order: 60
---

Öffne **Postfachwerkzeuge > Automatisierungen**. Die seitenbreite Übersicht zeigt aktive Automatisierungen und öffnet direkt die gewählte Einrichtung. **Automatische Antworten** und **Eingehende E-Mails** decken häufige Aufgaben ab. Postfachadministratoren sehen unter Erweitert außerdem **Aktivität** und **Workflows**.

## Das passende Automatisierungswerkzeug wählen {icon="route"}

| Bedarf | Werkzeug |
| --- | --- |
| Abwesenheitsnotiz oder Empfangsbestätigung senden | **Automatische Antworten** |
| Eingehende E-Mails verschieben, markieren, kennzeichnen, zuweisen, klassifizieren oder daraus Entwürfe erstellen | Ein geführter Ablauf unter **Eingehende E-Mails** |
| Unterhaltungen dauerhafte, für Menschen lesbare IDs geben | Referenzbestätigung oder eigener **Workflow** |
| Aufgaben außerhalb der geführten Editoren verbinden oder die Zustellung bewusst automatisieren | Erweiterter **Workflow** |

Die Werkzeuge können zusammenarbeiten, aber keines aktiviert automatisch ein anderes. Referenzeinstellungen bestimmen das Format; ein Workflow entscheidet weiterhin, wann eine Nummer vergeben wird. Das Speichern eines Workflows aktiviert ihn nicht.

## Eine Automatisierung für eingehende E-Mails erstellen {icon="mailbox"}

Postfachadministratoren erstellen unter **Automatisierungen > Eingehende E-Mails** einen geführten Ablauf oder beginnen direkt im Organisationsmenü einer Nachricht. Wähle **Alle eingehenden E-Mails**, wenn keine Bedingung erforderlich ist. Andernfalls kannst du bis zu acht Bedingungen für Absender, Domain, Betreff, Nachrichtentext oder vorhandene Anhänge verbinden und festlegen, ob alle oder eine Bedingung zutreffen müssen.

Füge Schritte in der Reihenfolge ihrer Ausführung hinzu. Ein Ablauf kann beliebig kombinieren:

- **Mail-Aktion**, um zu verschieben, zu markieren, ein lokales Schlagwort hinzuzufügen, zuzuweisen oder den Unterhaltungsstatus zu ändern.
- **AI-Text erzeugen**, um begrenzten Text für spätere Schritte zu erstellen.
- **AI-Klassifizierung**, um genau eine eingerichtete Kategorie zu erzeugen.
- **AI-Mehrfachklassifizierung**, um höchstens die festgelegte Anzahl passender Kategorien zu erzeugen.
- **Spaces-Element verknüpfen**, um die Unterhaltung mit einer vorhandenen beschreibbaren Aufgabe oder einem Ereignis zu verbinden.
- **Ereignis mit AI extrahieren + Spaces-Ereignis erstellen**, um ein Ziel zu wählen, validierte Ereignisfelder zu extrahieren und ein verknüpftes Ereignis anzulegen.
- **Antwortentwurf erstellen**, **Internen Kommentar hinzufügen** oder **Unterhaltungszusammenfassung festlegen** mit eigenem Text oder einer früheren Textausgabe.
- **Wenn Ausgabe übereinstimmt**, um normale Mail- oder AI-Schritte in einem Dann- oder Sonst-Zweig auszuführen.

Antwortentwürfe und interne Kommentare sind normale Mail-Schritte und benötigen keine AI. Füge den jeweiligen Schritt direkt hinzu und wähle **Eigener Text** oder eine kompatible frühere Workflow-Ausgabe als Textquelle. AI-Ergebnisse bleiben normale Workflow-Ausgaben. **Ausgabe verwenden** und **Bedingung hinzufügen** sind Abkürzungen, die gewöhnliche nachfolgende Schritte hinzufügen; sie verbergen kein weiteres Verhalten im AI-Block. Dann- und Sonst-Zweige können wiederum Mail-Aktionen, AI-Schritte, Ausgabeverwendungen oder Bedingungen enthalten.

Der Editor deaktiviert oder verbirgt Ergänzungen, die Grenzwerte für Ablauf, Zweig, Verschachtelung oder AI-Aufrufe überschreiten würden. Ein ausgabeerzeugender Schritt kann nicht entfernt werden, solange ein späterer Schritt seine Ausgabe verwendet. Wenn du eine Auswahl einer AI-Klassifizierung umbenennst, werden darauf verweisende Bedingungen angepasst. Entferne oder ändere solche Bedingungen, bevor du eine verwendete Auswahl löschst.

### Vertrag der geführten Definition

Der geführte Editor und die CLI verwenden dieselbe strikte Definition. Unbekannte Felder werden abgelehnt. Eine Definition enthält `name`, `enabled`, `scope` und `steps`; der Name umfasst 1–120 Zeichen, und neue Definitionen verwenden für `enabled` standardmäßig `false`.

- `scope.mode: all` benötigt keine Bedingungen. `scope.mode: matching` erfordert `conditions.mode: all|any` und 1–8 eindeutige Bedingungen. Felder sind `sender_address`, `sender_domain`, `subject`, `body_text` und `attachment_presence`. Absenderadresse und Domain verwenden `operator: is`; Betreff und Nachrichtentext unterstützen `is`, `contains`, `starts_with` oder `ends_with`; vorhandene Anhänge verwenden `is` mit einem booleschen `value`. Adresswerte umfassen 1–320 Zeichen, Domains 1–253 und Werte für Betreff oder Nachrichtentext 1–1.000.
- Jeder Schritt besitzt in `id` eine eindeutige UUID. Schrittarten sind `mail_action`, `ai_generate_text`, `ai_classify`, `ai_classify_many`, `ai_extract_event`, `link_space_item`, `create_space_event`, `create_reply_draft`, `add_comment`, `set_summary` und `if`.
- Eine `mail_action` ist `junk`, `trash`, `mark_read`, `add_keyword`, `move_to_folder`, `add_local_tag`, `assign_user` oder `set_status`. Kataloggestützte Aktionen verwenden `folderId`, `tagId` oder `userId`; der Status ist `needs_action`, `waiting` oder `done`. Der geführte Editor empfiehlt lokale Schlagwörter und bietet `add_keyword` für neue Schritte nicht mehr an. Vorhandene Definitionen mit diesem Wert bleiben bearbeitbar. CLI und erweiterte Workflow-Aufrufer können ihn für die Zusammenarbeit mit Anbietern weiterverwenden; ein Schlüsselwort umfasst 1–100 Zeichen und muss gültige Anbieter-Schlüsselwortsyntax verwenden.
- `ai_generate_text.instructions` umfasst 1–4.000 Zeichen und `maxOutputChars` liegt zwischen 200 und 10.000. `ai_classify` und `ai_classify_many` unterstützen 2–10 Auswahlen mit Namen, die sich ohne Beachtung der Großschreibung unterscheiden. Ein Name umfasst 1–80 Zeichen, seine Beschreibung 1–500. `ai_classify_many.maxChoices` liegt zwischen 1 und der Anzahl der Auswahlen.
- `ai_extract_event` unterstützt 1–4.000 Zeichen Anweisungen und eine ausdrückliche IANA-`timeZone`. Die strukturierte Ausgabe enthält `ready`, Titel, optionale Beschreibung und Ort, Beginn, Ende und den Ganztagsstatus. Fehlen Titel oder Zeiten oder sind sie mehrdeutig, wird `ready: false` gesetzt. Der nachfolgende Ereignisschritt stoppt dann, statt Angaben zu erfinden.
- `link_space_item.itemId` bezeichnet eine vorhandene beschreibbare Aufgabe oder ein Ereignis. `create_space_event` benötigt eine beschreibbare `spaceId`, eine offene `columnId` und entweder ausdrückliche Ereignisdaten oder über `sourceStepId` die Ausgabe eines früheren `ai_extract_event`. Der geführte Editor zeigt diese IDs schreibgeschützt. Wähle **Element ändern** oder **Ziel ändern**, um ein anderes aktuell beschreibbares Ziel auszuwählen. Ausdrückliche Ereignisdaten verwenden `title`, optionale `description` und `location`, ISO-`startsAt` und `endsAt` sowie `allDay`. Das erstellte Ereignis enthält eine stabile Referenz zurück zur Mail-Unterhaltung.
- `create_reply_draft`, `add_comment` und `set_summary` verwenden `body: { kind: custom, value: ... }` mit 1–50.000 Zeichen oder `body: { kind: step_output, sourceStepId: ... }` für einen früheren texterzeugenden AI-Schritt. Ein Ergebnis mit mehreren Auswahlen ist keine Textquelle. Antwortentwürfe benötigen zusätzlich eine Katalog-`senderIdentityId`.
- Eine `if`-Bedingung verweist mit `sourceStepId` auf einen früheren AI-Schritt. Verwende `equals` für erzeugten Text oder eine einzelne Klassifizierung und `includes` für Mehrfachklassifizierungen. `value` umfasst 1–500 Zeichen und muss bei Klassifizierungen eine erklärte Auswahl nennen. `then` und `else` enthalten jeweils höchstens 12 Schritte.
- Eine Definition enthält 1–20 Schritte auf oberster Ebene, höchstens 40 Schritte über alle Zweige, höchstens 4 Zweigebenen und höchstens 10 AI-Aufrufe. Ein erreichbarer Pfad kann jeweils nur eine Anbieter-Nachrichtenaktion, Zuweisung, Statusänderung und Ersetzung der Zusammenfassung enthalten und dasselbe lokale Schlagwort nicht zweimal hinzufügen.

Mail erzeugt aus dem Ablauf kanonisches Workflow-YAML und zeigt es im Editor schreibgeschützt an. Die Schritte laufen von oben nach unten in der gemeinsamen Workflow-Laufzeit. Schlägt ein späterer Schritt fehl, bleiben Wirkungen früherer abgeschlossener Schritte bestehen. Eine Bearbeitung des Ablaufs veröffentlicht eine neue unveränderliche Workflow-Version. Änderungen nur am Namen oder Aktivstatus duplizieren eine identische Quelle nicht. Destruktive Aktionen dürfen keine Postfachidentität, eingerichtete interne Domain, deren Subdomains oder eine unsichere übergeordnete Domain betreffen.

Textbedingungen unterstützen exakte Übereinstimmung, Enthalten, Beginnt mit und Endet mit. Reguläre Ausdrücke sind bewusst nicht verfügbar, bis Mail einen begrenzten RE2-kompatiblen Abgleich erzwingen kann.

Neue Automatisierungen für eingehende E-Mails starten inaktiv. Ein deterministischer Ablauf kann vorhandene passende Nachrichten mit einem fortsetzbaren Backfill in der Vorschau prüfen und verarbeiten. Der dauerhafte Cursor übersteht Neustarts, eine fehlgeschlagene Nachricht wird wiederholt, ohne andere Workflow-Ausführungen zu stoppen, und ein wiederholter Backfill überspringt Nachrichten, die für dieselbe unveränderliche Version bereits angenommen wurden. Das Automatisierungsmenü zeigt den Fortschritt und ermöglicht Abbruch oder erneute Ausführung.

Abläufe mit einem AI-Schritt verarbeiten nur künftige Nachrichten. Mail-Bedingungen werden vor der AI ausgewertet. Der Bereich Sicherheit zeigt die maximale Anzahl von AI-Aufrufen pro passender Nachricht. AI kann falsch klassifizieren oder schreiben. Formuliere Kategoriebeschreibungen deshalb genau und prüfe die ersten Ausführungen unter **Aktivität**. Eine erzeugte Textausgabe hat keine Wirkung, bis ein späterer Schritt sie verwendet. Die Antwortautomatisierung erstellt ausschließlich Entwürfe zur menschlichen Prüfung und sendet sie niemals.

Spaces-Schritte laufen mit einer widerrufbaren Delegation der Person, die die Automatisierung eingerichtet hat. Mail speichert das Token verschlüsselt und widerruft es, sobald der letzte Spaces-Schritt entfernt oder die Automatisierung gelöscht wird. Jede Ausführung prüft weiterhin die aktuelle Mail-Berechtigung und den aktuellen Spaces-Zugriff. Das Verknüpfen ist ein Upsert, die Ereigniserstellung verwendet einen dauerhaften Idempotenzschlüssel. Wiederholungen erzeugen daher keine doppelten Ereignisse. Wird der delegierte API-Schlüssel widerrufen oder der Spaces-Zugriff entfernt, schlagen künftige Ausführungen sicher fehl.

Verwende `set_status: done`, um eine Unterhaltung abzuschließen. Mit `needs_action` oder `waiting` öffnest du sie ausdrücklich erneut. Eine verifizierte neue eingehende Nachricht setzt eine abgeschlossene Unterhaltung bereits auf Aktion erforderlich. Ein eigener Schritt zum „Erledigt-Status bei eingehender E-Mail entfernen“ ist daher normalerweise überflüssig.

Für die Automatisierung mit `cld` zeigt `mail automation catalog` gültige IDs. `mail automation create` und `mail automation update` übernehmen die vollständige geführte Definition als JSON oder YAML über `--definition-file` oder `--definition-stdin`, einschließlich `scope` und geordnetem `steps`-Baum. CLI und Oberfläche verhalten sich dadurch gleich, auch bei Ausgabereferenzen und verschachtelten Bedingungen.

Das Workflow-Modell der Plattform wird automatisch verwendet; Mail bietet keine eigene Modellauswahl. Verwende erweiterte **Workflows** nur, wenn die geführten Bausteine die Aufgabe nicht abdecken.

## Eine automatische Antwort einrichten {icon="send"}

:::steps
1. Bitte einen Postfachadministrator, eine Identität unter **Einstellungen > Konten & Identitäten > Absenderidentitäten** zu verifizieren und dafür **Automatische Antworten** zu erlauben.
2. Öffne **Automatisierungen > Automatische Antworten**.
3. Wähle **Automatische Antwort hinzufügen**.
4. Wähle **Abwesenheit**, **Bestätigung außerhalb der Geschäftszeiten**, **Referenzbestätigung** oder **Eigene automatische Antwort**.
5. Prüfe Absender, Betreff, Nachricht, Zeitplan, Wiederholungsschutz und das Verhalten außerhalb aktiver Zeiten.
6. Verwende **Vorschau** für Markdown-Inhalte.
7. Wähle **Automatische Antwort speichern**.
:::

Betreffzeilen und Nachrichten sind Liquid-Vorlagen. Verwende die kopierbaren Variablen im Editor, zum Beispiel `{{ inputs.message.subject }}` oder nach Vergabe einer Referenz `{{ reference.value }}`. Ungültige Syntax und nicht verfügbare Variablen werden vor dem Speichern abgelehnt.

In einem Postfach kann nur eine automatische Antwort aktiviert sein. Deaktiviere die aktive Konfiguration, bevor du eine andere einschaltest. Standardmäßig dürfen nur Postfachadministratoren automatische Antworten ändern. Ein Administrator kann dies unter **Einstellungen > Zugriff > Wer darf automatische Antworten verwalten?** auch schreibberechtigten Personen erlauben.

Mail beantwortet keine Nachrichten, bei denen automatische Antworten unsicher wären. Dazu gehören E-Mails aus Mailinglisten, Massensendungen, Zustellstatusbenachrichtigungen, Nachrichten vom Postfach selbst und Nachrichten, die automatische Antworten ausdrücklich unterdrücken. Eine unterdrückte Antwort bleibt in Aktivität und Ausführungsverlauf sichtbar; sie wird nicht unbemerkt in einen normalen Entwurf umgewandelt.

## Daten und Wochenzeiten festlegen {icon="point"}

Automatische Antworten und Antwortzeitfenster in Workflows verwenden dieselben Zeitregeln:

- **Zeitzone** bestimmt, wie alle Daten und Uhrzeiten ausgewertet werden.
- **Aktive Datumsbereiche** begrenzen den Zeitplan auf eine Abwesenheit oder Kampagne. Ohne Bereich wiederholen sich die Wochenzeiten unbegrenzt.
- **Wochenzeiten** führen jeden Wochentag einzeln auf. Eine aktivierte Wochentagskarte ist eingeschaltet. Aktiviere **Ganztägig** für `00:00–24:00` oder füge mehrere nicht überlappende Zeitfenster hinzu. Eine als **Deaktiviert** markierte Karte sendet nie eine Antwort.
- **Datumsausnahmen** schließen ein Datum oder ersetzen dessen normale Zeiten.
- **Nicht antworten** unterdrückt Nachrichten, die außerhalb eines aktiven Zeitfensters eingehen.
- **Zum nächsten aktiven Zeitpunkt antworten** hält die Antwort bis zum nächsten aktiven Zeitfenster zurück.

Eine Ausnahme hat Vorrang vor normalen Wochenzeiten. Zeitfenster dürfen Mitternacht nicht überschreiten. Lege eines vor Mitternacht und ein weiteres am Folgetag an.

## Wiederholungsschutz verstehen {icon="shield-lock"}

Der **Wiederholungsschutz** ist die Mindestzeit, bevor derselbe Absender eine weitere automatische Antwort aus diesem Postfach erhalten kann.

- Die Vorlage **Abwesenheit** verwendet 96 Stunden oder 4 Tage. Wer während einer Abwesenheit mehrmals schreibt, erhält dadurch nicht täglich dieselbe Nachricht.
- **Bestätigung außerhalb der Geschäftszeiten** und **Eigene automatische Antwort** verwenden 24 Stunden.
- `0` deaktiviert das Absenderintervall. Mail verhindert weiterhin doppelte Antworten auf dieselbe eingehende Nachricht und behält seine Schutzmaßnahmen auf Protokollebene bei.

Wähle nur dann ein kürzeres Intervall, wenn wiederholte Bestätigungen für den Empfänger nützlich sind. Der Wert gilt postfachweit für diese automatische Antwort und ist keine Verzögerung vor der ersten Antwort.

In einem YAML-Workflow stehen diese Regeln direkt unter `automaticReply.schedule`. Der Zeitplan gehört zur unveränderlichen Workflow-Version. Mit der Prüfung und Aktivierung der Version werden daher auch ihre Zeiten geprüft und aktiviert. Die vollständige YAML-Struktur findest du unter [Mail-Workflows erstellen](/app/mail/help/mail-workflows#send-a-guarded-automatic-reply).

## Referenzen für Unterhaltungen erstellen {icon="square-plus"}

Eine Unterhaltungsreferenz ist eine dauerhafte, postfachbezogene Kennung wie `REF-K7M3-P9QX-2F4N`. Sie erleichtert das Zitieren, Suchen und Prüfen einer Unterhaltung, auch wenn sich Betreffzeilen ändern.

:::steps
1. Öffne **Automatisierungen > Automatische Antworten** und wähle **Referenzbestätigung** oder öffne **Workflows** für eigenes YAML.
2. Gibt es noch kein Referenzformat, richte es direkt im selben Antworteditor oder im Referenzbereich der Workflow-Seite ein.
3. Gib ein Liquid-Muster mit genau einer Kennungsausgabe ein. Der datenschutzfreundliche Standard ist `REF-{{ short_id }}`. Der Editor erläutert jeden Platzhalter und zeigt eine Vorschau.
4. Speichere das Format, ohne die bereits eingegebene Antwort zu verlassen oder zu verlieren.
5. Schließe die automatische Antwort ab oder füge deinem Workflow `ensureConversationReference` hinzu.
:::

Unterstützte Musterbestandteile:

- `{{ short_id }}` fügt eine kurze, lesbare Zufalls-ID ein, ohne Volumen oder Vergabezeit offenzulegen.
- `{{ uuid }}` fügt eine nicht deutbare zufällige UUID ein.
- `{{ uuid_v7 }}` fügt eine sortierbare UUID ein, die ihren Vergabezeitpunkt offenlegt.
- `{{ ulid }}` fügt eine kompakte sortierbare ID ein, die ihren Vergabezeitpunkt offenlegt.
- `{{ sequence }}` fügt die nächste postfachbezogene Nummer ein und legt damit Reihenfolge und ungefähres Volumen offen.
- `{{ sequence | pad_start: 6 }}` füllt den Zähler auf sechs Stellen auf. Die Breite kann zwischen 1 und 120 liegen.
- `{{ year }}`, `{{ month }}`, `{{ month_name }}` und `{{ day }}` fügen Teile des UTC-Vergabedatums ein.
- Buchstaben, Zahlen, Leerzeichen, `.`, `_`, `-` und `/` können als feste Trennzeichen verwendet werden.

Verwende genau eine der fünf Kennungsausgaben. Datumsbestandteile sind optional und machen eine Referenz nicht eindeutig. Die Vergabe ist idempotent: Eine erneute Ausführung derselben Aktion gibt die bestehende Referenz der Unterhaltung zurück, statt eine neue anzulegen. Referenzen bleiben nach dem Zusammenführen von Unterhaltungen als Aliase erhalten. Wird die Vergabe deaktiviert, entstehen keine neuen Referenzen; vorhandene Werte werden nicht geändert.

Die Vorlage **Referenzbestätigung** vergibt die Referenz vor dem Senden und fügt `{{ reference.value }}` in die Nachricht ein. Dieselbe Ergebnisbindung ist in eigenem YAML verfügbar. Sobald eine Unterhaltung eine Referenz hat, verwenden neue Antwortbetreffzeilen standardmäßig `Re: [REF-K7M3-P9QX-2F4N] Original subject`. Mail verknüpft Antworten weiterhin über die Standardkopfzeilen `Message-ID`, `In-Reply-To` und `References`.

## Einen Workflow sicher speichern und aktivieren {icon="route"}

:::steps
1. Öffne **Automatisierungen > Workflows** und wähle **Neuer Workflow**.
2. Gib Name, Beschreibung, Priorität, YAML und Effektbudgets ein.
3. Wähle **Validieren** und behebe jede zeilenbezogene Diagnose.
4. Wähle **Workflow erstellen** oder **Version speichern**.
5. Prüfe die neue Version unter **Versionen**.
6. Wähle **Aktivieren** oder **Aktuelle Version aktivieren**.
7. Prüfe die erste passende Ausführung unter **Automatisierungen > Aktivität**. Plattformbetreiber können außerdem **Admin > Beobachtbarkeit > Workflows** verwenden.
:::

Das Speichern aktiviert niemals eine Version. Eine bereits aktive Version läuft weiter, bis ein Administrator die neuere ausdrücklich aktiviert. **Aktualisierung verfügbar** bedeutet, dass sich die gespeicherte aktuelle und die aktive Version unterscheiden.

Effektbudgets sind feste Obergrenzen für Verschiebungen, Sendungen, Schlüsselwortänderungen, Änderungen an der Zusammenarbeit und AI-Aufrufe innerhalb einer Ausführung. Eine Ausführung stoppt, bevor sie einen Effekt oberhalb des Budgets anwendet. AI-Ausgaben bleiben Daten, bis eine spätere Mail-Aktion sie verwendet. Klassifizierung, Kennzeichnung, Zuweisung, Entwurf und Versand bleiben dadurch unabhängig prüfbare Schritte.

## Workflow-Ausführungen beobachten und stoppen {icon="activity"}

Postfachadministratoren verwenden **Automatisierungen > Aktivität** für postfachbezogene automatische Antworten, eingehende Automatisierungen, eigene Workflows und fortsetzbare Backfills. Die Tabelle zeigt Automatisierungstyp, Status, Dauer, Zeitpunkt und eine begrenzte Fehler- oder Ergebnismeldung. Plattformadministratoren behalten die anwendungsübergreifende Detailansicht unter **Admin > Beobachtbarkeit > Workflows**.

Wähle **Abbrechen**, wenn keine weiteren Effekte beginnen sollen. Der Abbruch macht bereits abgeschlossene Verschiebungen, Sendungen oder Änderungen an der Zusammenarbeit nicht rückgängig. Eine Ausführung mit Klärungsbedarf wartet darauf, dass ein Administrator festhält, ob ein unklarer externer Effekt eingetreten ist. Das Deaktivieren eines Mail-Workflows verhindert neue passende Auslöser; der abgeschlossene Verlauf bleibt unverändert.

Das vollständige YAML-Vokabular und validierte Beispiele findest du unter [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows).
