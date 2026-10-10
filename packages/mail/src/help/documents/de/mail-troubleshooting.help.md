---
id: mail-troubleshooting
title: Mail-Probleme beheben
icon: ti ti-lifebuoy
description: Fehlende E-Mails, pausierten Transport, Versandfehler, Entwurfskonflikte und Lücken in der Suche untersuchen.
order: 80
---

Beginne mit dem Symptom, das du siehst. Können Transport, Ordner oder Suche beteiligt sein, nutze **Postfachwerkzeuge → Postfachstatus**.

## Das Postfach fehlt in der Übersicht {icon="lifebuoy"}

:::steps
1. Leere **Postfächer durchsuchen**.
2. Prüfe, ob dir jemand mit Zugriff **Verwalten** Zugriff auf das Postfach gegeben hat.
3. Wurde das Postfach gelöscht, kann eine Person mit Zugriff **Verwalten** es unter **Kürzlich gelöscht** wiederherstellen.
:::

Mail prüft den Zugriff beim Laden der Seite und bei Live-Aktualisierungen. Endet dein Zugriff, schlagen Neuladen und Live-Ansichten fehl und zeigen keine alten Daten des Postfachs weiter an.

## Neue E-Mails oder älterer Verlauf fehlen {icon="lifebuoy"}

:::steps
1. Prüfe die Statuswarnung über der Unterhaltungsliste.
2. Öffne **Postfachwerkzeuge → Postfachstatus**.
3. Ist das Postfach pausiert, wähle **Postfach fortsetzen**.
4. Wähle **Jetzt synchronisieren**.
5. Fehlen Ordner oder haben sie sich geändert, wähle **Ordner neu ermitteln**.
:::

Die erste Synchronisierung lädt den Verlauf schrittweise. Eine Nachricht kann erscheinen, bevor ihr vollständiger Inhalt oder ihre Anhänge synchronisiert sind. Der Lesebereich zeigt dann **Der Nachrichteninhalt wird noch synchronisiert**. Sobald die Synchronisierung fertig ist, zeigt er den Inhalt, ohne dass du die Seite neu lädst.

Startet Mail neu, während es einen Nachrichteninhalt lädt, kann der Lesebereich für diese Nachricht eine Weile **Der Nachrichteninhalt konnte nicht synchronisiert werden** zeigen. Mail lädt den Inhalt erneut, nachdem die übrigen fehlenden Inhalte des Postfachs geladen sind. Bei einer großen ersten Synchronisierung kann das Stunden dauern. Zeigt die Unterhaltungsliste **Live-Aktualisierung pausiert**, wähle **Nachricht aktualisieren**, um den aktuellen Stand zu laden.

Manchmal ist der E-Mail-Anbieter nicht erreichbar oder lehnt Anmeldungen eine Zeit lang ab, etwa während einer Wartung oder weil zu viele Verbindungen offen sind. Mail versucht es weiter und macht von selbst weiter, wenn der Anbieter wieder antwortet. Ein neues Passwort oder neue Zugangsdaten brauchst du nur, wenn der Anbieter die aktuellen ablehnt.

Mail kann einen Absender- oder Empfängereintrag nicht als Adresse speichern, wenn er weniger als 3 oder mehr als 320 Zeichen hat. Ein Beispiel ist ein Textfragment in einer fehlerhaften Nachricht. Mail importiert die Nachricht trotzdem und lässt nur diesen Eintrag weg. Der ursprüngliche Header bleibt unter **Header** in den Unterhaltungsdetails.

Bei Ordnern, die der Anbieter teilt, prüfe zuerst, ob das verbundene IMAP-Konto noch das nötige Abonnement und den nötigen Zugriff beim Anbieter hat. Mail findet nur Ordner, die der Anbieter diesem Konto zeigt.

## Eine Änderung aus einem anderen E-Mail-Programm erscheint noch nicht {icon="lifebuoy"}

