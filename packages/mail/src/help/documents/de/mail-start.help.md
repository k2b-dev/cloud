---
id: mail-start
title: Mit Mail beginnen
icon: ti ti-mail-plus
description: Postfächer verstehen, ein Konto verbinden und die erste Synchronisierung sicher abschließen.
order: 10
---

Mail organisiert E-Mails in **Postfächern**. Mail spiegelt E-Mails eines verbundenen Anbieters in das zugehörige Cloud-Postfach. Ein Postfach verbindet ein E-Mail-Konto und enthält die Ordner dieses Anbieters. Es legt auch fest, wer es ansehen, bearbeiten oder verwalten kann.

Der E-Mail-Anbieter bleibt die Quelle für übertragbare E-Mail-Zustände. Wenn du eine Nachricht verschiebst, ihren Lesestatus änderst, sie markierst oder eine E-Mail sendest, können andere E-Mail-Programme für dasselbe Konto die Änderung zeigen. Cloud ergänzt Daten für die Zusammenarbeit: zugewiesene Personen, interne Kommentare, lokale Tags, Erinnerungen und den Status der Nachverfolgung. Andere E-Mail-Programme zeigen diese Angaben aus Cloud nicht.

## Den passenden Einstieg wählen {icon="square-plus"}

- Wenn du Mail über die App-Navigation öffnest, siehst du **Fokus**. Fokus ist eine gemeinsame Arbeitsliste für alle Postfächer, die du ansehen kannst.
- **Für mich** zeigt dir zugewiesene Unterhaltungen mit Handlungsbedarf. **Nicht zugewiesen** zeigt Arbeit ohne zuständige Person.
- **Wartet** zeigt deine zugewiesenen Unterhaltungen, die auf eine Antwort warten. **Alle aktiven** zeigt alle nicht erledigten Unterhaltungen, die du ansehen kannst und die nicht unter **Später** liegen.
- Jede Postfachschaltfläche zeigt, wie viele Unterhaltungen Handlungsbedarf haben. Ein Punkt am Postfachsymbol bedeutet ungelesene Unterhaltungen außerhalb von Papierkorb und Spam. Zeige auf die Schaltfläche, um beide genauen Zahlen zu sehen.
- Öffne ein Postfach, wenn du Ordner, eine Suche im ganzen Postfach oder Einstellungen brauchst.
- Wähle die Fahne neben einem Postfach, um es oben in der Liste anzuheften.
- Wähle das durchgestrichene Auge, um ein selten genutztes Postfach auszublenden, etwa eine No-Reply-Adresse. Das Postfach verschwindet aus der Liste, und seine Unterhaltungen verschwinden aus Fokus und den Zahlen in Fokus.
- Ausgeblendete Postfächer liegen unter **Ausgeblendet** unterhalb der Liste. Öffne diesen Abschnitt, um eines zu erreichen, und wähle das Auge, um es wieder einzublenden.
- Deine angehefteten und ausgeblendeten Postfächer gelten auf jedem Gerät, auf dem du dich anmeldest. Sie gelten nur für dich. Andere mit Zugriff auf ein Postfach behalten ihre eigenen.
- Wähle auf einem großen Bildschirm eine Zeile in Fokus aus, um daneben Kontext, Zusammenfassung, Workflow-Felder und Teamnotizen zu sehen. Auf einem kleineren Bildschirm öffnet die Zeile die Unterhaltung in ihrem Postfach.
- Wähle **Neues Postfach**, um ein weiteres E-Mail-Konto zu verbinden.
- Ein neues Postfach ist zunächst privat. Du hast Zugriff **Verwalten**, und niemand sonst hat Zugriff, bis du ihn unter **Einstellungen → Zugriff** gibst.

Fokus kopiert oder verschiebt keine E-Mails zwischen Postfächern. Jede Zeile behält ihr ursprüngliches Postfach. Wenn du eine Zeile öffnest, prüft Mail deinen aktuellen Zugriff auf das Postfach erneut.

## Das erste Postfach verbinden {icon="square-plus"}

