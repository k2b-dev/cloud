---
id: mail-compose
title: E-Mails verfassen und senden
icon: ti ti-pencil
description: Nachrichten verfassen, Entwürfe wiederherstellen, Vorlagen nutzen, Dateien anhängen und die Zustellung steuern.
order: 30
---

## Eine Nachricht beginnen {icon="square-plus"}

Wähle **Verfassen** für eine neue Nachricht. Wähle in einer Unterhaltung **Antworten**, **Allen antworten**, **Weiterleiten** oder **Auswahl zitieren**. Mail erstellt zuerst einen gemeinsamen Entwurf und öffnet dann die Seite des Editors. Mail behält den Zweck des Entwurfs bei, deshalb heißt die letzte Aktionsschaltfläche **Senden**, **Antworten**, **Allen antworten** oder **Weiterleiten**.

Wähle unter **Von** eine bestätigte Absenderidentität, füge Empfänger hinzu und gib Betreff und Text ein. **Cc/Bcc** zeigt die weiteren Empfängerfelder. Empfänger sehen die Bcc-Liste nie. Deine eigene Kopie in Gesendet behält sie, sodass jedes E-Mail-Programm zeigt, wen du in Bcc gesetzt hast.

Der Editor ist vom Arbeitsbereich des Postfachs getrennt. **Zurück zum Postfach** speichert die letzten Änderungen, gibt die Bearbeitungssperre frei und kehrt zum Postfach zurück. **In neuem Fenster öffnen** verschiebt denselben Entwurf in ein eigenes Browserfenster. Dabei entsteht nie ein zweiter Entwurf.

## Den Entwurf mit Assistant fortsetzen {icon="sparkles"}

Wähle **Mit KI schreiben**, um den aktuellen Mail-Entwurf zu speichern und in einem neuen Assistant-Chat zu öffnen. Assistant startet mit dem Entwurf als angehängter Cloud-Ressource. Er bekommt nur die Mail-Aktionen, die er braucht, um den Entwurf zu lesen und zu ändern, verwandten Verlauf zu suchen und das Senden vorzuschlagen.

Für eindeutige Empfänger kann Mail auch die passenden Kontakte anhängen, die du im Kontaktverzeichnis lesen kannst. Standardmäßig ist das Contacts. Ein fehlendes oder nicht verfügbares Kontaktverzeichnis blockiert den Chat nicht.

Der Assistant-Chat kopiert die Nachricht nicht in einen separaten Mail-Entwurf und erhält keinen zusätzlichen Zugriff auf das Postfach. Mail prüft deinen aktuellen Zugriff jedes Mal, wenn Assistant den Entwurf liest oder ändert. Assistant zeigt das Ändern oder Senden von E-Mails als Aktionsprüfung. Das Senden braucht weiterhin deine ausdrückliche Zustimmung und die normale letzte Prüfung von Mail. Um den aktuellen Stand im Editor direkt zu prüfen, kehre über den Entwurfslink zu Mail zurück.

## Cloud Mail für E-Mail-Links verwenden {icon="link"}

Du kannst den aktuellen Browser bitten, Cloud Mail für normale `mailto:`-Links zu verwenden:

:::steps
1. Öffne **Postfachwerkzeuge → E-Mail-Links einrichten**.
2. Bestätige die Abfrage, wenn der Browser fragt.
:::

Diese Einstellung gehört zum Browser oder Betriebssystem, nicht zu einem Postfach oder Cloud-Konto. Cloud zeigt deshalb keinen dauerhaften Schalter für eine Standard-App.

Ein Browser kann sich eine frühere Ablehnung merken und nicht erneut fragen. Wenn keine Abfrage erscheint:

:::steps
1. Öffne die Website-Steuerung neben der Adresse.
2. Öffne die Website-Einstellungen.
3. Setze die Protokollhandler für diese Website zurück.
4. Wähle erneut **E-Mail-Links einrichten**.
:::

Ein E-Mail-Link kann An, Cc, Bcc, Betreff und einen Text ohne Formatierung ausfüllen. Bevor Cloud den Entwurf erstellt, zeigt es das Postfach, in dem du Zugriff **Bearbeiten** hast, und die bestätigte Absenderidentität. Links können keine verborgene Absenderidentität wählen, keine lokalen Dateien anhängen und nicht automatisch senden. In Browsern ohne Unterstützung für Protokollhandler nutzt du **Verfassen** weiterhin normal.