Mail prüft jeden synchronisierten Ordner etwa einmal pro Minute. Der Posteingang aktualisiert sich meist sofort. Eine Nachricht, die du in einem anderen E-Mail-Programm oder auf dem Smartphone löschst oder verschiebst, verlässt ihren alten Ordner bei der nächsten Prüfung, in jedem Ordner. Änderungen an Gelesen-Status und Fahne aus anderen Programmen kommen genauso an.

- **Anbieter, die solche Änderungen nicht melden:** Das gilt für die neuesten paar tausend Nachrichten eines Ordners. Änderungen an älteren Nachrichten in einem größeren Ordner kommen nacheinander an und können länger dauern.
- **Mehr als 500 Ordner:** Synchronisiert eine Installation mehr als 500 Ordner, prüft Mail weiterhin jeden Posteingang jede Minute und die anderen Ordner nacheinander. Diese können einige Minuten brauchen.

Um ein Postfach sofort zu prüfen, öffne **Postfachwerkzeuge → Postfachstatus** und wähle **Jetzt synchronisieren**.

## Ein Ordner fehlt in der Seitenleiste {icon="folder"}

Öffne mit Zugriff **Verwalten** **Einstellungen → Ordner** und unterscheide diese Fälle:

- **Ausgeblendet:** Wähle unter **Wo E-Mails erscheinen** **Überall** oder **Nur im Ordner**, um den Ordner wieder in der Cloud-Navigation zu zeigen. Beim Anbieter ändert sich dadurch nichts.
- **Nicht abonniert:** Abonniere den Ordner, wenn dieser Anbieter oder ein anderes E-Mail-Programm über IMAP-Abonnements entscheidet, welche Ordner es zeigt.
- **Nicht verfügbar:** Das verbundene Konto zeigt den Ordner nicht mehr. Prüfe das Konto beim Anbieter, den Namensraum und den Zugriff beim Anbieter und führe dann **Ordner neu ermitteln** aus.
- **Prüfung erforderlich:** Die Ermittlung hat widersprüchliche Zustände beim Anbieter gefunden. Prüfe **Ordnerermittlung** in **Postfachwerkzeuge → Postfachstatus**, bevor du E-Mails änderst.

Ein ausgeblendeter übergeordneter Ordner blendet auch seine Unterordner in der Seitenleiste aus, damit die Hierarchie verständlich bleibt. Ihre E-Mails und ihre eigenen Einstellungen zur Sichtbarkeit bleiben erhalten.

## Beim Senden erscheint „Mailbox transport is paused“ {icon="send"}

Jemand mit Zugriff **Verwalten** hat das Postfach pausiert oder wiederhergestellt, und ein wiederhergestelltes Postfach startet immer pausiert.

:::steps
1. Öffne **Postfachwerkzeuge → Postfachstatus**.
2. Prüfe die Verbindung zum Anbieter und den Status.
3. Wähle **Postfach fortsetzen**.
:::

Solange das Postfach pausiert ist, laufen weder eingehende Synchronisierung noch eingereihte Änderungen beim Anbieter, geplante Zustellungen oder automatische Antworten.

## Eine Nachricht lässt sich nicht senden {icon="point"}

Prüfe diese Bedingungen:

- Du hast Zugriff **Bearbeiten** oder **Verwalten**.
- **Von** nutzt eine bestätigte Absenderidentität.
- **Postfachwerkzeuge → Postfachstatus** zeigt eine funktionierende Verbindung.
- Der Entwurf hat Empfänger und entweder Text oder einen Anhang.
- Jeder Upload eines Anhangs ist erfolgreich abgeschlossen, und keine Datei ist größer als 100 MiB.
- Du hast alle Versandwarnungen für die aktuelle gespeicherte Fassung geprüft. Änderst du nach der Zustimmung Empfänger, Links, Text oder Anhänge, musst du erneut prüfen.
- Die vollständige kodierte Nachricht passt in das aktuelle Limit für ausgehende Nachrichten, das der Anbieter veröffentlicht.
- Die Zugangsdaten beim Anbieter sind nicht abgelaufen und wurden nicht widerrufen.

