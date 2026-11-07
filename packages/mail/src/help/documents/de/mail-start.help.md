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

- Wenn du Mail über die App-Navigation öffnest, öffnet Mail direkt ein Postfach. Mit einem Postfach öffnet Mail dieses. Mit mehreren öffnet Mail das Postfach, das du in diesem Browser zuletzt genutzt hast, wenn du es noch ansehen kannst und es nicht ausgeblendet hast. Sonst öffnet Mail dein erstes angeheftetes Postfach oder das erste Postfach der Liste.
- Eine Seite **Fokus** gibt es nicht mehr. In jedem Postfach zeigt **Mir zugewiesen**, was dir zugewiesen ist, und auch **Handlungsbedarf**, **Wartet auf Antwort** und **Nicht zugewiesen** sind Tabs. Ein alter Link auf Fokus öffnet dieselbe Ansicht oder Unterhaltung in einem Postfach. Ein Hinweis oben in der Seitenleiste sagt dir das einmal. Wähle **Verstanden**, um ihn auf allen deinen Geräten zu schließen.
- Das offene Postfach zeigt die Zahlen seiner Ansichten und Ordner. Die anderen Postfächer zeigen keine Zahlen.
- Wähle die Fahne neben einem Postfach, um es oben in der Liste anzuheften. Beim offenen Postfach liegen Fahne und Auge unter **…** in seiner Zeile.
- Wähle das durchgestrichene Auge, um ein selten genutztes Postfach auszublenden, etwa eine No-Reply-Adresse. Das Postfach verschwindet aus der Liste, und Mail öffnet es nicht, wenn du Mail öffnest.
- Ausgeblendete Postfächer liegen unter **Ausgeblendet** unterhalb der Liste. Öffne diesen Abschnitt, um eines zu erreichen, und wähle das Auge, um es wieder einzublenden.
- Deine angehefteten und ausgeblendeten Postfächer gelten auf jedem Gerät, auf dem du dich anmeldest. Sie gelten nur für dich. Andere mit Zugriff auf ein Postfach behalten ihre eigenen.
- Wähle **Neues Postfach**, um ein weiteres E-Mail-Konto zu verbinden.
- Ein neues Postfach ist zunächst privat. Du hast Zugriff **Verwalten**, und niemand sonst hat Zugriff, bis du ihn unter **… → Einstellungen → Zugriff** gibst.

Die offene Arbeit aller deiner Postfächer zusammen listet `cld mail focus` auf der Kommandozeile. Jeder Eintrag behält sein Postfach, und Mail prüft deinen Zugriff erneut, wenn du ihn öffnest.

## Das erste Postfach verbinden {icon="square-plus"}

:::steps
1. Wähle **Neues Postfach**.
2. Gib unter **Name** einen Namen ein, den andere im Team wiedererkennen. Die **Beschreibung** ist optional.
3. Öffne im Einstellungsdialog **Konten und Identitäten** und verbinde das Konto.
4. Gib die E-Mail-Adresse ein und wähle **Einstellungen suchen**. Du kannst IMAP- und SMTP-Host, Ports und TLS-Modi auch selbst eingeben.
5. Gib das Passwort oder App-Passwort ein, das dein IMAP-/SMTP-Anbieter akzeptiert.
6. Lass bei einem normalen Postfach **Diese Adresse zum Senden verwenden** eingeschaltet.
7. Wähle **Prüfen und verbinden**.
:::

Mail prüft IMAP und SMTP getrennt, bevor es die Zugangsdaten speichert. Mail verschlüsselt die Zugangsdaten, und nach dem Speichern kann niemand sie wieder lesen: weder Personen im Postfach noch die Administration. Mail bietet keine Autorisierung im Browser und keine automatische Erneuerung von Tokens. Ersetze manuelle Tokens, wenn sie ablaufen. Dein Anbieter muss die gewählte IMAP-/SMTP-Anmeldung erlauben.

Nach der Einrichtung findet Mail die Ordner des Anbieters und startet die Synchronisierung. Ältere Nachrichten können nach und nach erscheinen, während du das Postfach schon nutzt. Öffne **… → Postfachstatus**, um den Verbindungsstatus und den Stand von Ordnerermittlung, Synchronisierung und Suche zu sehen.

## Versandbereitschaft prüfen {icon="send"}

Öffne **… → Einstellungen → Konten und Identitäten → Absenderidentitäten**. Eine Absenderidentität fasst alles zusammen, was Mail für einen Versandkontext nutzt:

## Dich im Postfach zurechtfinden {icon="layout-grid"}

Die Seitenleiste enthält deine Postfächer, angeheftete zuerst. Das geöffnete Postfach zeigt darunter seine Ziele:

- **Eingang**, **Entwürfe**, **Geplant**, **Versandprobleme** und **Gesendet**.
- **Mehr** für Archiv, Papierkorb und Spam. Die Gruppe bleibt offen, solange einer dieser Ordner aktiv ist.
- Standardordner zeigen ihren üblichen Namen in deiner Sprache, zum Beispiel **Gesendet** für „Sent Items“. Ein Ordner mit eigenem Namen behält diesen Namen. Die Ordnereinstellungen zeigen auch den Namen auf dem Mailserver.
- Eigene Ordner des Anbieters mit ihrer Hierarchie und der Zahl ungelesener E-Mails.
- **Ausgeblendet** nach der Postfachliste fasst deine ausgeblendeten Postfächer in einer Zeile zusammen. Wähle die Zeile, um sie zu zeigen.
- **…** neben **Postfächer** enthält **Neues Postfach** und **Gelöschte Postfächer**. Zeige auf die Überschrift oder drücke Tab, um es zu sehen.

Im Kopfbereich findest du:

- Ansichten als Tabs: **Alle**, **Handlungsbedarf**, **Mir zugewiesen**, **Wartet auf Antwort**, **Nicht zugewiesen**, **Später**, **Erledigt**, **Letzte Aktivität**, **Aufbewahrt** und gespeicherte Ansichten. Der Kopf zeigt so viele davon, wie in seine Breite passen, die übrigen stehen unter **Mehr**. Die geöffnete Ansicht bleibt immer sichtbar. Ordner, Geplant und Versandprobleme haben keine Ansichts-Tabs.
- Das **Tag**-Symbol neben **Suchen**, wenn Tags existieren, den Chip **Suche** für eine aktive strukturierte Suche und **Zurücksetzen** zum Entfernen der Filter. Entferne den Suche-Chip, um die Suche zu beenden. Die Lupe oder `/` öffnet die Suche im Kopf; **Weitere Filter** öffnet dort den Filterdialog.
- **Unterhaltungen auswählen** ersetzt die Ansichten durch die Anzahl und Aktionen der Auswahl. **Auswahl beenden** bringt die Ansichten zurück.
- **… → Listenansicht auswählen** wechselt zwischen Unterhaltungen und einzelnen Nachrichten. Das Menü enthält außerdem Postfachdetails, Synchronisierung, Status, frühere Mail-Regeln, Mailinglisten, externe Bilder, Freigabelinks, E-Mail-Links und **Einstellungen**. Dein Zugriff bestimmt die Einträge. Mit Zugriff Ansehen heißt der Detail-Eintrag **Über dieses Postfach**. Wer nur zugewiesene Unterhaltungen sieht, kann hier die Listenansicht wählen; das **…** des geöffneten Postfachs in der Seitenleiste bietet dann nur Anheften und Ausblenden.
- **Verfassen** als Hauptaktion, wenn du senden kannst.

Auf dem Smartphone öffnest du über den Postfachtitel andere Postfächer und die Ordner des geöffneten Postfachs. Ansichten, Filter, Verfassen und **…** findest du im Kopfbereich.

**Postfachdetails** zeigt allen, die das Postfach ansehen können, denselben Überblick. Personen mit Zugriff **Ansehen** sehen ihn als **Über dieses Postfach**. Der Überblick zeigt:

- die Adressen des Postfachs, jeweils mit einer Schaltfläche zum Kopieren;
- die Verbindung und wann Mail zuletzt synchronisiert hat;
- die Zahl der Ordner;
- deinen eigenen Zugriff und wer welchen Zugriff hat.

Bei Gruppen siehst du die Personen, die die Gruppe erreicht, soweit dein Konto sie sehen darf. Gastkonten sehen nur ihren eigenen Zugriff, den Zugriff ihrer Gruppen und wie viele weitere Einträge es gibt. Der Dialog ändert nichts. Mit Zugriff **Verwalten** wählst du **Zugriff verwalten** und machst unter **… → Einstellungen → Zugriff** weiter.

Die mittlere Liste zeigt eine Zeile pro Unterhaltung: Absender und Zeit, den Betreff mit Zeichen für Anhang, Markierung und Zuweisung, und eine Vorschau. Tags und **Wartet** bekommen eine vierte Zeile. Auf einem breiten Bildschirm wird die Liste breiter, und Betreff und Nachrichten stehen in einer ruhigen Lesespalte. Der Lesebereich gruppiert die Nachrichten dieser Unterhaltung. Eine lange Unterhaltung zeigt ihre neuesten Nachrichten, **n ältere Nachrichten** zeigt den Rest. Er ordnet aussagekräftige Änderungen an Status, Zuweisung, Tags, Zusammenfassung und Workflow ruhig zu dem Zeitpunkt ein, an dem sie geschahen. Technische Verarbeitungsvorgänge bleiben aus dem Lesefluss heraus.

