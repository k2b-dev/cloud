---
id: mail-work
title: Lesen, suchen und organisieren
icon: ti ti-inbox
description: Unterhaltungen finden, vollständige Verläufe lesen und den übertragbaren E-Mail-Zustand sicher ändern.
order: 20
---

## Die passende Unterhaltung finden {icon="search"}

Mit **Postfach durchsuchen** suchst du schnell im aktuellen Postfach. Standardmäßig ist **Alles** ausgewählt. Das umfasst die synchronisierten Nachrichtenfelder und den aus Anhängen erkannten Text.

Um die Suche einzugrenzen, nutze die Schaltfläche für den Suchbereich. Wähle eine beliebige Kombination aus **Absender**, **Empfänger**, **Betreff**, **Nachrichteninhalt** und **Anhangsnamen**. Bei mehreren Wörtern passt eine Nachricht, wenn jedes Wort irgendwo in ihr vorkommt, etwa der Name des Absenders und ein Wort aus dem Betreff.

Für weitere Bedingungen wie Datum, Empfänger, Anhänge, Ordner, Tags oder Status der Zusammenarbeit wählst du **Suchfilter**.

Der Filterdialog zeigt die aktuelle Suche als Bedingungen, die du bearbeiten kannst. Wähle **Filter hinzufügen** für ein weiteres Feld. Sind mehrere Filter aktiv, legst du fest, ob alle oder mindestens einer zutreffen müssen. **Erweiterte Bedingungen** bleibt eingeklappt, bis du alternative oder verschachtelte Gruppen brauchst.

Der Filterdialog kann diese Felder durchsuchen:

- Von
- An oder Cc
- Betreff
- Nachrichtentext
- Name des Anhangs
- Interner Kommentar
- Unterhaltungsreferenz
- Ordner
- Lokaler Tag

Wähle **Mindestens eine Bedingung**, damit mindestens ein ausgefülltes Feld passen muss. Wähle **Alle Bedingungen**, damit jedes ausgefüllte Feld passen muss. Suchfilter bleiben in der Seiten-URL. Ein Neuladen oder eine geteilte URL behält deshalb das aktuelle Ergebnis. Mit **Suche zurücksetzen** kehrst du zur ungefilterten Ansicht zurück.

Anbieter-Schlüsselwörter sind erweiterte synchronisierte Metadaten, kein normales System zum Kennzeichnen. Vorhandene Such-URLs mit Schlüsselwörtern funktionieren weiter, und du kannst sie weiter bearbeiten. Neue Filter nutzen für Kennzeichnungen, die Menschen lesen, lokale Tags.

Mail prüft für jedes Suchergebnis den Zugriff und durchsucht die synchronisierte Cloud-Kopie. Während der ersten Synchronisierung können ältere Nachrichten oder Inhalte erst später durchsuchbar werden, während Synchronisierung und Laden der Nachrichtentexte weiterlaufen.

Nachdem ein Anhang synchronisiert wurde, erkennt Mail im Hintergrund lesbaren Text. Das gilt für unterstützte PDF-, Office-, Tabellen-, Präsentations-, RTF-, EPUB- und CSV-Dateien. Die allgemeine Standardsuche umfasst diesen erkannten Anhangstext. Ein Filter für **Nachrichteninhalt** durchsucht nur den E-Mail-Text. **Name des Anhangs** durchsucht Dateinamen. Passwortgeschützte, gescannte, nicht unterstützte, fehlerhafte oder zu große Dateien bleiben herunterladbar, liefern aber keinen durchsuchbaren Text.

Passt erkannter Anhangstext, nennt das Ergebnis den Anhang und zeigt einen kurzen passenden Ausschnitt. Das Ergebnis öffnet genau die Nachricht, zu der der Anhang gehört. Für die ursprüngliche Datei nutzt du die Download-Aktion des Ergebnisses.

## Nachverfolgung, Zuweisung und Ordner gezielt nutzen {icon="layout-list"}

Die eingebauten Ansichten unter **Nachverfolgung** zeigen, was als Nächstes geschieht. **Zuweisung** zeigt, wer zuständig ist. Außer **Erledigt** lassen diese Ansichten Unterhaltungen aus, die nur im Papierkorb oder in Spam liegen. Beispiele sind Spam, den dein Anbieter dort abgelegt hat, oder E-Mails, die jemand gelöscht hat. Verschiebst du eine solche Unterhaltung zurück, erscheint sie wieder mit ihrem nächsten Schritt.