Ein Anhang kann das Limit von Mail mit 100 MiB pro Datei einhalten, während die vollständige kodierte Nachricht ein kleineres Limit des Anbieters überschreitet. Entferne einen oder mehrere Anhänge, oder erstelle einen öffentlichen Download-Link und sende stattdessen diesen Link. Mit Zugriff **Verwalten** prüfst und aktualisierst du die beobachteten Werte unter **Postfachwerkzeuge → Postfachstatus → Anbieterlimits**.

Haben sich die Zugangsdaten beim Anbieter geändert, nutze **Einstellungen → Konten und Identitäten → Verbundenes Konto → Konto bearbeiten**. Mail kann das vorhandene Geheimnis nicht anzeigen, und du kannst es nicht teilweise bearbeiten.

## Automatische Antworten melden, dass keine Absenderidentität verfügbar ist {icon="send"}

Öffne **Einstellungen → Konten und Identitäten → Absenderidentitäten**. Prüfe, dass eine Absenderidentität beide Bedingungen erfüllt:

:::steps
1. Der Status der Absenderidentität ist **Bereit**.
2. **Automatische Antworten** ist eingeschaltet.
:::

Kehre dann zu **Automatisierungen → Automatische Antworten** zurück. Vorhandene automatische Antworten können sichtbar bleiben, solange keine passende Absenderidentität existiert. Um eine automatische Antwort zu erstellen oder wieder einzuschalten, brauchst du eine passende Absenderidentität.

## Eine geplante Nachricht wurde nicht gesendet {icon="send"}

Öffne **Geplant** und prüfe den Eintrag:

- **Hinweis auf Wiederholung:** Die Zustellung ist fehlgeschlagen, und Mail hat den Eintrag für einen weiteren Versuch behalten.
- **Wartet auf Anmeldung:** Das Konto des Postfachs muss neu verbunden werden. Danach geht die Nachricht hinaus. Nach sechs Tagen ohne neue Verbindung kehrt sie zu den Entwürfen zurück.
- **Pausiertes Postfach:** Der Versuch läuft nicht.
- **Abbrechen:** Bevor die Zustellung beginnt, kannst du den Eintrag in einen gemeinsamen Entwurf zurückverwandeln oder verwerfen.

Der geplante Zeitpunkt muss mindestens eine Minute in der Zukunft liegen. Der Dialog zum Planen zeigt die Zeiten in der eingerichteten Cloud-Zeitzone.

## Ein Entwurf ist schreibgeschützt oder wurde anderswo geändert {icon="pencil"}

Ein gemeinsamer Entwurf erlaubt eine aktive Bearbeitungssitzung. Sind die Angaben verfügbar, unterscheidet der Dialog zur Zusammenarbeit deinen eigenen anderen Tab von einer anderen Person.

- Wähle **Schreibgeschützt öffnen**, um weiterzuarbeiten, ohne die andere Person zu unterbrechen.
- Wähle **In diesem Tab bearbeiten** oder **Bearbeitung übernehmen** nur, wenn die andere Sitzung schreibgeschützt werden soll.
- Bei einer Verbindungswarnung versuche es erneut, sobald die Verbindung wieder funktioniert. Mail behandelt sie nicht als andere bearbeitende Person und öffnet keinen Dialog zur Übernahme.
- Meldet Mail Wiederherstellungskopien, prüfe sie, bevor du Inhalte verwirfst oder überschreibst.
- Lädt der Browser nach ungespeicherter Eingabe neu, nimm die wiederhergestellte Browserfassung an, wenn sie deiner Arbeit entspricht.

Eine weitere Antwort zu beginnen, blendet vorhandene Arbeit nicht aus. Der Dialog **Entwurf fortsetzen?** zeigt Person, Änderungszeit und eine Inhaltsvorschau. Du setzt den richtigen Entwurf fort oder erstellst bewusst einen weiteren.