## Markdown oder Nur Text wählen {icon="route"}

Öffne **Nachrichtenoptionen** und wähle das Format für den aktuellen Entwurf:

:::compare
- **Markdown** zeigt **Verfassen** und **Vorschau**. Gehört der Entwurf zu einer Unterhaltung, zeigt es auch **Verlauf**.
- **Nur Text** hat keine Vorschau. Eine eigenständige Nachricht bleibt in einem Editor. Ein Entwurf in einer Unterhaltung zeigt **Verfassen** und **Verlauf**.
:::

Mail sendet Markdown als lesbares HTML mit dem E-Mail-Design des Postfachs und einer Textalternative. Nur Text sendet keine HTML-Alternative. Du kannst die verfügbaren Bereiche anordnen. Mail hält das Layout passend, wenn ein anderer Entwurf andere Bereiche anbietet.

Der Verlauf lädt erst, wenn du ihn öffnest. Mail klappt zuerst die neueste Nachricht auf. Du kannst mehrere Nachrichten unabhängig auf- und zuklappen, und Mail lädt frühere Zusammenfassungen seitenweise. Eine vollständige Nachricht lädt Mail erst, wenn du sie aufklappst. Links und Anhänge haben denselben Sicherheitsschutz wie in der Leseansicht.

Dein Standardformat steht unter **Einstellungen → Schreiben → Format beim Verfassen**. Eine Änderung des Standards ändert keine vorhandenen Entwürfe.

## Einen vorhandenen Entwurf einer Unterhaltung fortsetzen {icon="pencil"}

Entwürfe gehören zum Postfach, nicht nur zu dem Browser, der sie erstellt hat. Hat eine Unterhaltung schon Entwürfe, öffnen **Antworten**, **Allen antworten** oder **Weiterleiten** den Dialog **Entwurf fortsetzen?**. Der Dialog zeigt, wer jeden Entwurf erstellt hat, wann er sich geändert hat, und eine Vorschau des Inhalts. Setze den passenden Entwurf fort oder erstelle eine separate Nachricht.

Mail speichert den gemeinsamen Entwurf, während du arbeitest. Außerdem führt Mail im Browser ein Wiederherstellungsprotokoll für Änderungen, die den Server noch nicht erreicht haben. Nach einem Neuladen oder einer unterbrochenen Verbindung kann Mail diese Browseränderungen wiederherstellen.

Nur die Sitzung mit der aktuellen Bearbeitungssperre kann den Entwurf ändern. Mail lehnt Speichern, Änderungen an Anhängen und Verwerfen aus jeder anderen Sitzung, jedem Tab, Agenten oder CLI-Aufruf ab und nennt die bearbeitende Person. Hält niemand die Sperre, kann die nächste Sitzung den Entwurf wieder ändern. Deine eigene abgelaufene Sitzung blockiert dich also nie.

Bearbeitet ein anderer Tab oder eine andere Person den Entwurf, nennt Mail diese Sitzung nach Möglichkeit. Du kannst schreibgeschützt weiterarbeiten oder die Bearbeitung gezielt in diesen Tab holen. Nach dem Schließen des Dialogs zeigt der Editor einen ruhigen Hinweis.

:::warning Bearbeitung übernehmen macht die andere Sitzung schreibgeschützt
Wähle **Bearbeitung übernehmen** nur, wenn die andere Sitzung die Bearbeitung verlieren soll.
:::

Ein vorübergehendes Verbindungsproblem zeigt Mail getrennt an und fordert dich nicht zur Übernahme auf. Veraltete Speichervorgänge in deiner eigenen Sitzung können Wiederherstellungskopien erzeugen. Mit der Wiederherstellungsaktion im Editor prüfst du sie und stellst sie wieder her.

Entwürfe liegen in Cloud als gemeinsame Entwürfe.

