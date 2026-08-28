---
id: mail-compose
title: Nachrichten schreiben und senden
icon: ti ti-pencil
description: Nachrichten verfassen, Entwürfe wiederherstellen, Vorlagen verwenden, Dateien anhängen und die Zustellung steuern.
order: 30
---

## Eine Nachricht beginnen {icon="square-plus"}

Wähle **Verfassen** für eine neue Nachricht oder verwende in einer Unterhaltung **Antworten**, **Allen antworten**, **Weiterleiten** oder **Auswahl zitieren**. Mail erstellt zunächst einen gemeinsamen Entwurf und öffnet dann die eigene Verfassen-Seite. Die Absicht des Entwurfs bleibt erhalten. Die abschließende Schaltfläche heißt daher **Senden**, **Antworten**, **Allen antworten** oder **Weiterleiten**.

Wähle unter **Von** eine verifizierte Absenderidentität, füge Empfänger hinzu und gib Betreff und Nachricht ein. **Cc/Bcc** blendet die zusätzlichen Empfängerfelder ein.

Der Editor ist vom Postfach-Arbeitsbereich getrennt. Wähle **Zurück zum Postfach**, um die letzten Änderungen zu speichern, die Bearbeitungssperre freizugeben und zurückzukehren. **In neuem Fenster öffnen** verschiebt denselben Entwurf in ein eigenes Browserfenster. Dabei entsteht kein zweiter Entwurf.

## Den Entwurf mit Assistant fortsetzen {icon="sparkles"}

Wähle **Mit AI schreiben**, um den aktuellen Mail-Entwurf zu speichern und in einem neuen Assistant-Chat zu öffnen. Assistant startet mit dem Entwurf als angehängter Cloud-Ressource und mit begrenzten Mail-Aktionen, über die er den Entwurf lesen und aktualisieren, einen zugehörigen Verlauf durchsuchen und das Senden vorschlagen kann. Eindeutig lesbare Kontakte können für zweifelsfreie Empfänger ebenfalls angehängt werden. Eine fehlende oder nicht verfügbare Kontakte-Integration blockiert den Chat nicht.

Der Assistant-Chat kopiert die Nachricht nicht in einen separaten Mail-Entwurf und erhält keinen zusätzlichen Postfachzugriff. Mail prüft deine aktuelle Berechtigung bei jedem Lese- oder Änderungsvorgang durch Assistant. Das Aktualisieren oder Senden von E-Mails erscheint als Aktionsprüfung. Das Senden erfordert weiterhin eine ausdrückliche Freigabe und die übliche abschließende Prüfung durch Mail. Über den Link zum Entwurf gelangst du zurück zu Mail, wenn du den verbindlichen Zustand direkt im Editor prüfen möchtest.

## Cloud Mail für E-Mail-Links verwenden {icon="link"}

Öffne **Postfachwerkzeuge > E-Mail-Link einrichten**, damit der aktuelle Browser Standardlinks mit `mailto:` über Cloud Mail öffnet. Bestätige die Nachfrage des Browsers. Diese Zuordnung gehört zum Browser oder Betriebssystem und nicht zu einem Postfach oder Cloud-Konto. Cloud zeigt daher keinen dauerhaften Schalter für die Standardanwendung an.

Browser können eine frühere Ablehnung speichern und die Nachfrage unterdrücken. Erscheint keine Nachfrage, öffne neben der Adresse die Website-Einstellungen, gehe zu **Website-Einstellungen**, setze **Protokollhandler** für diese Website zurück und wähle erneut **E-Mail-Link einrichten**.

Ein E-Mail-Link kann An, Cc, Bcc, Betreff und einen Textkörper enthalten. Cloud zeigt das beschreibbare Postfach und die verifizierte Absenderidentität, bevor der Entwurf erstellt wird. Links können keine ausgeblendete Absenderidentität auswählen, lokale Dateien anhängen oder automatisch senden. In Browsern ohne Unterstützung für Protokollhandler kannst du weiterhin normal **Verfassen** verwenden.

## Markdown oder Nur Text wählen {icon="route"}

Öffne **Nachrichtenoptionen** und wähle das Format für den aktuellen Entwurf:

:::compare
- **Markdown** zeigt **Schreiben** und **Vorschau**. Gehört der Entwurf zu einer Unterhaltung, wird außerdem **Verlauf** angezeigt.
- **Nur Text** hat keine Vorschau. Eine eigenständige Nachricht bleibt in einem Editor; ein Entwurf in einer Unterhaltung zeigt **Schreiben** und **Verlauf**.
:::

Mail sendet Markdown als gut lesbares HTML mit dem E-Mail-Design des Postfachs und einer Textalternative. Nur Text wird ohne HTML-Alternative gesendet. Du kannst die verfügbaren Bereiche anordnen. Mail hält die Anordnung kompatibel, wenn ein anderer Entwurf eine andere Zusammenstellung von Bereichen bietet.

