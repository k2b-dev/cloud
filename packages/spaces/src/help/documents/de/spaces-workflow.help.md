---
id: spaces-workflow
title: Arbeitsablauf
icon: ti ti-arrow-bounce
description: Einträge klar strukturieren und laufende Arbeit übersichtlich halten.
order: 120
---

Spaces funktioniert am besten, wenn jeder Eintrag einen klaren nächsten Schritt beschreibt. Halte Titel kurz, ergänze den Kontext in den Notizen und kennzeichne den Arbeitsstand durch Status oder Datumsangaben. Verwende Termine, wenn die Arbeit hauptsächlich im Kalender geplant wird.

Beim Erstellen eines Eintrags wählt Spaces anhand der aktuellen Ansicht zunächst Aufgabe oder Termin aus. Du kannst den Typ oben im Dialog wechseln. Das kompakte Formular fragt nach Titel und Beschreibung, bei Terminen zusätzlich nach der Zeit. Unter **Weitere Optionen** findest du alle Felder für Aufgaben oder Termine, ohne deine Eingaben zu verlieren. Eine Aufgabe verwendet den Status, in dem du sie erstellst, oder den ersten Status, wenn keiner ausgewählt ist.

## Mit einer Vorlage beginnen {icon="template"}

Hat ein Space Vorlagen, zeigt der Dialog für eine neue Aufgabe oder einen neuen Termin die Zeile **Vorlage** mit **Leer** und den Vorlagen dieser Art. Eine Vorlage füllt Titel, Beschreibung, Priorität, Tags, Zuständige und bei Aufgaben die Checkliste, bei Terminen Ort, Uhrzeit und Dauer aus. Eine Zeile unter der Beschreibung fasst zusammen, was die Vorlage ergänzt. Jedes Feld bleibt vor dem Speichern änderbar, und **Weitere Optionen** zeigt alle Felder. Hast du schon etwas eingegeben, fragt Spaces, bevor eine Vorlage es ersetzt. Bei mehr als sechs Vorlagen wird die Zeile zu einer durchsuchbaren Liste.

Eine Vorlage kann Daten vorschlagen. Eine Regel wie „Mittwoch oder Donnerstag“ zeigt die nächsten passenden Tage als Auswahl, zum Beispiel **Mi 14.10.**, **Do 15.10.** und **Mi 21.10.**; „in 3 Tagen“ schlägt ein Datum vor. Der erste Vorschlag ist ausgewählt. Wähle einen anderen Vorschlag, **Anderes Datum…** für ein beliebiges Datum oder **Kein Datum** für eine Aufgabe ohne Fälligkeit. Bei Terminen bleibt das Zeitfeld darunter für jede andere Zeit verfügbar. Die Vorschläge richten sich nach deiner Zeitzone, und bei einer Wochentagsregel erscheint heute nur, solange die Uhrzeit der Vorlage noch nicht vorbei ist. Die Platzhalter `{{date}}`, `{{weekday}}` und `{{week}}` in Titel und Beschreibung folgen dem gewählten Datum, auch bei **Kein Datum** oder einer Auswahl im Kalender, bis du den Text änderst.

Space-Administratoren verwalten Vorlagen in den Space-Einstellungen unter **Vorlagen**: Name, Vorgaben, Datumsregel und Fälligkeits- oder Startzeit. **Mir zuweisen** weist die Person zu, die den Eintrag anlegt. Eine geänderte oder gelöschte Vorlage ändert keine Einträge, die schon daraus entstanden sind. Alle, die Einträge anlegen dürfen, können die Vorlagen verwenden.

## Einträge sinnvoll strukturieren {icon="point"}