**Antworten**, **Allen antworten** und **Weiterleiten** stehen am Anfang der Werkzeugleiste des Lesebereichs, danach die Aktionen, die du mit **… > Werkzeugleiste anpassen** gewählt hast. Ab Tablet-Breite stehen die Aktionen in einer eigenen Zeile über dem Betreff. Ist der Lesebereich breit genug, tragen sie ihren Namen. Wird er schmaler, zeigen sie nur ihr Symbol und wandern dann mit den Aktionen, die nicht mehr passen, unter **…**. **…** enthält immer jede Aktion.

Wähle **Details** im Kopfbereich des Postfachs, um Teamkontext, lokale Tags, Zuständigkeit, Kommentare, Erinnerungen und die längere Liste der letzten Aktivitäten zu öffnen. Auf dem Smartphone nutzt du dafür das Details-Symbol neben **…** im Lesebereich. Die Details stehen neben dem Lesebereich, solange er genug Platz behält. Bei weniger Platz öffnen sie sich über dem Ende des Lesebereichs. Wenn du mehr Platz zum Lesen brauchst, blende die Unterhaltungsliste aus.

Neben einem Editor enthält der Unterhaltungsverlauf nur Nachrichten. Betriebliche Aktivitäten lenken dich beim Schreiben nicht ab.

## Darstellung im Posteingang wählen {icon="layout-grid"}

Wähle im Postfach unter **Darstellung**, wie Liste und Leser erscheinen. Auf großen Bildschirmen zeigt **Automatisch** zunächst Spalten. Sobald du einen Vorgang öffnest, stehen Liste und Leser nebeneinander. Du kannst auch **Immer Spalten** oder **Immer Liste + Leser** wählen. Auf dem Handy gibt es **Kompakt** und **Ausführlich**.

Während du neben der Liste liest, blendet **Darstellung → Unterhaltungsliste ausblenden** die Liste aus, und der Leser nutzt die volle Breite. Die Taste `[` blendet sie aus und wieder ein. Ohne Leser neben der Liste ist der Schalter gesperrt. Mail merkt sich die Wahl in diesem Browser.

In den Spalten zeigt **Beteiligt**, wer in der Unterhaltung geschrieben hat: bis zu drei Personen, dann „+N“. Zeige darauf, um die Namen zu sehen, getrennt nach **Extern**, **Team** und **Automationen**. Team und Automationen erkennt Mail an Antworten, die Mail gesendet hat. Eine Antwort aus einem anderen Mailprogramm zählt mit ihrer Absenderadresse. Wer nur zugewiesene Unterhaltungen sieht, sieht nur die Personen dieser Unterhaltungen. In einer schmalen Liste und auf dem Handy fehlt die Spalte. Liegt die Liste neben dem Lesebereich, stehen dieselben Gesichter am Ende der vierten Zeile, sobald außer dem genannten Absender noch jemand geschrieben hat.

In einem Team-Postfach zeigt **Zuständig** das Gesicht und den Namen der ersten zuständigen Person, dann „+N“ für weitere. Bist du zuständig, stehst du als „Du“ vorne. Zeige darauf, um alle Namen zu sehen. Ohne Zuständige steht dort „Niemand“.

Mail merkt sich die Wahl für dich und dieses Postfach, getrennt nach Handys und großen Bildschirmen. Deine Handywahl gilt auch auf deinen anderen Handys. Ohne gespeicherte Wahl verwendet Mail Automatisch und auf Handys Kompakt. Die Administration legt keine Vorgabe für dich fest.

**Heute erledigt** zählt die für dich sichtbaren Vorgänge, die am heutigen Tag in der Cloud-Zeitzone erledigt wurden. Jeder Vorgang zählt einmal, auch wenn er danach wieder geöffnet wurde. Für den Automationsanteil zählt, wer den Vorgang heute zuletzt erledigt hat.

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
- [Mail-Probleme beheben](/app/mail/help/mail-troubleshooting)


## Mit Code automatisieren

Öffne die **Code**-Seite des Postfachs, um eine Automatisierung zu erstellen. Gustav kann exportierte Regeln als Code neu aufbauen. Prüfe Zugriffe und Änderungen und aktiviere den Code ausdrücklich. Frühere Regelprotokolle bleiben nur lesbar. Abwesenheitsantworten, Bürozeitenantworten und Eingangsbestätigungen mit Referenznummer sind ohne Ersatz entfernt.
