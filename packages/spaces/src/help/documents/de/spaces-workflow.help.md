---
id: spaces-workflow
title: Arbeit planen und verfolgen
icon: ti ti-arrow-bounce
description: Erstelle Einträge, beginne mit Vorlagen, strukturiere Aufgaben und halte laufende Arbeit und Übergaben übersichtlich.
order: 120
---

Spaces funktioniert am besten, wenn jeder Eintrag einen klaren nächsten Schritt hat. Halte Titel kurz und ergänze den Kontext in den Notizen. Zeige den Arbeitsstand mit Status oder Datumsangaben. Nutze Termine, wenn die Arbeit hauptsächlich im Kalender geplant wird.

## Eintrag erstellen {icon="square-plus"}

Beim Erstellen eines Eintrags wählt Spaces anhand der aktuellen Ansicht zunächst Aufgabe oder Termin aus. Du kannst den Typ oben im Dialog wechseln. Das kompakte Formular fragt nach Titel und Beschreibung. Termine brauchen zusätzlich ihre Zeit.

Wähle **Weitere Optionen**, um alle Felder für Aufgaben oder Termine zu sehen. Deine Eingaben bleiben erhalten. Eine Aufgabe bekommt den Status, in dem du sie erstellst, oder den ersten Status, wenn keiner ausgewählt ist.

## Eine Fälligkeit festlegen {icon="calendar-due"}

Fälligkeiten sind standardmäßig ganztägig. Wähle ein Datum, an dem die Aufgabe fällig ist. **Uhrzeit hinzufügen** ergänzt eine feste Uhrzeit; **Uhrzeit entfernen** macht die Fälligkeit wieder ganztägig.

Eine ganztägige Fälligkeit wird erst am Folgetag in der Anwendungszeitzone überfällig. Am gewählten Tag zählt sie den ganzen Tag als heute fällig. Im Kalender steht sie in der Tages- und Wochenansicht in der Ganztagszeile, in der Monats- und Jahresansicht an ihrem Datum. Bestehende Fälligkeiten mit Uhrzeit behalten ihre Uhrzeit.

## Mit einer Vorlage beginnen {icon="template"}

Hat ein Space Vorlagen, zeigt der Dialog für eine neue Aufgabe oder einen neuen Termin die Zeile **Vorlage**. Die Zeile bietet **Leer** und die Vorlagen für diese Art von Eintrag. Bei mehr als sechs Vorlagen wird die Zeile zu einer durchsuchbaren Liste.

Eine Vorlage füllt Titel, Beschreibung, Priorität, Tags und Zuständige aus. Bei Aufgaben füllt sie auch die Checkliste aus, bei Terminen Ort, Uhrzeit und Dauer. Eine Zeile unter der Beschreibung fasst zusammen, was die Vorlage ergänzt. Jedes Feld bleibt vor dem Speichern änderbar, und **Weitere Optionen** zeigt alle Felder. Hast du schon etwas eingegeben, fragt Spaces, bevor eine Vorlage es ersetzt.

Eine Vorlage kann Daten vorschlagen:

- Eine Regel wie „Mittwoch oder Donnerstag“ zeigt die nächsten passenden Tage als Auswahl, zum Beispiel **Mi 14.10.**, **Do 15.10.** und **Mi 21.10.** Eine Regel wie „in 3 Tagen“ schlägt ein Datum vor.
- Der erste Vorschlag ist ausgewählt. Wähle einen anderen Vorschlag, **Anderes Datum…** für ein beliebiges Datum oder **Kein Datum** für eine Aufgabe ohne Fälligkeit.
- Bei Terminen bleibt das Zeitfeld darunter für jede andere Zeit verfügbar.
- Die Vorschläge richten sich nach deiner Zeitzone. Bei einer Wochentagsregel bleibt heute für eine ganztägige Aufgabe den ganzen Tag verfügbar. Eine Vorlage mit Uhrzeit bietet heute nur an, solange diese Uhrzeit noch bevorsteht.
- Die Platzhalter `{{date}}`, `{{weekday}}` und `{{week}}` in Titel und Beschreibung folgen dem gewählten Datum, bis du den Text änderst. Das gilt auch bei **Kein Datum** und bei einer Auswahl im Kalender.

Mit Zugriff **Verwalten** richtest du Vorlagen in den Space-Einstellungen unter **Vorlagen** ein: Name, Vorgaben, Datumsregel und Fälligkeits- oder Startzeit. **Mir zuweisen** weist die Person zu, die den Eintrag anlegt. Eine geänderte oder gelöschte Vorlage ändert keine Einträge, die schon daraus entstanden sind. Alle, die Einträge anlegen können, können die Vorlagen nutzen.

## Eintrag strukturieren {icon="point"}