:::reference
- **Titel:** Verwende eine klare Handlung oder kurze Nominalphrase. Der Titel sollte bereits in der Liste verständlich sein, ohne den Eintrag zu öffnen.
- **Zuständige:** Weise Personen zu, wenn eine Aufgabe weiterverfolgt werden muss. Lass den Eintrag ohne Zuständigkeit, wenn er in einen gemeinsamen Arbeitsvorrat gehört.
- **Status:** Kennzeichne den Stand der Arbeit mit einem Status. Kanban-Ansichten setzen eine einheitliche Verwendung voraus.
- **Fälligkeitsdatum oder Terminzeit:** Verwende für Aufgaben ein Fälligkeitsdatum und für Termine eine feste Zeit, wenn der Zeitpunkt den nächsten Arbeitsschritt beeinflusst.
- **Geschätzte Dauer:** Trage eine positive Dauer in ganzen Minuten ein, wenn sie beim Einschätzen oder Einplanen einer Aufgabe hilft. Bei Terminen ergibt sich die Dauer stattdessen aus Start- und Endzeit.
- **Blockiert durch:** Füge jede noch offene Aufgabe hinzu, die zuerst abgeschlossen werden muss. Eine blockierte Aufgabe kann erst abgeschlossen werden, wenn alle aktiven blockierenden Aufgaben erledigt sind. Abhängigkeiten müssen innerhalb eines Space bleiben und dürfen keinen Zyklus bilden.
- **Blockiert:** Die Aufgabendetails zeigen die umgekehrte Richtung: alle Aufgaben, die derzeit von dieser Aufgabe abhängen.
- **Verwandte Aufgaben:** Verknüpfe Aufgaben, die einen gemeinsamen Kontext haben, aber nicht voneinander abhängen. Eine solche Verknüpfung blockiert keine Aufgabe.
- **Links & Ressourcen:** Hänge Cloud-Ressourcen und externe Seiten an, etwa das GitHub-Issue, das eine Aufgabe umsetzt. Links auf GitHub-Issues und Pull Requests zeigen Titel und Status: offen, geschlossen oder gemergt.
- **Checkliste:** Teile eine Aufgabe in kleine Schritte auf, wenn Checkbox und Bezeichnung ausreichen. Checklistenpunkte haben bewusst keine Zuständigkeiten, Termine oder eigene Detailansicht.
- **Anhänge:** Füge einer Aufgabe Screenshots, andere Bilder und Videos hinzu, wenn die Arbeit visuellen Kontext benötigt, etwa bei einem Fehlerbericht oder einem Reel zur Freigabe. Nutze dafür **Bild oder Video hinzufügen** oder ziehe Bilder und Videos von deinem Gerät irgendwo auf die geöffnete Aufgabe. Spaces verkleinert große Ausgangsbilder vor dem Hochladen und lässt Videos unverändert. Es nimmt Videos im Format MP4, MOV, M4V, WebM und OGV mit bis zu 10 MB an. Wähle ein vorhandenes Bild aus, um die Anhangsgalerie zu öffnen, das gespeicherte Bild herunterzuladen oder es zu entfernen. Wähle ein Video aus, das sein erstes Bild zeigt, um es mit den Steuerelementen deines Browsers abzuspielen, das ganze Bild auch als Hochformat-Reel zu sehen oder es herunterzuladen. Kann dein Browser das Format eines Videos nicht abspielen, bietet Spaces stattdessen den Download an. Jede Aufgabe unterstützt bis zu 20 Anhänge. Für Anhänge und ihre Automatisierungsverknüpfungen gelten dieselben Lese- und Schreibrechte wie für die Aufgabe.
- **Wiederholung:** Verwende wiederkehrende Termine für regelmäßige Besprechungen oder Abläufe. Einmalige Aufgaben bleiben normale Aufgaben.
- **Tags:** Verwende Tags für Themen, die unabhängig von Zuständigkeiten und Status gelten, zum Beispiel Frontend, Rechtliches, Blockiert oder Besprechung.
:::

## In den Aufgabendetails planen {icon="list-details"}

Der Block **Planung** oben in den Aufgabendetails zeigt Fälligkeit, Schätzung,
Priorität, Tags und Abhängigkeiten. Mit Schreibrechten änderst du jeden Wert
direkt dort: Wähle die Zeile, um ein Datum auszusuchen, die Schätzung in
Minuten einzutippen und mit Enter zu übernehmen, eine Priorität zu wählen oder
Tags anzuhaken. **Keine Priorität** am Ende der Liste entfernt die Priorität;
**Datum löschen** im Kalender entfernt das Fälligkeitsdatum. Der Stift öffnet
das vollständige Formular.

Unter **Blockiert durch** steht jede blockierende Aufgabe mit Titel und Stand:
ein Schloss für eine offene Aufgabe, ein Haken und **erledigt** für eine
abgeschlossene. Wähle eine Aufgabe, um sie zu öffnen. **+ Aufgabe** sucht im
Space nach einer weiteren blockierenden Aufgabe, und das × neben einer
Aufgabe entfernt sie. **Blockiert** listet die Aufgaben, die auf diese warten.
Ab fünf Einträgen zeigt eine Liste drei, offene zuerst, und fasst den Rest
unter **N weitere** zusammen. Ohne Schreibrechte siehst du dieselben Werte ohne
die Bearbeitungsaktionen.

## Täglicher Arbeitsablauf {icon="route"}