| Abschnitt | Ansicht | Inhalt |
| --- | --- | --- |
| Nachverfolgung | Handlungsbedarf | Unterhaltungen, die das Team prüfen oder bearbeiten muss |
| Nachverfolgung | Wartet auf Antwort | Unterhaltungen, bei denen eine bestätigte Antwort des Teams auf eine andere Person wartet. Neue eingehende E-Mails verschieben sie zu Handlungsbedarf. |
| Nachverfolgung | Später | Unterhaltungen, die bis zum gewählten Zeitpunkt ausgeblendet sind. Zu diesem Zeitpunkt erscheinen sie mit demselben nächsten Schritt wieder. Neue eingehende E-Mails zeigen sie sofort. |
| Nachverfolgung | Erledigt | Als erledigt markierte Unterhaltungen |
| Zuweisung | Mir zugewiesen | Dir zugewiesene Unterhaltungen |
| Zuweisung | Nicht zugewiesen | Unterhaltungen, denen niemand zugewiesen ist, der sie noch bearbeiten kann, zum Beispiel weil die zugewiesenen Personen keinen Zugriff mehr haben |
| E-Mail / Mehr | Alle E-Mails | E-Mails aus allen Anbieterordnern außer Papierkorb, Spam und Ordnern, deren E-Mails im Ordner bleiben |
| Mehr | Letzte Aktivität | Kürzlich geänderte Unterhaltungen |
| Mehr | Aufbewahrt | Vor dem Löschen geschützte Unterhaltungen aus jedem Ordner |
| E-Mail | Geplant | Nachrichten, die auf eine spätere Zustellung warten |

Anbieterordner sind eine andere Ebene. Verschiebst du eine Unterhaltung in Archiv, Papierkorb, Spam oder einen anderen Anbieterordner, verschiebt sich auch die E-Mail beim Anbieter. Andere Programme können das zeigen. Markierst du eine Unterhaltung als **Erledigt**, ändert sich nur der Status der Nachverfolgung in Cloud. Die E-Mail wird weder archiviert noch verschoben.

Mit Zugriff **Verwalten** hältst du die E-Mails eines Ordners in diesem Ordner, etwa bei einem gemeinsamen Teamordner (**Nur im Ordner**). Seine Unterhaltungen fehlen dann in diesen Ansichten und ihren Zählern:

- **Handlungsbedarf**, **Wartet auf Antwort**, **Später** und **Erledigt**;
- **Nicht zugewiesen**, **Alle E-Mails** und **Letzte Aktivität**;
- in der Mail-Übersicht (**Alle Postfächer**).

Das gilt nicht, wenn eine Nachricht der Unterhaltung auch in einem Ordner liegt, dessen E-Mails überall erscheinen, etwa im Posteingang. Im Ordner selbst, in **Mir zugewiesen**, in der Suche und in gespeicherten Ansichten bleiben die Unterhaltungen.

In der Seitenleiste markiert ein kleines Ordnersymbol neben dem Zähler einen solchen Ordner. Der Zähler zeigt weiterhin seine ungelesenen E-Mails. Auf dem Smartphone zeigt die Navigation **Nur im Ordner** unter dem Namen des Ordners. Lässt eine dieser Ansichten die E-Mails eines Ordners aus, nennt ein Hinweis über der Liste den Ordner und öffnet ihn. Schließt du den Hinweis, blendet dieser Browser ihn für diesen Ordner aus.

Verwende **Wartet auf Antwort**, wenn der nächste Schritt deines Teams von einer anderen Person abhängt. Mail setzt den Status, nachdem Mail den Versand einer menschlichen Antwort oder Antwort an alle bestätigt hat. Das gilt auch für Antworten, die Mail aus einem anderen E-Mail-Programm synchronisiert.

Verwende **Später anzeigen**, wenn die nächste Prüfung von einem Datum oder einer Uhrzeit abhängt. Wähle, wann die Unterhaltung wieder erscheint. Bis dahin liegt sie unter **Später**, außerhalb der aktiven Ansichten. Eine neue eingehende E-Mail beendet das früher.

So setzt Mail den nächsten Schritt:

- Neue eingehende E-Mails setzen die Unterhaltung immer auf **Handlungsbedarf** und entfernen sie aus **Später**.
- Eine menschliche Antwort oder Antwort an alle setzt sie auf **Wartet auf Antwort**, aber erst, wenn Mail die Zustellung bestätigt.
- Eine neue Nachricht, die du in Cloud schreibst, beginnt eine Unterhaltung in **Wartet auf Antwort**. Das gilt auch für eine Nachricht, die Mail aus einem anderen E-Mail-Programm in deinem Ordner Gesendet findet.
- E-Mails von deiner eigenen Adresse, die im Posteingang ankommen, beginnen in **Handlungsbedarf**. Ein Beispiel ist ein Kontaktformular, das im Namen deines Postfachs sendet.
- Weiterleitungen, automatische Antworten, Wiederholungen und unklare Zustellungsergebnisse setzen keinen neuen nächsten Schritt.

Eine für später geplante Antwort zählt erst, wenn Mail sie sendet. Kommt vorher eine neue E-Mail an, wechselt die Unterhaltung zu **Handlungsbedarf** und bleibt nach der neuesten echten Nachricht einsortiert. Sie bleibt auch nach dem Versand der Antwort in **Handlungsbedarf**, weil du die Antwort vor dieser E-Mail geschrieben hast. Mail sendet die geplante Antwort trotzdem zu ihrem Zeitpunkt, außer du brichst sie unter **Geplant** ab.

In den **Unterhaltungsdetails** entscheidest du nur, ob die Unterhaltung **Erledigt** ist. Entfernst du Erledigt, öffnet sich die Unterhaltung wieder, und Mail leitet den nächsten Schritt aus der letzten bestätigten Nachricht ab.