:::steps
1. Wähle **Neues Postfach**.
2. Gib einen **Name** ein, den andere im Team wiedererkennen. Die **Beschreibung** ist optional.
3. Öffne im Einstellungsdialog **Konten und Identitäten** und verbinde das Konto.
4. Gib die E-Mail-Adresse ein und wähle **Einstellungen suchen**. Du kannst IMAP- und SMTP-Host, Ports und TLS-Modi auch selbst eingeben.
5. Gib das Passwort oder App-Passwort ein, das dein IMAP-/SMTP-Anbieter akzeptiert.
6. Lass bei einem normalen Postfach **Diese Adresse zum Senden verwenden** eingeschaltet.
7. Wähle **Prüfen und verbinden**.
:::

Mail prüft IMAP und SMTP getrennt, bevor es die Zugangsdaten speichert. Mail verschlüsselt die Zugangsdaten, und nach dem Speichern kann niemand sie wieder lesen: weder Personen im Postfach noch die Administration. Mail bietet keine Autorisierung im Browser und keine automatische Erneuerung von Tokens. Ersetze manuelle Tokens, wenn sie ablaufen. Dein Anbieter muss die gewählte IMAP-/SMTP-Anmeldung erlauben.

Nach der Einrichtung findet Mail die Ordner des Anbieters und startet die Synchronisierung. Ältere Nachrichten können nach und nach erscheinen, während du das Postfach schon nutzt. Öffne **Postfachwerkzeuge → Postfachstatus**, um den Verbindungsstatus und den Stand von Ordnererkennung, Synchronisierung und Suche zu sehen.

## Versandbereitschaft prüfen {icon="send"}

Öffne **Einstellungen → Konten und Identitäten → Absenderidentitäten**. Eine Absenderidentität fasst alles zusammen, was Mail für einen Versandkontext nutzt:

- Die **Bezeichnung der Absenderidentität** ist nur im Postfach sichtbar. Sie hilft dem Team, den richtigen Kontext zu wählen, etwa „Universität“ oder „Privat“.
- Empfänger sehen den **Anzeigename** und die **Absenderadresse**.
- Eine normale Verbindung erstellt eine Standard-Absenderidentität für die Adresse des Kontos.
- Mail sendet mit einer Absenderidentität erst, wenn sie bestätigt ist. Zwei Absenderidentitäten können dieselbe Absenderadresse mit unterschiedlichen Standardwerten nutzen.
- **Automatische Antworten** ist eine eigene Einstellung jeder Absenderidentität. Sie ist bei neuen Absenderidentitäten eingeschaltet. Mail sendet automatische E-Mails erst, wenn jemand mit Zugriff **Verwalten** eine automatische Antwort oder einen Workflow erstellt und einschaltet.

## Dich im Postfach zurechtfinden {icon="layout-grid"}

Die linke Navigation enthält:

- **Verfassen** ganz oben, wenn du senden kannst. Daneben steht die Schaltfläche **Postfachdetails** (i). Kannst du das Postfach nur ansehen, steht dort **Über dieses Postfach** und öffnet dieselben Details. Auf dem Smartphone stehen sie in der ersten Zeile des App-Menüs.
- **Nachverfolgung** mit Handlungsbedarf, Wartet auf Antwort, Später und Erledigt.
- **Zuweisung** mit Mir zugewiesen und Nicht zugewiesen.
- **E-Mail** mit Posteingang, Entwürfe, Geplant, Gesendet und einer Gruppe **Mehr**, die du aufklappen kannst.
- **Ordner** mit eigenen Ordnern des Anbieters und ihrer verschachtelten Hierarchie. Mit Zugriff **Verwalten** blendest du Ordner hier aus. Das Ausblenden löscht keinen Ordner und bestellt ihn nicht ab.
- **Tags**, um alle Unterhaltungen mit einem postfachlokalen Tag zu öffnen. Dieser Abschnitt erscheint nur, wenn mindestens ein Tag existiert.
- **Gespeicherte Ansichten**, die aus wiederverwendbaren Filtern für Postfach und Zusammenarbeit entstanden sind. Dieser Abschnitt erscheint nur, wenn mindestens eine Ansicht existiert.
- **Mehr** mit Alle E-Mails, Letzte Aktivität, Archiv, Papierkorb und Spam. Alle E-Mails umfasst das Postfach außer Papierkorb und Spam. Mehr öffnet sich automatisch, wenn eines dieser Ziele aktiv ist.
- **Postfachwerkzeuge** für Synchronisierung, Status, Automatisierungen, Mailinglisten, externe Bilder, Freigabelinks und den Umgang des Browsers mit E-Mail-Links. Welche Werkzeuge du siehst, hängt von deinem Zugriff ab.
- **Einstellungen** am unteren Rand, wenn dein Zugriff es erlaubt.