:::reference
- **Titel:** Nutze eine klare Handlung oder eine kurze Nominalphrase. Formuliere den Titel so, dass er in der Liste ohne Öffnen verständlich ist.
- **Zuständige:** Weise Personen oder Dienstkonten mit eigenem Zugriff auf den Space zu, wenn der Eintrag weiterverfolgt werden muss. Lass den Eintrag ohne Zuständigkeit, wenn er in einen gemeinsamen Arbeitsvorrat gehört.
- **Status:** Zeige den Stand der Arbeit mit einem Status. Kanban-Ansichten brauchen einen einheitlich genutzten Status.
- **Fälligkeitsdatum oder Terminzeit:** Nutze für Aufgaben ein Fälligkeitsdatum und für Termine eine feste Zeit, wenn der Zeitpunkt den nächsten Schritt beeinflusst.
- **Geschätzte Dauer:** Trage eine positive Dauer in ganzen Minuten ein, wenn sie beim Einschätzen oder Einplanen einer Aufgabe hilft. Bei Terminen ergibt sich die Dauer stattdessen aus Start- und Endzeit.
- **Blockiert durch:** Füge jede noch offene Aufgabe hinzu, die zuerst abgeschlossen werden muss. Eine blockierte Aufgabe lässt sich erst abschließen, wenn alle aktiven blockierenden Aufgaben erledigt sind. Abhängigkeiten müssen innerhalb eines Space bleiben und dürfen keinen Zyklus bilden.
- **Blockiert:** Die Aufgabendetails zeigen die umgekehrte Richtung: alle Aufgaben, die derzeit von dieser Aufgabe abhängen.
- **Verwandte Aufgaben:** Verknüpfe Aufgaben, die einen gemeinsamen Kontext haben, aber nicht voneinander abhängen. Eine solche Verknüpfung blockiert keine Aufgabe.
- **Links & Ressourcen:** Hänge Cloud-Ressourcen und externe Seiten an, etwa das GitHub-Issue, das eine Aufgabe umsetzt. Links auf GitHub-Issues und Pull Requests zeigen den Titel und ob sie offen, geschlossen oder gemergt sind.
- **Checkliste:** Teile eine Aufgabe in kleine Schritte auf, wenn Kästchen und Bezeichnung genügen. Checklistenpunkte haben bewusst keine Zuständigkeiten, Termine oder eigene Detailansicht.
- **Wiederholung:** Nutze wiederkehrende Termine für regelmäßige Besprechungen oder Abläufe. Einmalige Aufgaben bleiben normale Aufgaben.
- **Tags:** Nutze Tags für Themen, die unabhängig von Zuständigkeiten und Status gelten, zum Beispiel Frontend, Rechtliches, Blockiert oder Besprechung.
- **Anhänge:** Füge einer Aufgabe Screenshots, andere Bilder und Videos hinzu, wenn die Arbeit visuellen Kontext braucht. Beispiele sind ein Fehlerbericht oder ein Reel, das jemand genehmigen soll.
:::

## Bilder und Videos an eine Aufgabe anhängen {icon="photo"}

Wähle **Bild oder Video hinzufügen** oder ziehe Bilder und Videos von deinem Gerät irgendwo auf die geöffnete Aufgabe. Jede Aufgabe unterstützt bis zu 20 Anhänge.

- Spaces verkleinert große Ausgangsbilder vor dem Hochladen. Videos lässt Spaces unverändert.
- Spaces nimmt Videos im Format MP4, MOV, M4V, WebM und OGV mit bis zu 10 MB an.
- Wähle ein vorhandenes Bild aus, um die Anhangsgalerie zu öffnen. Dort kannst du das gespeicherte Bild herunterladen oder entfernen.
- Ein Video zeigt sein erstes Bild. Wähle es aus, um es mit den Steuerelementen deines Browsers abzuspielen. Du siehst das ganze Bild, auch als Hochformat-Reel, und kannst das Video herunterladen.
- Kann dein Browser das Format eines Videos nicht abspielen, bietet Spaces stattdessen den Download an.

Für Anhänge und ihre Automatisierungsverknüpfungen gilt derselbe Zugriff wie für die Aufgabe: Zugriff **Ansehen**, um sie zu sehen, Zugriff **Bearbeiten**, um sie zu ändern.

## In den Aufgabendetails planen {icon="list-details"}

Der Block **Planung** oben in den Aufgabendetails zeigt Fälligkeit, Schätzung, Priorität, Tags und Abhängigkeiten. Mit Zugriff **Bearbeiten** änderst du jeden Wert direkt dort:

- Wähle die Zeile, um ein Datum auszusuchen, eine Priorität zu wählen oder Tags anzuhaken.
- Für die Schätzung tippst du die Minuten ein und drückst die **Eingabetaste**.
- **Keine Priorität** am Ende der Liste entfernt die Priorität. **Datum löschen** im Kalender entfernt das Fälligkeitsdatum.
- Der Stift öffnet das vollständige Formular.