Wähle **In Ordner verschieben** in den Unterhaltungsaktionen, um das Ziel per Tastatur, Zeigegerät oder Berührung zu wählen. Auf dem Desktop kannst du eine Unterhaltungszeile auch auf einen auswählbaren Ordner in der linken Navigation ziehen. Mail reiht die Verschiebung ein, und die Synchronisierung bestätigt das Ergebnis beim Anbieter.

Um mehrere Unterhaltungen zu bearbeiten, wähle ihre Kontrollkästchen aus. Halte **Umschalt** gedrückt und wähle ein weiteres Kontrollkästchen oder eine weitere Zeile aus, um den geladenen Bereich dazwischen auszuwählen. Eine Auswahl hat höchstens 50 Unterhaltungen, damit du die Arbeit beim Anbieter nachverfolgen kannst.

:::reference
- **Auswahlleiste:** Fügt Tags hinzu, archiviert, markiert als gelesen, weist zu und verschiebt die ausgewählten Unterhaltungen.
- **Mehr:** Markiert die ausgewählten Unterhaltungen als ungelesen, markiert sie mit einer Fahne, entfernt Fahnen, verschiebt sie in Spam oder in den Papierkorb.
- **Teilergebnis:** Kann Mail nur einige Befehle einreihen, bleiben die fehlgeschlagenen Unterhaltungen ausgewählt, und Mail meldet jeden Fehler.
:::

Wähle **Zuweisen**, um die zugewiesenen Personen der ausgewählten Unterhaltungen zu ändern. Wähle **Mir zuweisen**, **Mich entfernen** oder **Alle Zuweisungen entfernen**, oder suche eine Person, die zugewiesen werden kann. Eine Person, die du hinzufügst, kommt zu den anderen zugewiesenen Personen dazu und erhält eine einzige Benachrichtigung für die ganze Auswahl. Mail bestätigt, wie viele Unterhaltungen sich geändert haben, und bietet **Rückgängig** an. **Rückgängig** macht die Änderung nur in den Unterhaltungen rückgängig, die sie geändert hat. **Alle Zuweisungen entfernen** bietet kein **Rückgängig**. Gehört eine Unterhaltung nicht mehr zum Postfach, nennt Mail, wie viele Unterhaltungen sich nicht geändert haben.

## Kurz hineinschauen, ohne zu öffnen {icon="eye"}

Lass den Mauszeiger kurz auf einer Zeile der Unterhaltungsliste ruhen. Neben der Liste öffnet sich eine Kurzansicht. Sie zeigt:

- die Zeit der neuesten Nachricht, den nächsten Schritt, die zugewiesenen Personen und die Tags;
- den Betreff und die gespeicherte Zusammenfassung, falls es eine gibt;
- den Anfang der neuesten Nachricht ohne zitierten Verlauf;
- den ersten Anhang und die Zahl früherer Nachrichten.

Bewegst du den Zeiger in die Karte, bleibt sie offen. Sie schließt sich, wenn du den Zeiger wegbewegst, die Liste scrollst oder **Esc** drückst. Mit der Tastatur fokussierst du eine Zeile und blendest die Kurzansicht mit der **Leertaste** ein oder aus. **Enter** öffnet weiterhin die Unterhaltung. Wähle die Karte oder die Zeile, um die Unterhaltung zu öffnen.

Die Kurzansicht markiert nichts als gelesen, erstellt keine Zusammenfassung und lädt keine externen Bilder. Sie erscheint nicht für die bereits geöffnete Unterhaltung und nicht, während du Unterhaltungen auswählst. Sie erscheint auch nicht auf Touch-Geräten und nicht, wenn neben der Liste kein Platz ist.

## Einen vollständigen Verlauf lesen {icon="route"}

Wähle eine Unterhaltungszeile, um ihren Verlauf zu öffnen. Jede Nachricht hat eigene Absender, Empfänger, Datum, Inhalt und Anhänge. Klappe eine ältere Nachricht auf, wenn du ihren vollständigen Inhalt brauchst.

Über den Nachrichten kann eine optionale Zusammenfassung der Unterhaltung in einer hervorgehobenen Karte erscheinen. Um sie mit Markdown-Formatierung aktuell zu halten, nutze **Zusammenfassung bearbeiten** oder **Weitere Unterhaltungsaktionen → Zusammenfassung erstellen**. Zusammenfassungen sind gemeinsamer Mail-Kontext, und auch eine Automatisierung kann sie aktualisieren.

Enthält die Unterhaltung nicht abgeschlossene Entwürfe, zeigt die Antwortaktion einen Hinweis. Öffne die **Unterhaltungsdetails**, um zu sehen, wer den neuesten Entwurf erstellt hat und wann er sich geändert hat. Dort setzt du ihn fort.

Die Unterhaltungsdetails zeigen außerdem einen kleinen Abschnitt **Verwandte E-Mails** für die gesamte Unterhaltung. Mail ordnet andere Unterhaltungen aus demselben Postfach, die eine externe beteiligte Person oder denselben normalisierten Betreff teilen. Jedes Ergebnis zeigt, warum es passt. Die Aktion **Zugehörige E-Mails** auf einer Kontaktkarte ist etwas anderes: Sie öffnet eine exakte Suche nach dieser einen beteiligten Person. Keine der beiden Funktionen findet ähnliche E-Mails über Nachrichtentexte, Anhänge oder Kalendertermine.