- **Ordner Entwürfe:** Der Ordner Entwürfe in der Seitenleiste listet alle gemeinsamen Entwürfe des Postfachs, die zuletzt bearbeiteten zuerst. Seine Zahl zählt sie. Wähle einen Entwurf, um ihn im Editor zu öffnen.
- **Hinweis bei Antworten:** Eine Unterhaltung mit Entwürfen zeigt einen Hinweis an der Antwortaktion.
- **CLI:** `cld mail draft list` listet diese Entwürfe, zusammen mit geplanten Entwürfen und Entwürfen, die gerade gesendet werden.
- **Kopie beim Anbieter:** Erlaubt es der Anbieter, legt Mail von jedem Entwurf eine Kopie im Entwürfe-Ordner des Anbieters ab, sodass andere E-Mail-Programme ihn zeigen. Entwürfe, die ein anderes E-Mail-Programm dort speichert, erscheinen in Mail als gemeinsame Entwürfe.
- **Gmail:** Gmail zeigt Entwürfe auch in All Mail. Mail ignoriert Nachrichten, die außerhalb des Entwürfe-Ordners als Entwurf markiert sind.
- **Fehlende Entwürfe:** Fehlen Entwürfe aus anderen E-Mail-Programmen, kann jemand mit Zugriff **Verwalten** prüfen, welchen Ordner **Zuordnung besonderer Ordner** für Entwürfe nutzt.

Mail kann den Entwurf in den Entwürfe-Ordner des Anbieters synchronisieren. Bearbeitest du ihn dann in einem anderen E-Mail-Programm, aktualisiert Mail denselben gemeinsamen Entwurf und legt keinen zweiten an. Mail behält in diesen Fällen seine eigene Fassung und bietet die externe Fassung als Wiederherstellungskopie an:

- der Entwurf hat sich inzwischen in Mail geändert;
- das andere Programm hat seine Kopie neben der aktuellen Kopie von Mail abgelegt, statt sie zu ersetzen;
- der zurückkommende Text enthält nicht aufgelöste Platzhalter.

Wurde der Entwurf schon gesendet oder verworfen, erscheint ein späteres Speichern aus einem anderen Programm als neuer Entwurf.

Plant, sendet oder verwirft eine andere Sitzung den Entwurf, lädt jeder geöffnete Editor den aktuellen Zustand des Entwurfs neu. Er hört auf zu speichern und verlängert die Bearbeitungssperre nicht mehr. Der Editor bleibt schreibgeschützt und erlaubt kein zweites Senden und keine Übernahme. Nicht gespeicherter lokaler Text bleibt sichtbar. Du kannst ihn kopieren oder als neuen unabhängigen Entwurf speichern. Gehört die ursprüngliche Nachricht zu einer Unterhaltung, führt **Nachricht öffnen** dorthin zurück.

:::warning Entwurf verwerfen entfernt den Entwurf für alle
**Entwurf verwerfen** entfernt den gemeinsamen Entwurf für alle mit Zugriff auf das Postfach. Um den Entwurf zu behalten, kehre stattdessen zum Postfach zurück.
:::

## Signaturen und Textbausteine verwenden {icon="pencil"}

Tippe im Text `/`, um verfügbare Signaturen und Textbausteine zu suchen. Mail fügt die gewählte Vorlage in den Entwurf ein, wo du sie bearbeiten oder entfernen kannst.

- **Textbaustein:** Fügt wiederverwendbaren Text mit bereits eingesetzten Werten ein. Werte wie `{{ actor.email }}` erscheinen als normaler Text. In Markdown-Nachrichten setzt Mail nur vor Zeichen einen Backslash, die sonst die Formatierung ändern würden, zum Beispiel `\*`.
- **Signatur:** Behält ihre sicheren Liquid-Variablen bis zur Vorschau und zum Senden. Werte wie `{{ sender.display_name }}` oder `{{ mailbox.name }}` werden erst bei der Zustellung eingesetzt.
- **Privat:** Nur die Person, der die Vorlage gehört, sieht sie.
- **Postfach:** Die Vorlage ist mit anderen im Team geteilt.

Hat eine bestätigte Absenderidentität eine Standardsignatur, fügt Mail sie automatisch in neue Nachrichten, Antworten und Weiterleitungen ein. In einer Antwort oder Weiterleitung setzt Mail die Signatur vor den zitierten Verlauf. Ein persönlicher Standard ersetzt für diese Absenderidentität den Standard des Postfachs. Den eingefügten Quelltext kannst du weiter bearbeiten. Signaturen sind weder Pflicht noch gesperrt.