Unter **Blockiert durch** steht jede blockierende Aufgabe mit Titel und Stand: ein Schloss für eine offene Aufgabe, ein Haken und **erledigt** für eine abgeschlossene. Wähle eine Aufgabe, um sie zu öffnen. **+ Aufgabe** sucht im Space nach einer weiteren blockierenden Aufgabe. Das × neben einer blockierenden Aufgabe entfernt sie.

**Blockiert** listet die Aufgaben, die auf diese warten. Ab fünf Einträgen zeigt eine Liste drei, offene zuerst, und fasst den Rest unter **N weitere** zusammen. Ohne Zugriff **Bearbeiten** siehst du dieselben Werte ohne die Bearbeitungsaktionen.

## Den Tag abarbeiten {icon="route"}

:::steps
1. **Passende Ansicht öffnen:** Beginne mit **Liste**, **Tabelle**, **Kanban**, **Kalender** oder dem Filterzustand, der zur aktuellen Arbeit passt.
2. **Zuerst den Status aktualisieren:** Der Status zeigt allen, was sich geändert hat, bevor sie den Eintrag öffnen.
3. **Blockierende Aufgaben prüfen:** Ändert sich die vorausgehende Arbeit, schließe aktive blockierende Aufgaben ab oder entferne die Abhängigkeit. Abgeschlossene blockierende Aufgaben bleiben als Kontext sichtbar.
4. **Kontext ergänzen:** Nutze Kommentare für Diskussionen. Nutze Notizen für aktuelle Anweisungen oder dauerhaften Kontext.
5. **Erledigte Arbeit abschließen:** Nimm abgeschlossene Einträge aus den aktiven Ansichten, damit die offenen Listen übersichtlich bleiben.
:::

Du kannst einen eigenen Kommentar bis zu zehn Minuten nach dem Veröffentlichen bearbeiten oder löschen. Kommentare anderer Personen bleiben unverändert, auch für Personen mit Zugriff **Verwalten**.

## Mit einem Emoji reagieren {icon="mood-plus"}

Du brauchst Zugriff **Bearbeiten**, um zu reagieren. Reaktionen senden keine Benachrichtigungen.

:::steps
1. Wähle auf einer Kanban-Karte einen Emoji-Chip, um deine Reaktion hinzuzufügen oder zu entfernen.
2. Zeige mit der Maus auf die Karte. Wähle **Reaktion hinzufügen**, um ein anderes Emoji auszuwählen.
3. Öffne auf einem Smartphone oder Tablet den Eintrag. Wähle über den Kommentaren einen Chip oder **Reaktion hinzufügen**.
4. Zeige auf einen Chip, um zu sehen, wer reagiert hat. Halte auf einem Touchscreen den Chip gedrückt.
5. Wenn das Speichern fehlschlägt, wähle in der Fehlermeldung **Erneut versuchen**.
:::

Ein Eintrag kann bis zu 20 verschiedene Emojis haben. Wenn er 20 hat, reagiere mit einem davon.

## Schnell mit der Tastatur arbeiten {icon="keyboard"}

- Wenn ein Eintrag geöffnet ist, drücke **J** für den nächsten und **K** für den vorherigen Eintrag in Liste, Tabelle und Kanban.
- Drücke **Cmd/Strg+Alt+N**, um eine Aufgabe oder in der Kalenderansicht einen Termin zu erstellen.
- Drücke **Cmd/Strg+Umschalt+K**, um den aktuellen Space zu durchsuchen.
- Fokussiere in Kanban das Board und wechsle mit den Pfeiltasten zwischen Karten. Die Tastatur-Schaltfläche über dem Board listet diese Kürzel.
- Um eine Karte zu verschieben, fokussiere ihren Griff, drücke die **Leertaste** und nutze die Pfeiltasten. Drücke die **Leertaste**, um sie abzulegen, oder **Escape**, um abzubrechen.
- Drücke die **Eingabetaste**, um die fokussierte Karte zu öffnen, **M**, um sie dir zuzuweisen, oder **D**, um sie zu erledigen.

Während du in einem Feld oder Editor schreibst, bleiben diese Einzeltasten-Kürzel inaktiv. Die Cloud-Suche und die Layout-Hilfe zeigen die verfügbaren Aktionen und ihre Kürzel ebenfalls.

## Aufgabe übernehmen und übergeben {icon="notes"}

Aufgaben können eine Fortschrittsnotiz und ein Abschlussergebnis enthalten. Die Aufgabendetails zeigen beides als **Letzter Stand** und **Letztes Ergebnis** unter der Liste **Zuständig**. Beim Wiederöffnen bleibt das letzte Ergebnis erhalten.