Öffnest du eine ungelesene Unterhaltung, markiert Mail sie als gelesen. Über **Weitere Unterhaltungsaktionen** markierst du sie wieder als ungelesen, fügst eine Fahne hinzu oder entfernst sie oder druckst die Unterhaltung. Eine Unterhaltung, die du als ungelesen markierst, bleibt in bereits geöffneten Tabs ungelesen, bis du ihre Zeile erneut öffnest. Eine Live-Aktualisierung allein markiert sie nicht als gelesen.

Standardmäßig passt Mail Nachrichtentexte an das aktuelle Farbschema an: sicheres HTML im hellen Modus und reiner Text im dunklen Modus, wenn beide Fassungen vorhanden sind. Um eine einzelne Nachricht zu ändern, öffne ihre Aktionen und wähle **Als reinen Text anzeigen** oder **Als HTML anzeigen**. Um in diesem Browser einen festen Modus zu nutzen, wähle **Einstellungen → Lesen → Standardformat für Nachrichten**.

HTML-Nachrichten behalten eine begrenzte Auswahl an Layout-, Typografie-, Farb-, Abstands- und Tabellenstilen. Skripte, Formulare, eingebettete Objekte, externe Stylesheets und andere aktive Inhalte werden entfernt. Externe Bilder bleiben zusätzlich blockiert, bis du sie lädst.

Mail klappt den zitierten Verlauf früherer Nachrichten ein. Wähle **Zitierten Text anzeigen**, um ihn aufzuklappen, und **Zitierten Text ausblenden**, um ihn wieder einzuklappen. Ein aufgeklapptes Zitat bleibt offen, während neue Aktivität oder andere Live-Aktualisierungen eintreffen.

Die oberen Aktionen nehmen die Unterhaltung aus dem Ordner, den du gerade ansiehst, etwa dem Posteingang. Das gilt auch, wenn deine neueste Antwort in Gesendet liegt. In Ansichten über mehrere Ordner, etwa **Alle E-Mails** oder **Handlungsbedarf**, nehmen sie die Unterhaltung aus jedem Ordner, in dem sie liegt. Deine Kopien in Gesendet und Entwürfe bleiben, wo sie sind. Das gilt auch für Nachrichten in Spam, im Papierkorb oder im Ordner **All Mail** von Gmail. Die Ausnahme ist eine Unterhaltung, die nur dort liegt.

Bei Gmail sind Ordner Labels, und diese Ansichten wirken auf ein Label: den Posteingang, wenn die Unterhaltung darin liegt.

- **Archivieren** entfernt nur das Label Posteingang und behält deine anderen Labels und Sterne. Eine Unterhaltung außerhalb des Posteingangs hat nichts zu archivieren.
- Löschen und Spam verschieben die Nachrichten mit diesem einen Label in den Papierkorb oder nach Spam. Damit verschwinden sie auch aus allen anderen Labels.
- Nachrichten, die nur unter anderen Labels liegen, bleiben, wo sie sind.
- **In Ordner verschieben** und das Ziehen einer Zeile folgen derselben Regel.

In der **Nachrichtenansicht** ist jede Zeile eine Nachricht. Aktionen an einer Zeile, das Ziehen einer Zeile und die Aktionen der geöffneten Nachricht ändern nur diese Nachricht. Die anderen Nachrichten ihrer Unterhaltung bleiben, wie sie sind. Ist dieselbe Nachricht zweimal in einem Ordner angekommen, zeigt Mail sie einmal, und die Aktion ändert beide Kopien. Jede Zeile zeigt, ob die Nachricht ungelesen ist. Das Öffnen einer ungelesenen Nachricht markiert sie als gelesen.

Unter **Versandprobleme** listet die Nachrichtenansicht die Nachrichten, deren Versand Aufmerksamkeit braucht, auch solche, die nie in einem Ordner angekommen sind. Eine solche Nachricht liegt in keinem Ordner. Archivieren, Löschen und Verschieben melden das, statt sie zu ändern.

- **Archivieren** verschiebt sie in den zugeordneten Archivordner. Gmail hat keinen Archivordner. Ohne Zuordnung entfernt Archivieren die Unterhaltung aus dem aktuellen Ordner, etwa dem Posteingang, und behält sie in **All Mail**.
- **In Spam verschieben** verschiebt sie in den zugeordneten Spam-Ordner. In Spam wird dieselbe Aktion zu **Kein Spam** und verschiebt die Unterhaltung zurück in den Posteingang.
- **Löschen** verschiebt sie in den zugeordneten Papierkorb. Eine aufbewahrte Unterhaltung lässt sich weder löschen noch in den Spam-Ordner verschieben.

Diese Aktionen brauchen Zugriff **Bearbeiten** und die passende Ordnerzuordnung. Meldet Mail, dass die Unterhaltung beim Anbieter keinen aktiven Ort hat, aktualisiere das Postfach. Du kannst auch jemanden mit Zugriff **Verwalten** bitten, Ordnerermittlung und Zuordnungen zu prüfen.