## Eine gesendete Nachricht fehlt in Gesendet {icon="send"}

Mail legt eine gesendete Nachricht im Ordner Gesendet der Absenderidentität ab, sobald es die Kopie dort findet. Die Ablage in All Mail bei Gmail folgt mit der nächsten Synchronisierung dieses Ordners.

- Zeigt die Nachricht **Gesendet, aber nicht gespeichert**, konnte Mail die Kopie weder ablegen noch finden. Prüfe die Zuordnung des Ordners Gesendet der Absenderidentität und den Zugriff auf diesen Ordner beim Anbieter. Sende die Nachricht nicht erneut.
- Eine Unterhaltung kann neben der gesendeten Nachricht eine zusätzliche Kopie eines Entwurfs zeigen. Eine frühere Version hat die Entwurfskopie von Gmail aus All Mail importiert. Mit Zugriff **Verwalten** entfernst du solche Kopien mit **Unterhaltungsansicht reparieren**.

Um einen Ordner im Terminal zu prüfen, akzeptiert `cld mail ls "Mailbox:Sent Mail"` auch den letzten Namen eines Ordners oder seine Rolle, etwa `sent`. Das hilft, wenn der Anbieter den Ordner verschachtelt, zum Beispiel unter `[Gmail]`.

## Die Suche liefert kein erwartetes Ergebnis {icon="search"}

:::steps
1. Leere die aktuelle Suche. Prüfe, ob die Unterhaltung in einem ungefilterten Ordner oder einer ungefilterten Arbeitsansicht erscheint.
2. Öffne **Suchfilter**. Prüfe, ob **Mindestens eine Bedingung** oder **Alle Bedingungen** zu deinem Ziel passt.
3. Entferne veraltete Felder wie Ordner, Lokaler Tag oder Anbieter-Schlüsselwort.
4. Wird der Nachrichteninhalt noch synchronisiert, versuche es nach dem Laden erneut.
5. Stehen die gesuchten Wörter in einem neu empfangenen Anhang, warte, bis die Texterkennung im Hintergrund fertig ist. Versuche es dann erneut.
6. **Bester Treffer** ordnet die neuesten 1.000 passenden Nachrichten eines Postfachs. Ergänze bei einem sehr häufigen Wort ein genaueres Wort.
7. Um ältere Nachrichten zu erreichen, kannst du auch **Neueste zuerst** wählen.
8. Schlägt die allgemeine Suche im ganzen Postfach fehl, bitte jemanden mit Zugriff **Verwalten**, den Suchstatus zu prüfen. Er steht unter **Postfachwerkzeuge → Postfachstatus**.
:::

Lokale Tags und interne Kommentare gibt es nur in Cloud. Anbieterordner und Schlüsselwörter hängen vom synchronisierten Zustand beim Anbieter ab.

Die Texterkennung in Anhängen blockiert nie das Empfangen, Lesen oder Senden einer Nachricht. Mail wiederholt unterbrochene Erkennungsarbeit automatisch. Es holt auch regelmäßig Anhänge nach, die gespeichert wurden, bevor ein Worker sie verarbeiten konnte. Verschlüsselte, gescannte, nicht unterstützte, fehlerhafte oder zu große Anhänge sind endgültige Ergebnisse: Die ursprüngliche Datei bleibt verfügbar, aber ihr Inhalt ist nicht durchsuchbar.

**Postfachwerkzeuge → Postfachstatus** zeigt **Abdeckung von Reparatur und Projektion**. Zeigt sie eine Lücke, kann jemand mit Zugriff **Verwalten** **Fehlende Nachrichteninhalte laden**, **Suche neu aufbauen** oder **Unterhaltungsansicht reparieren** einreihen. Warte, bis der dauerhafte Befehl fertig ist, bevor du ihn wiederholst. Reparaturen von Suche und Unterhaltungen bauen abgeleitete Daten neu auf und behalten Inhalte des Postfachs und den Zustand der Zusammenarbeit.

