---
id: mail-start
title: Mit Mail beginnen
icon: ti ti-mail-plus
description: Postfächer verstehen, ein Konto verbinden und die erste Synchronisierung sicher abschließen.
order: 10
---

Mail organisiert E-Mails in **Postfächern**. Mail spiegelt E-Mails eines verbundenen Anbieters in das zugehörige Cloud-Postfach. Ein Postfach verbindet ein E-Mail-Konto, enthält die vom Anbieter bereitgestellten Ordner und legt fest, wer es lesen, bedienen oder verwalten darf.

Der E-Mail-Anbieter bleibt die maßgebliche Quelle für übertragbare E-Mail-Zustände. Wenn du eine Nachricht verschiebst, ihren Lesestatus oder ihre Markierung änderst oder eine E-Mail sendest, kann die Änderung deshalb auch in anderen E-Mail-Programmen für dasselbe Konto erscheinen. Cloud ergänzt Daten für die Zusammenarbeit, etwa Zuständigkeiten, interne Kommentare, lokale Tags, Erinnerungen und den Nachverfolgungsstatus. Diese Angaben aus Cloud erscheinen nicht in anderen E-Mail-Programmen.

## Den passenden Einstieg wählen {icon="square-plus"}

- Wenn du Mail über die App-Navigation öffnest, erscheint **Fokus**: eine gemeinsame Arbeitsliste für alle Postfächer, die du lesen darfst.
- Unter **Für mich** findest du dir zugewiesene Unterhaltungen mit Handlungsbedarf. **Nicht zugewiesen** zeigt Vorgänge ohne zuständige Person, **Wartend** deine zugewiesenen Unterhaltungen, die auf eine Antwort warten, und **Alle aktiven** alle nicht abgeschlossenen und nicht zurückgestellten Unterhaltungen, die du lesen darfst.
- Jede Postfachschaltfläche zeigt die Anzahl ungelesener Unterhaltungen und der Unterhaltungen mit Handlungsbedarf. Öffne ein Postfach, wenn du Ordner, die postfachweite Suche oder Einstellungen benötigst.
- Auf einem großen Bildschirm kannst du eine Zeile in Fokus auswählen und daneben Kontext, Zusammenfassung, Workflow-Felder und Teamnotizen prüfen. Auf einem kleineren Bildschirm öffnet die Auswahl die Unterhaltung in ihrem Postfach.
- Wähle **Neues Postfach**, um ein weiteres E-Mail-Konto zu verbinden.
- Ein neues Postfach ist zunächst privat. Du verwaltest es, bis du unter **Einstellungen > Zugriff** weitere Berechtigungen vergibst.

Fokus kopiert oder verschiebt keine E-Mails zwischen Postfächern. Jede Zeile behält ihr ursprüngliches Postfach. Beim Öffnen prüft Mail deine aktuelle Postfachberechtigung erneut.

## Das erste Postfach verbinden {icon="square-plus"}

:::steps
1. Wähle **Neues Postfach**.
2. Gib einen **Namen** ein, den andere Personen im Team wiedererkennen. Die Beschreibung ist optional.
3. Öffne im Einstellungsdialog **Konten und Identitäten** und verbinde das Konto.
4. Gib die E-Mail-Adresse ein und wähle **Einstellungen suchen**. Du kannst IMAP- und SMTP-Host, Ports und TLS-Modi auch selbst eingeben.
5. Wähle bei einem konfigurierten Google- oder Microsoft-Konto die OAuth-Schaltfläche für den Browser und erteile den Zugriff. Gib bei anderen Konten das Passwort, App-Passwort oder OAuth2-Zugriffstoken des Anbieters ein.
6. Lass **Standardidentität für diese Adresse erstellen** bei einem normalen Postfach aktiviert.
7. Wähle **Prüfen und verbinden**.
:::

Mail prüft IMAP und SMTP getrennt, bevor die Zugangsdaten gespeichert werden. Zugangsdaten und OAuth-Aktualisierungstoken werden verschlüsselt und schreibgeschützt gespeichert: Nach der Annahme können weder Personen mit Zugriff noch Personen mit Postfach-Adminrechten sie erneut anzeigen. Verwaltete OAuth-Verbindungen werden automatisch aktualisiert und zeigen **Erneut verbinden**, wenn die Zustimmung beim Anbieter abgelaufen ist oder widerrufen wurde. Manuelle Zugangsdaten stehen weiterhin für alle allgemeinen IMAP-/SMTP-Anbieter zur Verfügung.

Nach der Einrichtung erkennt Mail die Ordner des Anbieters und beginnt mit der Synchronisierung. Ältere Nachrichten können nach und nach erscheinen, während das Postfach bereits nutzbar ist. Unter **Postfachwerkzeuge > Postfachstatus** findest du den Verbindungsstatus sowie den Stand von Ordnererkennung, Synchronisierung und Suche.

## Versandbereitschaft prüfen {icon="send"}

Öffne **Einstellungen > Konten und Identitäten > Absenderidentitäten**. Eine Identität fasst alles zusammen, was Mail für einen Versandkontext verwenden soll:

- Die **Bezeichnung der Identität** ist nur im Postfach sichtbar und hilft dem Team, den richtigen Kontext zu wählen, etwa „Universität“ oder „Privat“.
- **Anzeigename** und **Absenderadresse** sind für Empfänger sichtbar.
- Eine normale Verbindung erstellt eine Standardidentität für die Adresse des Kontos.
- Jede Identität muss **bestätigt** sein, bevor Mail damit senden kann. Zwei Identitäten dürfen dieselbe Absenderadresse mit unterschiedlichen Standardeinstellungen verwenden.
- **Automatische Antworten** ist eine separate Berechtigung der Identität. Sie ist bei neuen Identitäten standardmäßig aktiviert. Automatische E-Mails werden dennoch erst versendet, nachdem eine Person mit Adminrechten eine automatische Antwort oder einen Workflow erstellt und aktiviert hat.

## Den Postfach-Arbeitsbereich verstehen {icon="layout-grid"}

Die linke Navigation enthält:

- **Nachverfolgung** mit Handlungsbedarf, Wartet auf Antwort, Zurückgestellt und Erledigt.
- **Zuordnung** mit Mir zugewiesen und Nicht zugewiesen.
- **Mail** mit Posteingang, Entwürfe, Geplant, Gesendet und einer ausklappbaren Mehr-Gruppe.
- **Ordner** mit eigenen Anbieterordnern und deren verschachtelter Hierarchie. Personen mit Postfach-Adminrechten können Ordner hier ausblenden, ohne sie zu löschen oder abzubestellen.
- **Tags** zum Öffnen aller Unterhaltungen mit einem postfachlokalen Tag. Dieser Abschnitt erscheint nur, wenn mindestens ein Tag vorhanden ist.
- **Gespeicherte Ansichten**, die aus wiederverwendbaren Postfach- und Zusammenarbeitsfiltern erstellt wurden. Dieser Abschnitt erscheint nur, wenn mindestens eine Ansicht vorhanden ist.
- **Mehr** mit Alle E-Mails, Letzte Aktivität, Archiv, Papierkorb und Junk. Alle E-Mails umfasst das gesamte Postfach außer Papierkorb und Junk. Mehr öffnet sich automatisch, wenn eines dieser Ziele aktiv ist.
- **Postfachwerkzeuge** für Synchronisierung, Status, Automatisierungen, Mailinglisten, externe Bilder, geteilte Links und den Umgang des Browsers mit E-Mail-Links. Die verfügbaren Werkzeuge richten sich nach deiner Berechtigung.
- **Einstellungen** am unteren Rand, sofern deine Berechtigung den Zugriff erlaubt.

Die mittlere Liste zeigt eine Zeile pro Unterhaltung. Der Lesebereich gruppiert die Nachrichten dieser Unterhaltung und ordnet aussagekräftige Änderungen an Status, Zuständigkeit, Tags, Zusammenfassung und Workflow zeitlich ein. Technische Verarbeitungsvorgänge bleiben aus dem Lesefluss heraus. Über **Unterhaltungsdetails** öffnest du Teamkontext, lokale Tags, Zuständigkeit, Kommentare, Erinnerungen und die ausführlichere Liste der letzten Aktivitäten. Wenn du mehr Platz zum Lesen brauchst, kannst du die Unterhaltungsliste ausblenden.

Der Unterhaltungsverlauf neben einem Editor enthält nur Nachrichten. Betriebliche Aktivitäten lenken dadurch beim Schreiben nicht ab.

## Mit Kalendereinladungen arbeiten {icon="calendar-event"}

Mail erkennt begrenzte `.ics`- und `text/calendar`-Anhänge, aber **Spaces bleibt der Kalender**. Klappe eine Einladung auf, um Organisator, Zeit, Ort und aktuellen Status zu sehen. Du kannst sie ohne Antwort in einen beschreibbaren Space übernehmen. Mit **Zusagen**, **Vielleicht** oder **Absagen** speicherst oder aktualisierst du den Termin und bereitest zugleich eine Antwort vor.

Jede Antwort wird als bearbeitbarer Mail-Entwurf geöffnet. Mail behauptet erst dann, dass der Organisator benachrichtigt wurde, wenn du die Antwort im normalen Editor sendest. Schlägt die Erstellung des Entwurfs fehl, nachdem der Termin gespeichert wurde, meldet Mail dieses Teilergebnis. Ein erneuter Versuch aktualisiert denselben Termin, statt ein Duplikat zu erstellen. Wenn Spaces oder die benötigte Capability nicht verfügbar ist, bleiben die Integrationsaktionen ausgeblendet und der ursprüngliche Kalenderanhang steht wie jede andere Datei zur Verfügung.

## Mit einer Aufgabe fortfahren {icon="point"}

- [E-Mails lesen, suchen und organisieren](/app/mail/help/mail-work)
- [E-Mails verfassen und senden](/app/mail/help/mail-compose)
- [Gemeinsam in einem Postfach arbeiten](/app/mail/help/mail-collaboration)
- [Ein Postfach einrichten und verwalten](/app/mail/help/mail-admin)
- [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation)
- [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows)
- [Mail-Probleme beheben](/app/mail/help/mail-troubleshooting)