Mail reiht jede Aktion ein, und der Mailserver führt sie Augenblicke später aus. Manchmal nimmt der Server die Änderung nicht vor, etwa weil jemand die Nachricht in einem anderen E-Mail-Programm verschoben hat. Mail nennt dann die unveränderte Unterhaltung und bietet **Erneut versuchen** an.

Änderungen an Gelesen-Status und Fahne zeigt Mail sofort. Hat der Server eine dieser Änderungen nicht vorgenommen, zeigt die Unterhaltung wieder den vorherigen Stand, auch nach mehreren Änderungen nacheinander. Ist unklar, ob der Server die Änderung vorgenommen hat, bittet Mail dich, die Unterhaltung zu prüfen, und wiederholt die Änderung nicht.

Tippe in der Cloud-Suche `>`, um die Aktionen der Schaltflächen und Menüs als Befehle zu finden. Häufige Aktionen haben auch Tastaturkürzel. Hilfe → **Tastaturkürzel** zeigt die Kürzel der aktuellen Ansicht. Kürzel laufen nicht, während du in einem Eingabefeld oder im Nachrichteneditor schreibst.

Öffne bei einer einzelnen Nachricht **Nachrichtenaktionen**. Der Abschnitt **Absender** enthält Werkzeuge für diesen Absender:

- **Alle Nachrichten dieses Absenders suchen** öffnet eine exakte Postfachsuche mit eigener URL.
- **Automatisierung für diesen Absender erstellen**, **Absender blockieren** und **Absender-Domain blockieren** öffnen den geführten Regeleditor mit eingetragenem Absender.
- **Abmeldung verwalten** erscheint nur, wenn die Nachricht standardisierte Angaben zum Abmelden von einer Mailingliste enthält.

## Unterhaltungen aufbewahren, die nicht gelöscht werden dürfen {icon="lock"}

Manche E-Mails sind ein Nachweis, etwa dafür, dass eine Kundin informiert wurde. Wähle **Weitere Unterhaltungsaktionen > Aufbewahren**, um die ganze Unterhaltung zu schützen. Alle, die im Postfach schreiben dürfen, können eine Unterhaltung aufbewahren. Ein Schloss in der Unterhaltungsliste und neben dem Betreff zeigt, dass sie aufbewahrt wird. Zeigst du auf das Schloss neben dem Betreff, siehst du, wer sie seit wann aufbewahrt. Um in einem Schritt aufzubewahren, füge **Aufbewahren** unter **Weitere Unterhaltungsaktionen > Werkzeugleiste anpassen** hinzu.

Der Schutz wächst mit der Unterhaltung. Antworten, die später dazukommen, werden ebenfalls aufbewahrt, ebenso Nachrichten, die jemand abtrennt oder mit einer anderen Unterhaltung zusammenführt. Die Unterhaltung, die sie aufnimmt, wird dann auch aufbewahrt, und ihre Aktivität nennt, wer die Nachrichten dorthin verschoben hat.

Solange eine Unterhaltung aufbewahrt wird, lehnt Cloud es ab, ihre Nachrichten zu löschen, sie in den Papierkorb, den Spam-Ordner oder die Entwürfe zu verschieben oder einen Ordner zu löschen, der sie enthält. Das gilt für jeden Weg, auf dem Cloud E-Mails ändert: die Aktionen an Unterhaltungen und Nachrichten, eine Auswahl mehrerer Unterhaltungen, Eingangsregeln und andere Automatisierungen, Workflows, die Kommandozeile `cld` und den Assistenten. Jeder dieser Wege meldet, dass die Unterhaltung aufbewahrt wird. Archivieren, in andere Ordner verschieben, als gelesen oder markiert kennzeichnen und antworten bleiben möglich. Eine geplante Nachricht kannst du weiterhin abbrechen, denn Cloud hat sie nie gesendet. War sie die einzige Nachricht der Unterhaltung, endet die Unterhaltung mit ihr, samt Aufbewahrung.

Cloud behält von jeder aufbewahrten Nachricht eine eigene vollständige Kopie: die Originalnachricht mit ihren Anhängen. Andere E-Mail-Programme und der Mailserver liegen außerhalb von Cloud und können die Nachricht dort weiterhin löschen. Die Nachricht bleibt dann in Cloud in dem Ordner, in dem sie zuletzt lag, und trägt den Hinweis **Auf dem Server gelöscht, in Cloud aufbewahrt**. Du kannst diese Kopie lesen, durchsuchen und als `.eml` herunterladen. Archivieren, Verschieben und Markieren der Unterhaltung ändern diese Kopie nur in Cloud, denn der Mailserver hat sie nicht mehr. Hat Cloud eine Nachricht noch nicht vollständig geladen oder ist das Laden früher fehlgeschlagen, lädt das Aufbewahren sie. Von einer Nachricht, die der Server löscht, bevor Cloud sie laden konnte, etwa während das Postfach pausiert war oder ihr Ordner nicht synchronisiert wurde, oder von einer Nachricht über 128 MB hat Cloud keine Kopie.