**Postfachdetails** zeigt allen, die das Postfach ansehen können, denselben Überblick. Personen mit Zugriff **Ansehen** sehen ihn als **Über dieses Postfach**. Der Überblick zeigt:

- die Adressen des Postfachs, jeweils mit einer Schaltfläche zum Kopieren;
- die Verbindung und wann Mail zuletzt synchronisiert hat;
- die Zahl der Ordner;
- deinen eigenen Zugriff und wer welchen Zugriff hat.

Bei Gruppen siehst du die Personen, die die Gruppe erreicht, soweit dein Konto sie sehen darf. Gastkonten sehen nur ihren eigenen Zugriff, den Zugriff ihrer Gruppen und wie viele weitere Einträge es gibt. Der Dialog ändert nichts. Mit Zugriff **Verwalten** wählst du **Zugriff verwalten** und machst unter **Einstellungen → Zugriff** weiter.

Die mittlere Liste zeigt eine Zeile pro Unterhaltung. Der Lesebereich gruppiert die Nachrichten dieser Unterhaltung. Er ordnet aussagekräftige Änderungen an Status, Zuweisung, Tags, Zusammenfassung und Workflow ruhig zu dem Zeitpunkt ein, an dem sie geschahen. Technische Verarbeitungsvorgänge bleiben aus dem Lesefluss heraus.

Wähle **Unterhaltungsdetails**, um Teamkontext, lokale Tags, Zuständigkeit, Kommentare, Erinnerungen und die längere Liste der letzten Aktivitäten zu öffnen. Wenn du mehr Platz zum Lesen brauchst, blende die Unterhaltungsliste aus.

Neben einem Editor enthält der Unterhaltungsverlauf nur Nachrichten. Betriebliche Aktivitäten lenken dich beim Schreiben nicht ab.

## Auf Kalendereinladungen antworten {icon="calendar-event"}

Mail erkennt `.ics`- und `text/calendar`-Anhänge bis zu einer Größengrenze, aber **Spaces bleibt der Kalender**. Klappe eine Einladung auf, um Organisator, Zeit, Ort und aktuellen Status zu sehen.

- **Ohne Antwort hinzufügen:** Füge den Termin ohne Antwort zu einem Space hinzu, in dem du Zugriff **Bearbeiten** hast.
- **Antworten:** Wähle **Zusagen**, **Vielleicht** oder **Absage**. Mail speichert oder aktualisiert den Termin und bereitet in einem Schritt eine Antwort vor.

Jede Antwort öffnet sich als Mail-Entwurf, den du bearbeiten kannst. Mail meldet erst dann, dass der Organisator benachrichtigt wurde, wenn du den Entwurf im normalen Editor sendest.

Schlägt der Entwurf fehl, nachdem Mail den Termin gespeichert hat, meldet Mail dieses Teilergebnis. Ein erneuter Versuch aktualisiert denselben Termin und erstellt kein Duplikat. Sind Spaces oder die benötigte Capability nicht verfügbar, blendet Mail die Kalenderaktionen aus. Der ursprüngliche Kalenderanhang bleibt wie jede andere Datei verfügbar.

## Mit einer Aufgabe fortfahren {icon="point"}

- [E-Mails lesen, suchen und organisieren](/app/mail/help/mail-work)
- [E-Mails verfassen und senden](/app/mail/help/mail-compose)
- [Gemeinsam in einem Postfach arbeiten](/app/mail/help/mail-collaboration)
- [Ein Postfach einrichten und verwalten](/app/mail/help/mail-admin)
- [Antworten und Postfacharbeit automatisieren](/app/mail/help/mail-automation)
- [Mail-Workflow-YAML-Referenz](/app/mail/help/mail-workflows)
- [Mail-Probleme beheben](/app/mail/help/mail-troubleshooting)