## Ein Befehl braucht Aufmerksamkeit {icon="lifebuoy"}

Öffne **Postfachwerkzeuge → Postfachstatus → Erweiterte Diagnose und Reparatur**. Suche den geschwärzten Befehlseintrag über seine ID und seinen Fehlercode.

- **Anbietervorgang abgleichen** ist bei einem unklaren Ergebnis beim Anbieter sicher, weil es den Zustand beim Anbieter liest, bevor es das Ergebnis des Befehls ändert.
- **Vorgang erneut versuchen** erscheint nur bei fehlgeschlagener Wartung, die beim Anbieter liest und bei der beim Anbieter keine Wirkung begonnen hat.
- **Vorgang abbrechen** erscheint nur, solange passende Wartung eingereiht oder fehlgeschlagen ist.

Ein Verschieben, Löschen, Ändern einer Fahne oder ein Ordnervorgang, der den Mailserver vor dem Start nicht erreicht hat, braucht keine Aufmerksamkeit. Mail versucht ihn über einige Minuten mehrmals erneut. Bleibt der Server unerreichbar, schlägt die Aktion fehl, ohne auf dem Server etwas zu ändern, und du kannst sie später wiederholen.

:::warning Wiederhole keine Aktion mit unklarem Ergebnis
Meldet Mail ein unklares Ergebnis, wiederhole kein Verschieben, Löschen, Ändern einer Fahne, keinen Ordnervorgang und keinen Versand. Kann der Abgleich das Ergebnis beim Anbieter nicht nachweisen, bleibt der Befehl bei **Prüfung erforderlich**, bis jemand den Anbieter von Hand prüft.
:::

## Eine Ordneraktion beim Anbieter schlägt fehl {icon="lifebuoy"}

Erstellen, Umbenennen, Löschen und Abonnieren von Ordnern hängen vom aktuellen Zustand beim Anbieter ab. Das gilt auch für die Zuordnungen für Archiv, Papierkorb, Spam, Gesendet und Entwürfe. Mit Zugriff **Verwalten**:

:::steps
1. Führe **Ordner neu ermitteln** in **Postfachwerkzeuge → Postfachstatus** aus.
2. Prüfe, ob der Ordner aktiv ist und der Anbieter den nötigen Vorgang erlaubt.
3. Aktualisiere bei Bedarf die passende Zuordnung oder das Abonnement.
4. Versuche die Aktion noch einmal.
:::

Mail lehnt das Verschieben oder Löschen von Nachrichten bei einem Anbieter ab, der weder die Erweiterung MOVE noch UIDPLUS anbietet, weil Mail das Ergebnis beim Anbieter nicht nachweisen könnte. Der Befehl schlägt sofort fehl und hinterlässt keine Kopie. Die Synchronisierung von Entwürfen zum Anbieter braucht UIDPLUS und das Recht zum Löschen im Ordner Entwürfe. Sonst bleiben Entwürfe in Cloud, und **Postfachstatus** meldet das einmal.

Geteilte Ordner und Ordner anderer Nutzer können lesbar sein, während Erstellen, Umbenennen oder Löschen von Ordnern nicht verfügbar ist. Cloud gibt diesen Zugriff beim Anbieter nicht und bearbeitet ihn nicht. Wählst du eine eingereihte Aktion immer wieder, kann das Ergebnis schwerer verständlich werden. Warte auf die Live-Aktualisierung oder prüfe den Anbieter, bevor du es erneut versuchst.

## Das Postfach wurde wiederhergestellt, synchronisiert aber nicht {icon="point"}

Das ist so vorgesehen. Eine Wiederherstellung lässt das Postfach bewusst pausiert. Jemand mit Zugriff **Verwalten** kann dann Zugangsdaten, Verbindungsstatus und Ordnerermittlung prüfen, bevor die Hintergrundarbeit weiterläuft. Schließe diese Prüfungen unter **Postfachwerkzeuge → Postfachstatus** ab und wähle dann **Postfach fortsetzen**.