Unter **Mail > Mehr > Aufbewahrt** stehen alle aufbewahrten Unterhaltungen des Postfachs, die neuesten zuerst, aus jedem Ordner. In der Suche findet die Bedingung **Aufbewahrt** sie ebenfalls, lässt sich mit anderen Bedingungen kombinieren und als Ansicht speichern.

Nur wer das Postfach verwaltet, kann den Schutz aufheben. Wähle **Weitere Unterhaltungsaktionen > Aufbewahrung aufheben** und bestätige. Danach kann die Unterhaltung in Cloud wieder gelöscht werden, und Nachrichten, von denen nur noch die Kopie in Cloud vorhanden ist, verschwinden aus dem Postfach. Bewahrt jemand die Unterhaltung später wieder auf, kehren sie nicht zurück. Aufbewahren und Aufheben werden mit Person und Zeitpunkt in der Aktivität der Unterhaltung und im Cloud-Audit-Log festgehalten. Eine aufbewahrte Unterhaltung hat kein Ablaufdatum; sie bleibt aufbewahrt, bis jemand die Aufbewahrung aufhebt.

## Eine einzelne Nachricht untersuchen {icon="file-search"}

Wenn du technische Angaben zu einer Nachricht brauchst, öffne die **Unterhaltungsdetails**. Klappe **E-Mail-Details** auf und wähle **Header** oder **Quelltext**. Wähle bei einer Unterhaltung mit mehreren Nachrichten oben im Inspektor die genaue Nachricht aus.

- **Übersicht** zeigt Nachrichten-IDs, Ablage beim Anbieter, Standardmarkierungen, Anbieter-Schlüsselwörter, MIME-Teile, Anhänge, Synchronisierungsstatus und Warnungen beim Auswerten.
- **Spamdiagnose** zeigt die Spam-Header des Anbieters, falls vorhanden. Cloud berechnet oder erschließt keinen eigenen Spamwert.
- **Header** zeigt jeden gespeicherten Header, auch wiederholte Zustellungsheader.
- **Quelldaten** zeigt eine begrenzte Vorschau der exakten ursprünglichen Nachricht. Wähle **.eml herunterladen** für die vollständige bytegenaue Datei.

Mit einer `.eml`-Datei überträgst du eine Nachricht in ein anderes E-Mail-Programm, meldest ein Zustellungsproblem oder bewahrst die ursprüngliche Nachricht für eine Untersuchung auf. Das Öffnen des Inspektors ändert weder die Nachricht noch ihren Zustand beim Anbieter.

Anbieter-Schlüsselwörter bleiben im Inspektor für Kompatibilität und Diagnose sichtbar. Nutze lokale Tags für normales Kennzeichnen. Mail bietet in den Nachrichten- und Unterhaltungsmenüs kein Bearbeiten von Anbieter-Schlüsselwörtern an.

:::warning Rohdaten vor dem Teilen prüfen
Rohe Header und `.eml`-Dateien können private Adressen, Servernamen, Routing-Angaben, Authentifizierungsergebnisse und den vollständigen Nachrichtentext enthalten. Prüfe sie, bevor du sie teilst.
:::

Bei älteren oder teilweise synchronisierten Nachrichten kann Mail den lesbaren Inhalt ohne die exakte ursprüngliche Quelle haben. Dann erklärt der Inspektor, dass Quelldaten und `.eml`-Download nicht verfügbar sind.

## Mailinglisten verwalten {icon="news"}

Mail erkennt Mailinglisten an den standardisierten Listenangaben in empfangenen Nachrichten. Alle, die das Postfach ansehen können, öffnen **Postfachwerkzeuge → Mailinglisten**. Die Seite zeigt jede erkannte Liste, ihr aktuelles Volumen, ihre neueste Nachricht und die Aktionen, die die Liste anbietet.

Welche Aktionen verfügbar sind, hängt von den Angaben des Absenders ab. Abmelde- und Aufräumaktionen brauchen Zugriff **Bearbeiten** oder **Verwalten**. Mit Zugriff **Ansehen** prüfst du Listen und folgst ihren Archiv- oder Schreiblinks.

:::warning Prüfe den Listennamen, bevor du dich abmeldest
Die Anfrage betrifft künftige Zustellungen für dieses Postfach und lässt sich schwer rückgängig machen. Sie löscht keine vorhandenen Nachrichten. Mail kann nicht garantieren, wann ein externer Listenanbieter die Zustellung beendet.
:::

- **Abmelden** bittet die Liste, keine E-Mails mehr zu senden. Mail nutzt eine geschützte Ein-Klick-Anfrage, wenn die Liste sie unterstützt. Sonst öffnet Mail die Abmeldeseite der Liste oder bereitet die Abmelde-E-Mail vor, die die Liste nennt.
- **An Mailingliste schreiben** öffnet die Adresse, die die Liste für neue Nachrichten nennt.
- **Archiv der Mailingliste** öffnet das Archiv, das die Liste angibt.
- Nach einer Ein-Klick-Abmeldung verschieben **Vorhandene archivieren** oder **Vorhandene in den Papierkorb verschieben** bis zu 500 bereits synchronisierte Nachrichten auf einmal. Wiederhole die Aktion, wenn Mail meldet, dass weitere Nachrichten übrig sind.