Wähle **Ich übernehme** auf einer Karte im Board oder in den Aufgabendetails, um eine Aufgabe zu übernehmen. Wähle **Freigeben**, um die Übernahme freizugeben. In den Details kannst du dabei eine kurze Übergabenotiz hinterlassen.

Solange eine Aufgabe übernommen ist, sehen andere, wer daran arbeitet:

- Board-Karten, Listenzeilen und Tabellenzellen zeigen die arbeitende Person zuerst im Avatar-Stapel mit einem grünen Ring. Sie erscheint einmal und nie im `+N`-Überlauf.
- Der Filter **In Arbeit** listet übernommene Aufgaben.
- In den Details ist **Zuständig** eine gemeinsame Liste. Die Zeile der arbeitenden Person steht zuerst und zeigt den grünen Ring, **arbeitet daran** und seit wann sie daran arbeitet.

Gehört die Übernahme zu keinem der Zuständigen, etwa bei einem persönlichen Automatisierungsschlüssel oder einem gelöschten Konto, zeigt die Liste dieses Konto trotzdem zuerst mit seinem Arbeitsstatus. Diese Zeile kannst du nicht entfernen.

Wenn du eine Aufgabe übernimmst, wirst du ihr auch zugewiesen. Die Übernahme zeigt, wer von den Zuständigen gerade daran arbeitet. Gibst du deine eigene Übernahme frei, bleibst du zugewiesen. Die Spalte ändert sich nicht. **Mir zugewiesen** enthält auch Aufgaben, die du übernommen hast. **Nicht zugewiesen** schließt Aufgaben aus, die eine Person oder ein Agent übernommen hat. Aktive Dienstkonten mit eigenem Zugriff auf den Space können zugewiesen werden; Space-API-Schlüssel nur in ihrem eigenen Space. Persönliche Automatisierungsschlüssel können nicht zugewiesen werden. Ein Konto, das eine Aufgabe übernimmt, wird auch ohne eigenen Zugriff zugewiesen, zum Beispiel mit Zugriff für alle angemeldeten Konten. **Mir zugewiesen** bleibt auf deine persönlichen Zuweisungen begrenzt.

**Übernehmen** verschiebt die Übernahme und die Zuständigkeit zu dir. Im CLI entfernt `release --force` auch die Zuweisung des bisherigen Kontos. War es allein zuständig, ist die Aufgabe danach nicht zugewiesen.

Entfernst du eine arbeitende Person oder ein Dienstkonto aus **Zuständig**, endet die Übernahme. Bei einem anderen Konto bestätigst du das einmal. Hat jemand die Aufgabe inzwischen übernommen, lehnt Spaces eine Liste ohne dieses Konto ab. Lies die Aufgabe erneut. Gib im CLI die Übernahme frei, bevor du das Konto mit `assign` oder `set` entfernst.

Übernahmen laufen nicht ab. Sie koordinieren die Arbeit, sperren sie aber nicht: Mit Zugriff **Bearbeiten** kannst du eine übernommene Aufgabe zwischen offenen Spalten verschieben, und gewöhnliche gemeinsame Bearbeitungen bleiben möglich. Erledigst du deine eigene übernommene Aufgabe, auch per Ziehen in eine Erledigt-Spalte, wird die Übernahme freigegeben. Mit Zugriff **Bearbeiten** siehst du bei der Übernahme eines anderen Kontos **Übernehmen**. Du bestätigst das in einem Dialog, der das bisherige Konto nennt. Erledigst du eine Aufgabe, die jemand anderes übernommen hat, etwa per Ziehen in eine Erledigt-Spalte, fragt Spaces einmal nach, zum Beispiel „Von Jana Berger übernommen – übernehmen und abschließen?“. Danach übernimmt und erledigt Spaces die Aufgabe in einem Schritt. Die Zuweisungen ändern sich nicht. **Abbrechen** lässt die Karte an ihrem Platz. Schickst du eine Aufgabe durch ein Wormhole in einen anderen Space, endet die Übernahme auf dieselbe Weise: Deine eigene Übernahme endet ohne Nachfrage, eine fremde übernimmst du nach einer Bestätigung. Die Aktivität zeigt, wer eine Aufgabe von wem übernommen hat.

## Einladungen über die Cloud-Suche vorbereiten {icon="calendar-event"}

Du brauchst Zugriff zum Bearbeiten des Termins und ein geeignetes Postfach.

:::steps
1. Öffne einen Termin. Die Cloud-Suche bietet dann **Einladung vorbereiten** an.
2. Gibt es schon eine Einladung, bereite stattdessen ihr Update oder ihre Absage vor.
3. Wähle das sendende Postfach und die Empfänger.
4. Prüfe und versende den Entwurf anschließend in Mail.
:::