Der Verlauf wird erst geladen, wenn du ihn öffnest. Mail klappt zunächst die neueste Nachricht auf. Du kannst mehrere Nachrichten unabhängig voneinander auf- oder zuklappen und ältere Zusammenfassungen seitenweise laden. Eine vollständige Nachricht wird erst beim Aufklappen abgerufen. Für Links und Anhänge gelten dieselben Schutzmaßnahmen wie in der Unterhaltungsansicht.

Dein Standardformat wird unter **Einstellungen > Schreiben > Format beim Verfassen** gespeichert. Eine Änderung des Standards schreibt vorhandene Entwürfe nicht um.

## Einen vorhandenen Unterhaltungsentwurf fortsetzen {icon="pencil"}

Entwürfe gehören zum Postfach und nicht nur zu dem Browser, in dem sie erstellt wurden. Gibt es für eine Unterhaltung bereits Entwürfe, öffnet **Antworten**, **Allen antworten** oder **Weiterleiten** den Dialog **Entwurf fortsetzen?**. Er zeigt, wer die Entwürfe erstellt hat, wann sie zuletzt geändert wurden und eine Inhaltsvorschau. Setze den passenden Entwurf fort oder erstelle eine eigenständige Nachricht.

Mail speichert den gemeinsamen Entwurf während der Bearbeitung und führt im Browser ein Wiederherstellungsprotokoll für Änderungen, die den Server noch nicht erreicht haben. Nach einem Neuladen oder einer unterbrochenen Verbindung kann Mail diese Browseränderungen wiederherstellen.

Nur eine Sitzung kann den Entwurf gleichzeitig speichern. Wird er in einem anderen Tab oder von einer anderen Person bearbeitet, nennt Mail diese Sitzung nach Möglichkeit. Du kannst den Entwurf schreibgeschützt öffnen oder die Bearbeitung ausdrücklich in diesen Tab verschieben. Nach dem Schließen des Dialogs bleibt im Editor ein unaufdringlicher Hinweis sichtbar. Wähle **Übernehmen** nur, wenn die andere Sitzung schreibgeschützt werden soll. Ein vorübergehendes Verbindungsproblem wird getrennt angezeigt und fordert nicht zur Übernahme auf. Gleichzeitige oder veraltete Speichervorgänge können Wiederherstellungskopien erzeugen. Mit der Wiederherstellungsaktion im Editor kannst du sie prüfen und wiederherstellen.

Wenn eine andere Sitzung den Entwurf plant, sendet oder verwirft, lädt jeder geöffnete Editor den verbindlichen Zustand neu und beendet das Speichern und Verlängern der Bearbeitungssperre. Der Editor bleibt schreibgeschützt, statt ein weiteres Senden oder Übernehmen zu erlauben. Nicht gespeicherter lokaler Text bleibt sichtbar und kann kopiert oder als neuer unabhängiger Entwurf gespeichert werden. Gehört die ursprüngliche Nachricht zu einer Unterhaltung, führt **Nachricht öffnen** dorthin zurück.

**Entwurf verwerfen** entfernt den gemeinsamen Entwurf für alle Personen mit Postfachzugriff. Bei der Rückkehr zum Postfach bleibt der Entwurf erhalten.

## Signaturen und Textbausteine verwenden {icon="pencil"}

Gib im Nachrichtentext `/` ein, um verfügbare Signaturen und Textbausteine zu durchsuchen. Die ausgewählte Vorlage wird in den Entwurf eingefügt und kann dort bearbeitet oder entfernt werden.

- **Textbausteine** fügen aufgelösten wiederverwendbaren Text ein.
- **Signaturen** behalten ihre sicheren Liquid-Variablen bis zur Vorschau und zum Senden. Werte wie `{{ sender.display_name }}` oder `{{ mailbox.name }}` werden dadurch erst bei der Zustellung aufgelöst.
- **Privat** bedeutet, dass eine Vorlage nur für die Person sichtbar ist, der sie gehört.
- **Postfach** bedeutet, dass eine Vorlage gemeinsam mit anderen Personen im Postfach verwendet wird.

Hat eine verifizierte Absenderidentität eine Standardsignatur, fügt Mail sie automatisch in neue Nachrichten, Antworten und Weiterleitungen ein. Bei Antworten und Weiterleitungen steht die Signatur vor dem zitierten Nachrichtenverlauf. Ein persönlicher Standard überschreibt den Postfachstandard für diese Absenderidentität. Der eingefügte Quelltext bleibt bearbeitbar; Signaturen sind weder verpflichtend noch gesperrt.