Mail öffnet nie einen Abmeldelink, nur weil du eine Nachricht in der Vorschau siehst oder liest. Listen ohne standardisierte Listenangaben erscheinen nicht unter **Mailinglisten**.

## Anhänge öffnen und auf eine Nachricht antworten {icon="paperclip"}

Empfangene Anhänge bleiben bei der Nachricht, die sie gebracht hat. Wähle einen Anhang, um ihn in einem neuen Browser-Tab zu öffnen oder herunterzuladen.

**Vorschau** öffnet Text, CSV, JSON, Bilder, PDFs, Audio und Video in einem Dialog. Ist eine Textdatei Markdown und beginnt mit einer Überschrift, wird diese Überschrift zum Titel, darunter stehen Dateiname und Größe. Der Kopf des Dialogs enthält **Anhang herunterladen**, bei Text, CSV und JSON auch **Kopieren**. Auf dem Smartphone füllt die Vorschau den Bildschirm.

Mit Zugriff **Verwalten** erstellst du auch einen öffentlichen Download-Link für einen Anhang. Mail zeigt die URL nur beim Erstellen des Links. Du kannst ihn mit einem Passwort, einem Ablaufzeitpunkt und einer Grenze für Download-Sitzungen schützen. Um vorhandene Links zu prüfen oder zu widerrufen, öffne **Postfachwerkzeuge → Freigabelinks**.

## Externe Bilder steuern {icon="photo-shield"}

Mail blockiert Bilder, die eine Nachricht von einem externen Server laden würde. Das Laden eines solchen Bildes kann dem Absender verraten, dass du die Nachricht geöffnet hast. Direkt in der Nachricht enthaltene Bilder bleiben sichtbar.

Enthält eine Nachricht blockierte Bilder, wähle:

- **Bilder laden**, um sie nur für diese geöffnete Nachricht zu laden.
- **Für diesen Absender immer laden**, um Bilder in künftigen Nachrichten genau dieser Adresse zu erlauben.
- **Für diese Domain immer laden**, um Bilder von jeder Adresse dieser Domain zu erlauben. Nutze diese breitere Option nur für eine Domain, der du vertraust.

Diese Einstellungen gelten nur für dich im aktuellen Postfach. Sie ändern nicht, was andere im Team sehen. Um gespeicherte Einstellungen zu prüfen oder zu entfernen, öffne **Postfachwerkzeuge → Externe Bilder**.

Mail lädt erlaubte Bilder über seinen geschützten Bilddienst, dein Browser bekommt die Bildadresse also nie. Der externe Server kann trotzdem erfahren, dass jemand sein Bild angefordert hat. Lass Bilder bei unbekannten oder verdächtigen Absendern blockiert.

Wähle unter einer aufgeklappten Nachricht:

- **Antworten**, um dem Absender zu antworten.
- **Allen antworten**, um die ursprünglichen Empfänger einzubeziehen.
- **Weiterleiten**, um eine Weiterleitung zu beginnen. Bevor Mail den Entwurf erstellt, entscheidest du, ob die ursprünglichen Anhänge dabei sind.
- **Als neue Nachricht verwenden**, um eine Nachricht in einen unabhängigen Entwurf zu kopieren, den du prüfen kannst. Das ändert ihre Unterhaltung nicht und sendet nichts.
- **Auswahl zitieren**, nachdem du Text im Nachrichtentext markiert hast. Mail fügt die markierten Zeilen als zitierte Antwort ein, sodass du direkt darunter antwortest.

Mehr zu Verfassen, Entwürfen, Anhängen, Signaturen und Zustelloptionen findest du unter [E-Mails verfassen und senden](/app/mail/help/mail-compose).

## Wiederverwendbare Ansichten und lokale Tags erstellen {icon="layout-list"}

Öffne **Einstellungen → Organisation**, um aus Ordner- und Zusammenarbeitsfiltern eine gespeicherte Ansicht zu erstellen. Eine Ansicht kann nach Ordner, zugewiesener Person, nächstem Schritt, lokalem Tag und danach filtern, ob die Unterhaltung unter **Später** liegt. Ein Filter für Unterhaltungen ohne zugewiesene Person funktioniert wie **Nicht zugewiesen**: Er findet auch Unterhaltungen, deren zugewiesene Personen sie nicht mehr bearbeiten können.

- **Nur für mich** erstellt eine private Ansicht.
- **Alle Personen mit Postfachzugriff** erstellt eine Postfachansicht und braucht Zugriff **Bearbeiten**.
- Die Sichtbarkeit kannst du nach dem Erstellen nicht ändern. Erstelle eine neue Ansicht, wenn du eine andere Sichtbarkeit brauchst.

Lokale Tags sind Kennzeichnungen im Postfach für Menschen, Suche und Automatisierungen. Wähle einen Tag unter **Tags** in der linken Navigation, um alle passenden Unterhaltungen zu öffnen. Lokale Tags sind keine IMAP-Ordner und keine Anbieter-Schlüsselwörter, und andere Programme zeigen sie nicht.