Mit Zugriff **Verwalten** änderst du Vorlagen und Standards unter **Einstellungen → Schreiben**. Wähle dort **Design bearbeiten**, um den CSS-Editor des Postfachs zu öffnen. Seine Vorschau aktualisiert sich aus dem aktuellen, nicht gespeicherten CSS. Die **Vorschau** im Editor nutzt dieselbe Darstellung wie die Zustellung.

## Dateien anhängen {icon="paperclip"}

Wähle **Dateien anhängen** und wähle eine oder mehrere Dateien aus, oder ziehe Dateien vom Desktop auf den Editor. Der Editor ist hervorgehoben, solange er die Dateien annehmen kann. Upload-Fortschritt und Fehler erscheinen neben den Anhängen des Entwurfs. Du kannst einen unvollständigen Upload wiederholen oder abbrechen und eine angehängte Datei vor dem Senden entfernen.

Wurde die Seite während eines Uploads neu geladen oder geschlossen, zeigt der Entwurf diese Datei beim nächsten Öffnen als **Upload nicht abgeschlossen**. Brich den Upload ab und hänge die Datei erneut an.

:::reference
- **Ein Anhang:** Höchstens 100 MiB.
- **Ein Entwurf:** Höchstens 200 Anhänge und insgesamt 100 MiB.
- **Unvollständiger Upload:** Du kannst nicht senden, solange ein Upload unvollständig oder fehlgeschlagen ist.
:::

Dein E-Mail-Anbieter kann eine kleinere Grenze für die vollständige ausgehende Nachricht setzen. Bevor Mail die Zustellung einreiht, zählt es die fertig kodierte E-Mail, einschließlich Headern und Kodierung der Anhänge. Durch die Kodierung wird eine angehängte Datei beim Versand größer.

Veröffentlicht der Anbieter eine aktuelle Grenze, lehnt Mail eine zu große Nachricht vor dem SMTP-Versand ab und nennt beide Größen. Entferne Anhänge oder teile eine große Datei stattdessen über einen öffentlichen Download-Link. Eine unbekannte oder veraltete Grenze des Anbieters verhindert das Senden nicht.

Leitest du eine Nachricht mit Anhängen weiter, übernimmt Mail die ursprünglichen Dateien standardmäßig in den neuen Entwurf. Reicht der weitergeleitete Text, entferne einzelne Anhänge im Editor.

## Eine Kalendereinladung hinzufügen {icon="calendar-plus"}

Öffne **Nachrichtenoptionen** und wähle **Kalendereinladung hinzufügen**. Wähle einen vorhandenen Termin oder erstelle direkt einen kleinen Termin in einem Space, in dem du Zugriff **Bearbeiten** hast. Spaces besitzt den Termin und die Abfolge seiner Einladungen. Mail hängt die erzeugte `.ics`-Datei an den aktuellen Entwurf. Gesendet wird erst, wenn du die normale Sendeaktion nutzt.

Mail nimmt den Organisator aus der bestätigten Absenderidentität des Entwurfs. Empfänger unter **An** und **Cc** werden Teilnehmende der Einladung. Empfänger unter **Bcc** lässt Mail bewusst weg, damit Kalenderdaten nie verborgene Adressen preisgeben. Ist Spaces nicht verfügbar oder hast du in keinem Space Zugriff **Bearbeiten**, blendet Mail die Kalenderaktion aus. Der übrige Editor funktioniert weiter.

## Versandwarnungen prüfen {icon="shield-check"}

Vor einem sofortigen, verzögerten oder geplanten Versand prüft Mail den exakt gespeicherten Entwurf auf häufige Fehler. Mail kann dich bitten, Folgendes zu prüfen:

- einen fehlenden Anhang;
- eine ungewöhnlich große Empfängerliste;
- externe Empfänger;
- **Allen antworten**;
- einen verdächtigen Link;
- Platzhalter wie `{{ sender.email }}`, die nicht mehr zu einer Signatur oder einem Textbaustein gehören und als reiner Text versendet würden.