Administratoren verwalten Vorlagen und Standards unter **Einstellungen > Schreiben**. Wähle dort **Design bearbeiten**, um den CSS-Editor des Postfachs zu öffnen. Seine Vorschau verwendet das aktuell noch nicht gespeicherte CSS. Die Vorschau im Editor verwendet denselben Darstellungsweg wie die Zustellung.

## Dateien anhängen {icon="paperclip"}

Wähle **Dateien anhängen** und eine oder mehrere Dateien aus oder ziehe Dateien vom Desktop auf den Editor. Der Editor wird hervorgehoben, solange er die Dateien ablegen kann. Uploadfortschritt und Fehler erscheinen neben den Anhängen des Entwurfs. Einen unvollständigen Upload kannst du wiederholen oder abbrechen. Anhänge lassen sich vor dem Senden entfernen.

Jeder ausgehende Anhang ist auf 100 MiB begrenzt. Eine Nachricht kann nicht gesendet werden, solange ein Anhang unvollständig oder fehlerhaft hochgeladen ist.

Dein E-Mail-Anbieter kann für die vollständige ausgehende Nachricht ein niedrigeres Limit festlegen. Mail berücksichtigt die endgültig codierte E-Mail einschließlich Kopfzeilen und Anhangscodierung, bevor die Zustellung eingereiht wird. Durch die Codierung wird eine angehängte Datei bei der Übertragung größer. Veröffentlicht der Anbieter ein aktuelles Limit, lehnt Mail eine zu große Nachricht vor Beginn von SMTP ab und nennt beide Größen. Entferne Anhänge oder teile eine große Datei stattdessen über einen öffentlichen Downloadlink. Ein unbekanntes oder veraltetes Anbieterlimit verhindert das Senden nicht.

Beim Weiterleiten einer Nachricht mit Anhängen übernimmt Mail die ursprünglichen Dateien standardmäßig in den neuen Entwurf. Entferne einzelne Anhänge im Editor, wenn der weitergeleitete Nachrichtentext ausreicht.

## Eine Kalendereinladung hinzufügen {icon="calendar-plus"}

Öffne **Nachrichtenoptionen** und wähle **Kalendereinladung hinzufügen**, um ein vorhandenes Ereignis auszuwählen oder direkt ein kleines Ereignis in einem beschreibbaren Space anzulegen. Spaces besitzt das Ereignis und seine Einladungssequenz; Mail hängt die erzeugte `.ics`-Datei an den aktuellen Entwurf an. Erst die normale Sendeaktion verschickt die Nachricht.

Mail leitet den Organisator von der verifizierten Absenderidentität des Entwurfs ab. Empfänger unter **An** und **Cc** werden zu Teilnehmenden der Einladung. Empfänger unter **Bcc** werden bewusst ausgeschlossen, damit verborgene Adressen niemals durch Kalenderdaten offengelegt werden. Ist Spaces nicht verfügbar oder darfst du in keinem Space schreiben, bleibt die Kalenderaktion ausgeblendet und der übrige Editor funktioniert weiter.

## Warnungen vor dem Senden prüfen {icon="shield-check"}

Vor einem sofortigen, verzögerten oder geplanten Versand prüft Mail den exakt gespeicherten Entwurf auf häufige Fehler. Mail kann dich auf einen fehlenden Anhang, eine ungewöhnlich große Empfängerliste, externe Empfänger, **Allen antworten** oder einen verdächtigen Link hinweisen. Der Dialog erläutert jede Warnung und ermöglicht die Rückkehr zum Entwurf. Wähle **Trotzdem senden** erst, nachdem du die aktuellen Empfänger, Links und Anhänge geprüft hast.

Eine Freigabe gilt nur für diese gespeicherte Version des Entwurfs. Wird der Entwurf danach bearbeitet, führt Mail die Prüfungen erneut aus. Für die Zustellungsprüfung speichert Mail die freigegebenen Warnungstypen, aber keine zweite Kopie des Nachrichteninhalts.

## Eine Nachricht sicher wiederverwenden {icon="copy"}

Öffne das Aktionsmenü einer Nachricht und wähle **Als neue Nachricht verwenden**, um aus Empfängern, Betreff und Inhalt einen unabhängigen Entwurf zu erstellen. Du kannst die Absenderidentität wählen und entscheiden, ob Anhänge kopiert werden. Die ursprüngliche Nachricht und Unterhaltung bleiben unverändert. Es wird nichts sofort gesendet: Prüfe Absenderidentität, Empfänger, Inhalt und Anhänge und verwende anschließend den normalen Versand. Wiederholungen derselben Erstellungsanfrage geben denselben Entwurf zurück, statt Duplikate anzulegen.

## Jetzt senden, rückgängig machen oder Versand planen {icon="send"}