:::warning Ein gelöschter lokaler Tag verschwindet überall
Mail entfernt einen gelöschten lokalen Tag aus jeder Unterhaltung im Postfach. Gespeicherte Ansichten und Suchlinks, die nach einem gelöschten Tag oder Ordner filtern, finden für diese Bedingung keine Unterhaltungen.
:::

## Gruppierung von Unterhaltungen korrigieren {icon="arrows-split-2"}

Mail ordnet eine Nachricht der Unterhaltung zu, auf die ihre Antwort-Header verweisen. Das funktioniert auch, wenn eine Antwort vor der Nachricht synchronisiert wurde, auf die sie antwortet. Antworten auf eine Nachricht, die das Postfach nicht enthält, bleiben zusammen.

Eine Nachricht ohne Antwort-Header schließt sich einer früheren Unterhaltung nur an, wenn beides zutrifft:

- ihr Betreff beginnt mit einem Präfix wie `Re:`, `AW:` oder `Fwd:`;
- sie wurde innerhalb von 30 Tagen mit derselben externen Person ausgetauscht.

Sonst beginnt sie eine eigene Unterhaltung. Zwei Absender, die beide „Rechnung“ schreiben, bleiben getrennt.

Eine Nachricht bleibt eine Nachricht, egal wo sie liegt. Ein anderes E-Mail-Programm kann sie in einen anderen Ordner verschieben oder kopieren. Deine eigene E-Mail kann über eine Liste, eine Teamadresse oder eine Bcc an dich selbst wieder im Posteingang ankommen. In diesen Fällen zeigt die Unterhaltung die Nachricht einmal. Mail erkennt eine solche Kopie an ihren Headern, etwa Message-ID, Absender, Betreff und Datum. Eine Kopie der E-Mail einer anderen Person erkennt Mail auch an ihrer unveränderten Größe.

Für diese Aktionen brauchst du Zugriff **Bearbeiten**. Sie ändern, wie Cloud Unterhaltungen gruppiert, nicht den Inhalt der Nachrichten.

:::warning Es gibt kein automatisches Rückgängigmachen
Du kannst die Gruppierung mit denselben Aktionen erneut anpassen. Das stellt frühere Zuweisungen, Erinnerungen oder andere Zustände der Zusammenarbeit nicht wieder her.
:::

Wähle die Aktion:

- **Mit einer anderen Unterhaltung zusammenführen**, wenn zwei Cloud-Unterhaltungen zusammengehören.
- **Aus dieser Nachricht eine neue Unterhaltung erstellen** bei einer einzelnen Nachricht, wenn eine Antwort ein neues Thema beginnt.
- **Nachricht in eine andere Unterhaltung verschieben** bei einer einzelnen Nachricht, wenn sie in einen vorhandenen Verlauf gehört.

Zum Zusammenführen wählst du das Ziel aus demselben Postfach nach Absender oder Betreff. Prüfe Quelle und Ziel in der Bestätigung und führe dann zusammen.

- Das Ziel behält seinen Arbeitsstatus. Die zugewiesenen Personen beider Unterhaltungen bleiben zugewiesen. Mail führt keine Unterhaltungen zusammen, die zusammen mehr als 20 zugewiesene Personen haben.
- Nachrichten, Kommentare, Entwürfe, lokale Tags und Referenzen der Quelle wandern zum Ziel.
- Persönliche Erinnerungen wandern ebenfalls. Hat jemand eine Erinnerung an beiden Unterhaltungen, behält Mail die Erinnerung am Ziel.
- Mail entfernt die Quellunterhaltung.

Das Aufteilen in der Weboberfläche wählt eine Nachricht aus. Diese Nachricht und ihre verknüpften Kommentare wandern in eine neue Unterhaltung mit denselben zugewiesenen Personen. Entwürfe, Tags, Referenzen, Erinnerungen und andere Kommentare bleiben bei der Quelle. Die Quelle behält ihre zugewiesenen Personen und ihren Arbeitsstatus. Mindestens eine Nachricht muss in der Quelle bleiben.

Mail hält Änderungen in der Aktivität der Unterhaltung fest. Ändert eine andere Person eine der beiden Unterhaltungen, bevor du bestätigst, lehnt Mail deine veraltete Änderung ab. Lade neu und prüfe sie erneut.

## Dieses Postfach durchsuchen {icon="search"}

Drücke in einem Postfach **Cmd/Strg+Umschalt+K**, um seine Nachrichten und Anhänge zu durchsuchen. Der Name des Postfachs erscheint als Chip. Entferne den Chip, um die ganze Cloud zu durchsuchen.

Bei einer geöffneten Kalendereinladung bietet die Cloud-Suche **Diesen Termin in Spaces übernehmen oder aktualisieren** an. Wenn du antworten kannst, bietet sie auch **Antwort auf diese Einladung vorbereiten** an. Wähle einen Kalender, in dem du Zugriff **Bearbeiten** hast. Bestätige dann den Import oder wähle deine Antwort. Antworten öffnen sich als Entwürfe, die du vor dem Senden prüfst.