Der Dialog erklärt jede Warnung und führt dich zurück zum Entwurf. Wähle **Trotzdem senden** erst, nachdem du die aktuellen Empfänger, Links und Anhänge geprüft hast.

Eine Zustimmung gilt nur für diese gespeicherte Fassung des Entwurfs. Bearbeitest du den Entwurf danach, prüft Mail erneut. Mail hält die bestätigten Warnungstypen für die Prüfung der Zustellung fest, aber keine zweite Kopie des Nachrichteninhalts.

## Eine Nachricht sicher wiederverwenden {icon="copy"}

Öffne das Aktionsmenü einer Nachricht und wähle **Als neue Nachricht verwenden**. Mail erstellt aus Empfängern, Betreff und Inhalt einen unabhängigen Entwurf. Du wählst die Absenderidentität und ob Mail die Anhänge kopiert.

Mail ändert die ursprüngliche Nachricht und Unterhaltung nie, und es wird nichts sofort gesendet. Prüfe Absenderidentität, Empfänger, Inhalt und Anhänge und sende dann über den normalen Versand. Wird dieselbe Anfrage zum Erstellen wiederholt, liefert Mail denselben Entwurf und legt kein Duplikat an.

## Jetzt senden, rückgängig machen oder planen {icon="send"}

Wähle die Hauptaktion, um die Zustellung jetzt einzureihen. **Versand rückgängig machen** unter **Einstellungen → Schreiben** kann die sofortige Zustellung um 0 bis 60 Sekunden verzögern. Bei einem Wert über null wartet Mail so viele Sekunden und bietet das Rückgängigmachen über **Geplant** an.

So planst du die Zustellung:

:::steps
1. Öffne das geteilte Aktionsmenü und wähle **Später senden**.
2. Wähle unter **Zustellung planen** einen Zeitpunkt mindestens eine Minute in der Zukunft.
3. Prüfe im Dialog die Zeitzone des Postfachs und den genauen Zustellzeitpunkt.
:::

Wähle im selben Menü **Als Entwurf speichern**, um sinnvolle Änderungen zu behalten und zum Postfach zurückzukehren. Mail legt keinen leeren Entwurf an, solange der Editor nur seinen unveränderten Anfangsinhalt enthält.

Geplante Nachrichten erscheinen unter **Geplant** mit Empfängern, Inhaltsvorschau, erstellender Person, Zustellzeit und Status der Wiederholungen. Bis die Zustellung beginnt, kannst du mit **Abbrechen**:

- die Nachricht geplant lassen,
- sie in einen gemeinsamen Entwurf zurückverwandeln oder
- sie verwerfen.

Nach erfolgreicher Zustellung wird die Nachricht zu normaler gesendeter E-Mail. Ihr Datum ist der Versandzeitpunkt, nicht der Zeitpunkt der Planung.

Geplante Zustellung und Senden rückgängig machen brauchen einen aktiven Postfachtransport. Pausiert jemand das Postfach, stoppt die eingereihte Zustellung, bis jemand mit Zugriff **Verwalten** sie fortsetzt.

Eine fällige Nachricht wartet und zeigt **Wartet auf Anmeldung**, wenn eines davon zutrifft:

- das Postfach braucht eine neue Anmeldung;
- jemand hat sein Passwort ersetzt, und das Postfach oder die Absenderidentität ist noch nicht mit dem neuen Passwort bestätigt.

Mail benachrichtigt dich einmal. Es sendet die Nachricht, sobald das Konto wieder verbunden ist, datiert auf den Versandzeitpunkt. Verbindet niemand das Konto innerhalb von sechs Tagen nach dem Fälligkeitszeitpunkt, zeigt die Nachricht **Senden fehlgeschlagen** und kehrt zu den Entwürfen zurück. Mail benachrichtigt dich dann erneut.

## Ein Versandproblem beheben {icon="alert-circle"}

Wähle den Zustellstatus unter einer ausgehenden Nachricht. Er zeigt, was passiert ist, und den sichersten nächsten Schritt.