:::steps
1. **Passende Ansicht öffnen:** Beginne mit der Liste, Tabelle, dem Kanban-Board, Kalender oder Filterzustand, der zur aktuellen Arbeit passt.
2. **Zuerst den Status aktualisieren:** Der Status zeigt allen Personen, was sich geändert hat, bevor sie den Eintrag öffnen.
3. **Blockierende Aufgaben prüfen:** Schließe aktive blockierende Aufgaben ab oder entferne die Abhängigkeit, wenn sich die vorausgehende Arbeit ändert. Abgeschlossene blockierende Aufgaben bleiben als Kontext sichtbar.
4. **Kontext in Notizen oder Kommentaren ergänzen:** Verwende Kommentare für Diskussionen. Notizen enthalten aktuelle Anweisungen oder dauerhaft relevanten Kontext.
5. **Erledigte Arbeit abschließen:** Entferne abgeschlossene Einträge aus den aktiven Ansichten, damit die offenen Listen übersichtlich bleiben.
:::

Du kannst einen eigenen Kommentar bis zu zehn Minuten nach dem Veröffentlichen bearbeiten oder löschen. Kommentare anderer Personen bleiben unverändert. Das gilt auch für Personen mit Adminzugriff auf den Space.

## Schnell mit der Tastatur arbeiten {icon="keyboard"}

Drücke **Cmd/Strg+Alt+N**, um eine Aufgabe oder in der Kalenderansicht einen Termin zu erstellen, und **Cmd/Ctrl+Shift+K**, um den aktuellen Space zu durchsuchen. Fokussiere im Kanban-Board eine Karte und wechsle mit den Pfeiltasten zwischen Karten; die Tastatur-Schaltfläche über dem Board listet diese Kürzel. Mit **Enter** öffnest du die fokussierte Karte, mit **M** weist du sie dir zu und mit **D** erledigst du sie. Während du in einem Feld oder Editor schreibst, bleiben diese Einzeltasten-Kürzel inaktiv. Verfügbare Aktionen und ihre Kürzel findest du auch in der Cloud-Suche und in der Layout-Hilfe.

## Umsetzung und Übergabe {icon="notes"}

Aufgaben können eine Fortschrittsnotiz und ein Abschlussergebnis enthalten. Die
Aufgabendetails zeigen beides als **Letzter Stand** und **Letztes Ergebnis**
unter der Liste **Zuständig**. Beim Wiederöffnen bleibt das letzte Ergebnis
erhalten.

Mit **Ich übernehme** auf einer Karte im Board oder in den Aufgabendetails
übernimmst du eine Aufgabe; ein zweiter Klick gibt sie frei, und in den Details
kannst du dabei eine kurze Übergabenotiz hinterlassen. Solange eine Aufgabe
übernommen ist, zeigt die Karte in jeder Spalte den Avatar der Person mit grünem
Ring vor den Zuständigen, und der Filter **In Arbeit** listet übernommene
Aufgaben. In den Details steht diese Person mit demselben Ring, dem Hinweis
**arbeitet daran** und der Zeit, seit der sie daran arbeitet, zuerst unter
**Zuständig**; ist sie nicht zugewiesen, steht das dabei. Eine Übernahme markiert nur, wer gerade daran arbeitet;
Zuweisung und Spalte ändern sich nicht. CLI-Worker und Service-Accounts
übernehmen auf demselben Weg und erscheinen gleich.

Übernahmen laufen nicht automatisch ab. Sie koordinieren die Arbeit, sperren sie
aber nicht: Wer den Space bearbeiten darf, kann eine übernommene Aufgabe
zwischen offenen Spalten verschieben, und gewöhnliche gemeinsame Bearbeitungen
bleiben möglich. Erledigst du deine eigene übernommene Aufgabe, auch per Ziehen
in eine Erledigt-Spalte, wird die Übernahme freigegeben. Wer den Space
bearbeiten darf, sieht bei fremden Übernahmen **Übernehmen** und bestätigt es in
einem Dialog, der die bisherige Person nennt. Erledigst du eine Aufgabe, die
jemand anderes übernommen hat, etwa per Ziehen in eine Erledigt-Spalte, fragt
Spaces einmal nach, zum Beispiel „Von Jana Berger übernommen – übernehmen und
abschließen?“, und übernimmt und erledigt die Aufgabe dann in einem Schritt.
**Abbrechen** lässt die Karte an ihrem Platz. Die Aktivität zeigt, wer eine
Aufgabe von wem übernommen hat.

## Einladungen über die Cloud-Suche vorbereiten {icon="calendar-event"}

Öffne einen Termin, um **Einladung vorbereiten** in der Cloud-Suche zu sehen. Für eine bestehende Einladung kannst du ein Update oder eine Absage vorbereiten. Wähle Postfach und Empfänger und prüfe und versende den Entwurf anschließend in Mail. Die Aktion benötigt Bearbeitungsrechte am Termin und ein geeignetes Postfach.