Wähle die Hauptaktion, um die Zustellung jetzt einzureihen. Ist unter **Einstellungen > Schreiben** für **Zeitfenster zum Rückgängigmachen** ein Wert größer als null eingestellt, verzögert Mail den sofortigen Versand um diese Anzahl Sekunden und bietet unter **Geplant** eine Möglichkeit zum Rückgängigmachen. Der Wert kann zwischen 0 und 60 Sekunden liegen.

Öffne das geteilte Aktionsmenü und wähle **Später senden**, um **Versand planen** zu öffnen. Wähle einen Zeitpunkt, der mindestens eine Minute in der Zukunft liegt. Der Dialog zeigt die wirksame Zeitzone des Postfachs und den genauen Zustellzeitpunkt.

Wähle im selben Menü **Als Entwurf speichern**, um sinnvolle Änderungen zu behalten und zum Postfach zurückzukehren. Solange der Editor nur seinen unveränderten Anfangsinhalt enthält, erstellt Mail keinen leeren Entwurf.

Geplante Nachrichten erscheinen unter **Geplant** mit Empfängern, Inhaltsvorschau, Ersteller, Zustellzeit und Wiederholungsstatus. Bis zum Beginn der Zustellung kannst du über **Abbrechen**:

- das Element weiterhin geplant lassen,
- es in einen gemeinsamen Entwurf zurückführen oder
- es verwerfen.

Nach erfolgreicher Zustellung wird die Nachricht zu einer normalen gesendeten E-Mail. Geplanter Versand und das Rückgängigmachen des Sendens benötigen einen aktiven Postfachtransport. Wird das Postfach pausiert, stoppt die eingereihte Zustellung, bis ein Administrator das Postfach fortsetzt.

## Ein Sendeproblem beheben {icon="alert-circle"}

Wähle unter einer ausgehenden Nachricht den Zustellstatus, um zu sehen, was geschehen ist und welcher nächste Schritt am sichersten ist.

- **Senden fehlgeschlagen** bedeutet, dass Mail sicher weiß, dass die Nachricht nicht gesendet wurde. Wähle **Prüfen und erneut senden**, um den erhaltenen Entwurf vor einem neuen Versuch zu öffnen. Fehler bei Empfängern, Größe oder Zustelloptionen verwenden eine genauere Prüfaktion.
- **Teilweise gesendet** bedeutet, dass der empfangende Server einige Empfänger akzeptiert und andere abgelehnt hat. Wähle **Verbleibende Empfänger prüfen**, um einen unabhängigen Entwurf nur mit den nicht akzeptierten Adressen zu erstellen. **Alle erneut prüfen…** nimmt auch die ursprünglichen Empfänger auf und kann deshalb doppelte Nachrichten verursachen.
- **Zustellstatus unklar** bedeutet, dass die Verbindung beendet wurde, bevor Mail das Ergebnis nachweisen konnte. Wähle zuerst **Erneut prüfen**. Erstelle erst dann einen neuen Sendeentwurf, wenn du berücksichtigt hast, dass die ursprüngliche Nachricht bereits angekommen sein könnte.
- **Gesendet, aber nicht gespeichert** bedeutet, dass die Zustellung erfolgreich war, Mail die Kopie aber nicht im Ordner Gesendet speichern konnte. Sende die Nachricht nicht erneut.

Das Erstellen eines Wiederherstellungsentwurfs sendet niemals sofort. Prüfe Absenderidentität, Empfänger, Inhalt und Anhänge im Editor und verwende dann den normalen Versand.

## Priorität und Empfangsbestätigungen wählen {icon="mail-cog"}

Öffne **Nachrichtenoptionen** und dann **Zustelloptionen**, um die Standards der gewählten Absenderidentität für diesen Entwurf anzupassen:

- **Priorität** fügt die üblichen Kopfzeilen für hohe oder niedrige Wichtigkeit hinzu. Das E-Mail-Programm der Empfänger entscheidet, ob und wie sie angezeigt werden.
- **Zustellbestätigung** fordert vom SMTP-Server einen Zustellstatusbericht an. Die Option ist nur verfügbar, wenn der gewählte Versandserver Unterstützung dafür meldet.
- **Lesebestätigung** bittet das E-Mail-Programm der Empfänger um eine Empfangsbestätigung. Empfänger oder deren Organisationen können die Anfrage ignorieren oder ablehnen.

Mail speichert eingehende Berichte in der Aktivität der Unterhaltung. Ein Zustellbericht beschreibt, was ein Mailserver gemeldet hat. Ein Lesestatus beschreibt, was ein E-Mail-Programm gemeldet hat. Beides beweist nicht, dass eine Person die Nachricht gelesen, verstanden oder bearbeitet hat.