Erreicht Mail den Mailserver nicht, bevor es die Nachricht übergibt, wurde nichts gesendet. Mail behält die Nachricht und versucht es über einige Minuten mehrmals erneut. Der Zustellstatus zeigt den nächsten Versuch. Dasselbe gilt, wenn sich das Postfach gerade neu verbindet oder Mail vor der Übergabe neu gestartet wurde. Hält das Problem an, zeigt die Nachricht **Senden fehlgeschlagen**. Eine Nachricht, deren Postfach eine neue Anmeldung braucht, wartet länger, wie oben beschrieben.

- **Konnte nicht gesendet werden:** Mail weiß, dass die Nachricht nicht gesendet wurde. Wähle **Prüfen und erneut senden**, um den aufbewahrten Entwurf vor einem neuen Versuch zu öffnen. Fehler bei Empfängern, Größe oder Zustelloptionen haben eine genauere Bezeichnung zum Prüfen.
- **Teilweise gesendet:** Der empfangende Server hat einige Empfänger angenommen, andere nicht. Mail legt die Nachricht wie andere gesendete E-Mails im Ordner Gesendet ab. Klappt das nicht sofort, versucht Mail es in den nächsten Minuten erneut. Wähle **Übrige Empfänger prüfen**, um einen unabhängigen Entwurf nur mit den Adressen zu erstellen, die der Server nicht angenommen hat.
- **Versandstatus unklar:** Die Verbindung endete, bevor Mail das Ergebnis nachweisen konnte. Mail sucht noch einige Male nach der Kopie des Anbieters im Ordner Gesendet. Erscheint diese Kopie, auch später, markiert Mail die Nachricht als gesendet.
- **Gesendet, aber nicht gespeichert:** Die Zustellung war erfolgreich, aber Mail konnte seine Kopie nicht im Ordner Gesendet ablegen.

:::warning Doppelte Nachrichten vermeiden
**Alle Empfänger erneut prüfen...** nach **Teilweise gesendet** bezieht auch die ursprünglichen Empfänger ein und kann doppelte Nachrichten erzeugen. Wähle bei **Zustellstatus unklar** zuerst **Erneut prüfen**. Erstelle einen Entwurf zum erneuten Senden nur, wenn du bedacht hast, dass die ursprüngliche Nachricht schon angekommen sein kann. Sende eine Nachricht mit **Gesendet, aber nicht gespeichert** nicht erneut.
:::

Ein Wiederherstellungsentwurf sendet nie sofort. Prüfe Absenderidentität, Empfänger, Inhalt und Anhänge im Editor. Nutze dann die normale Sendeaktion.

## Priorität und Bestätigungen wählen {icon="mail-cog"}

Öffne **Nachrichtenoptionen** und dann **Zustelloptionen**. Dort änderst du die Standards der gewählten Absenderidentität für diesen Entwurf:

- **Priorität** fügt Standard-Header für hohe oder niedrige Wichtigkeit hinzu. Das E-Mail-Programm des Empfängers entscheidet, ob und wie es sie zeigt.
- **Zustellbestätigung anfordern** bittet den SMTP-Server um einen Zustellbericht. Du kannst die Option nur wählen, wenn der gewählte Sendeserver Unterstützung meldet.
- **Lesebestätigung anfordern** bittet das E-Mail-Programm des Empfängers um eine Rückmeldung. Empfänger und Organisationen können die Anfrage ignorieren oder ablehnen.

Mail hält empfangene Berichte in der Aktivität der Unterhaltung fest. Ein Zustellbericht sagt, was ein Mailserver gemeldet hat. Eine Lesebestätigung sagt, was ein E-Mail-Programm gemeldet hat. Keines davon beweist, dass eine Person die Nachricht gelesen, verstanden oder bearbeitet hat.

## Einen Termin über die Cloud-Suche hinzufügen {icon="calendar-event"}

Wähle beim Bearbeiten eines Entwurfs in der Cloud-Suche **Kalendereinladung an diesen Entwurf anhängen**. Mail speichert den Entwurf und öffnet dieselbe Terminauswahl wie die Schaltfläche im Editor. Empfänger, Text und Anhänge bleiben in diesem Entwurf. Schlägt das Speichern fehl oder hält jemand anderes die Bearbeitungssperre, behebe das zuerst. Das Senden bleibt ein eigener Schritt.
