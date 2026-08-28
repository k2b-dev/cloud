---
id: mail-troubleshooting
title: Mail-Probleme beheben
icon: ti ti-lifebuoy
description: Fehlende E-Mails, pausierten Transport, Versandfehler, Entwurfskonflikte und Suchlücken prüfen.
order: 80
---

Beginne mit dem sichtbaren Problem. Öffne anschließend **Postfachwerkzeuge > Postfachstatus**, wenn Transport, Ordner oder Suche betroffen sein könnten.

## Das Postfach fehlt in der Übersicht {icon="lifebuoy"}

:::steps
1. Leere das Feld **Postfächer suchen**.
2. Prüfe, ob dir eine Person mit Postfach-Adminrechten Zugriff gegeben hat.
3. Wurde das Postfach gelöscht, kann es eine Person mit Adminrechten unter **Kürzlich gelöscht** wiederherstellen.
:::

Mail prüft den Zugriff beim Laden der Seite und bei Live-Aktualisierungen. Wurde dein Zugriff entzogen, verweigern neu geladene Seiten und Live-Ansichten den Zugriff, statt veraltete Postfachdaten weiter bereitzustellen.

## Neue E-Mails oder ältere Verläufe fehlen {icon="lifebuoy"}

:::steps
1. Prüfe den Statushinweis über der Unterhaltungsliste.
2. Öffne **Postfachwerkzeuge > Postfachstatus**.
3. Ist das Postfach pausiert, wähle **Postfach fortsetzen**.
4. Wähle **Jetzt synchronisieren**.
5. Fehlen Ordner oder haben sie sich geändert, wähle für die aktive Verbindung **Neu erkennen**.
:::

Die erste Synchronisierung lädt ältere Nachrichten nach und nach. Eine Nachricht kann erscheinen, bevor ihr vollständiger Inhalt oder die Daten ihrer Anhänge synchronisiert sind. Der Lesebereich zeigt **Inhalt wird noch synchronisiert**, bis der Vorgang abgeschlossen ist.

Prüfe bei geteilten Anbieterordnern zuerst, ob das verbundene IMAP-Konto weiterhin das erforderliche Abonnement und die nötigen Berechtigungen besitzt. Mail kann nur Ordner neu erkennen, die der Anbieter für dieses Konto bereitstellt.

## Ein Ordner fehlt in der Seitenleiste {icon="folder"}

Personen mit Postfach-Adminrechten sollten **Einstellungen > Ordner** öffnen und zwischen folgenden Fällen unterscheiden:

- **Seitenleiste ist deaktiviert:** Aktiviere sie, um den Ordner wieder in der Cloud-Navigation anzuzeigen. Beim Anbieter ändert sich dadurch nichts.
- **Nicht abonniert:** Abonniere den Ordner, wenn dieser Anbieter oder ein anderes E-Mail-Programm die sichtbare Ordnerliste über IMAP-Abonnements steuert.
- **Nicht verfügbar:** Das verbundene Konto stellt den Ordner nicht mehr bereit. Prüfe Konto, Namespace und Berechtigungen beim Anbieter und führe anschließend **Neu erkennen** aus.
- **Prüfung erforderlich:** Bei der Ordnererkennung wurden widersprüchliche Anbieterzustände gefunden. Prüfe **Status > Ordnererkennung**, bevor du E-Mails änderst.

Ein ausgeblendeter übergeordneter Ordner blendet auch seine Unterordner aus, damit die Hierarchie verständlich bleibt. Ihre E-Mails und individuellen Sichtbarkeitseinstellungen bleiben erhalten.

## Beim Senden erscheint „Postfachtransport ist pausiert“ {icon="send"}

Eine Person mit Adminrechten hat das Postfach pausiert oder es wurde im vorgeschriebenen pausierten Zustand wiederhergestellt. Öffne **Postfachwerkzeuge > Postfachstatus**, prüfe Verbindung und Status beim Anbieter und wähle anschließend **Postfach fortsetzen**.

Während der Pause laufen weder die Synchronisierung eingehender E-Mails noch vorgemerkte Anbieteränderungen, geplante Zustellungen oder automatische Antworten.

## Eine E-Mail kann nicht gesendet werden {icon="point"}

Prüfe folgende Bedingungen:

- Du hast Schreib- oder Adminrechte.
- Unter **Von** ist ein bestätigter Absender ausgewählt.
- **Postfachwerkzeuge > Postfachstatus** zeigt eine nutzbare Verbindung.
- Der Entwurf enthält Empfänger und entweder einen Nachrichtentext oder einen Anhang.
- Alle Anhänge wurden vollständig hochgeladen und keine Datei ist größer als 100 MiB.
- Du hast alle Versandwarnungen für die aktuelle gespeicherte Fassung geprüft. Wenn du Empfänger, Links, Text oder Anhänge nach der Freigabe änderst, ist eine neue Prüfung erforderlich.
- Die vollständig kodierte Nachricht bleibt innerhalb der aktuellen vom Anbieter veröffentlichten Versandgrenze.
- Die Zugangsdaten des Anbieters sind weder abgelaufen noch widerrufen.

Ein Anhang kann innerhalb der Mail-Grenze von 100 MiB pro Datei liegen, während die vollständig kodierte Nachricht eine niedrigere Anbietergrenze überschreitet. Entferne einen oder mehrere Anhänge oder erstelle einen öffentlichen Download-Link und sende stattdessen diesen Link. Personen mit Postfach-Adminrechten können die ermittelten Werte unter **Postfachwerkzeuge > Postfachstatus > Anbietergrenzen** prüfen und aktualisieren.

Haben sich die Zugangsdaten des Anbieters geändert, verwende **Einstellungen > Konten und Identitäten > Verbundenes Konto > Ersetzen**. Das vorhandene Geheimnis kann weder angezeigt noch teilweise bearbeitet werden.

## Automatische Antworten melden, dass keine Identität verfügbar ist {icon="send"}

Öffne **Einstellungen > Konten und Identitäten > Absenderidentitäten** und prüfe für eine Identität beide Bedingungen:

:::steps
1. Der Status der Identität ist **bestätigt**.
2. **Automatische Antworten** ist aktiviert.
:::

Kehre anschließend zu **Automatisierungen > Automatische Antworten** zurück. Bestehende automatische Antworten bleiben sichtbar, wenn keine passende Identität verfügbar ist. Zum Erstellen oder erneuten Aktivieren ist jedoch eine passende Identität erforderlich.

## Eine geplante E-Mail wurde nicht gesendet {icon="send"}

Öffne **Geplant** und prüfe den Eintrag:

- Eine Wiederholungskennzeichnung bedeutet, dass die Zustellung fehlgeschlagen ist und Mail den Eintrag für einen weiteren Versuch aufbewahrt.
- Bei einem pausierten Postfach wird der Versandversuch nicht ausgeführt.
- Mit **Abbrechen** kannst du den Eintrag vor Beginn der Zustellung in einen gemeinsamen Entwurf zurückführen oder verwerfen.

Der geplante Zeitpunkt muss mindestens eine Minute in der Zukunft liegen. Zeiten werden in der konfigurierten Cloud-Zeitzone angezeigt, die im Planungsdialog genannt ist.

## Ein Entwurf ist schreibgeschützt oder wurde an anderer Stelle geändert {icon="pencil"}

Ein gemeinsamer Entwurf erlaubt eine aktive Bearbeitungssitzung. Der Zusammenarbeitsdialog unterscheidet, sofern die nötigen Angaben verfügbar sind, zwischen einem anderen eigenen Tab und einer identifizierbaren anderen Person.

- Wähle **Schreibgeschützt ansehen**, um fortzufahren, ohne die andere Bearbeitung zu unterbrechen.
- Wähle **In diesem Tab bearbeiten** oder **Übernehmen** nur, wenn die andere Bearbeitungssitzung schreibgeschützt werden soll.
- Versuche es bei einer Verbindungswarnung erneut, nachdem die Verbindung wiederhergestellt ist. Mail behandelt die Warnung weder als andere bearbeitende Person noch öffnet es den Übernahmedialog.
- Meldet Mail Wiederherstellungskopien, prüfe sie, bevor du Inhalte verwirfst oder überschreibst.
- Wird der Browser nach ungespeicherten Eingaben neu geladen, übernimm die wiederhergestellte Browserfassung, wenn sie deiner Arbeit entspricht.

Eine weitere Antwort blendet vorhandene Arbeit nicht aus. Der Dialog **Entwurf fortsetzen?** zeigt Verfasser, Änderungszeit und Inhaltsvorschau. So kannst du den richtigen Entwurf fortsetzen oder bewusst einen weiteren erstellen.

## Die Suche findet ein erwartetes Ergebnis nicht {icon="search"}

:::steps
1. Leere die aktuelle Suche und prüfe, ob die Unterhaltung in einem ungefilterten Ordner oder einer ungefilterten Arbeitsansicht erscheint.
2. Öffne **Suchfilter** und prüfe, ob **Eine Bedingung** oder **Alle Bedingungen** zu deinem Ziel passt.
3. Entferne veraltete Felder wie Ordner, lokaler Tag oder Anbieter-Schlüsselwort.
4. Wird der Nachrichtentext noch synchronisiert, versuche es nach Abschluss erneut.
5. Befinden sich die fehlenden Wörter in einem neuen Anhang, warte auf die Verarbeitung im Hintergrund und versuche es erneut.
6. Bitte eine Person mit Adminrechten, **Status > Suchindex** zu prüfen, wenn die allgemeine Suche im gesamten Postfach fehlschlägt.
:::

Lokale Tags und interne Kommentare gibt es nur in Cloud. Anbieterordner und Schlüsselwörter hängen vom synchronisierten entfernten Zustand ab.

Die Texterkennung für Anhänge blockiert niemals Empfang, Lesen oder Versand einer Nachricht. Mail wiederholt unterbrochene Verarbeitungen automatisch und nimmt regelmäßig Anhänge wieder auf, die gespeichert wurden, bevor sie einer Verarbeitung zugeordnet werden konnten. Verschlüsselte, gescannte, nicht unterstützte, fehlerhafte oder zu große Anhänge sind endgültige Ergebnisse: Die ursprüngliche Datei bleibt verfügbar, ihr Inhalt ist aber nicht durchsuchbar.

Zeigt **Status > Reparatur- und Projektionsabdeckung** eine Lücke, kann eine Person mit Adminrechten **Fehlende Inhalte laden**, **Suche neu aufbauen** oder **Unterhaltungsprojektion reparieren** einplanen. Warte, bis der dauerhafte Befehl abgeschlossen ist, bevor du ihn wiederholst. Reparaturen von Suche und Unterhaltungen bauen abgeleitete Daten neu auf und erhalten Postfachinhalte sowie Zusammenarbeitsdaten.

## Ein Befehl benötigt Aufmerksamkeit {icon="lifebuoy"}

Öffne **Postfachwerkzeuge > Postfachstatus > Erweiterte Diagnose und Reparaturen** und suche den bereinigten Befehlseintrag anhand von ID und Fehlercode.

- **Wirkung abgleichen** ist bei einem unklaren Anbieterergebnis sicher, weil die Aktion den Anbieterzustand liest, bevor das Befehlsergebnis geändert wird.
- **Arbeit wiederholen** erscheint nur bei fehlgeschlagenen Wartungslesevorgängen beim Anbieter, wenn noch keine Anbieterwirkung begonnen hat.
- **Arbeit abbrechen** erscheint nur, solange geeignete Wartungsarbeit vorgemerkt ist oder fehlgeschlagen ist.

Wiederhole weder Verschieben, Löschen, eine Markierungsänderung, einen Ordnervorgang noch den Versand, wenn Mail ein unklares Ergebnis meldet. Kann der Abgleich das entfernte Ergebnis nicht nachweisen, bleibt der Befehl im Zustand **Aufmerksamkeit erforderlich**, bis der Anbieter manuell geprüft wurde.

## Eine Ordneraktion beim Anbieter schlägt fehl {icon="lifebuoy"}

Erstellung, Umbenennung, Löschung und Abonnement von Ordnern sowie die Zuordnungen für Archiv, Papierkorb, Junk, Gesendet und Entwürfe hängen vom aktuellen Anbieterzustand ab. Eine Person mit Adminrechten sollte:

:::steps
1. unter **Postfachwerkzeuge > Postfachstatus** die Aktion **Neu erkennen** ausführen,
2. prüfen, ob der Ordner aktiv ist und der Anbieter den erforderlichen Vorgang erlaubt,
3. bei Bedarf die zugehörige Zuordnung oder das Abonnement aktualisieren und
4. den Vorgang einmal wiederholen.
:::

Geteilte Ordner und Ordner anderer Personen können lesbar sein, obwohl Erstellung, Umbenennung oder Löschung von Ordnern nicht verfügbar sind. Cloud vergibt oder ändert diese vorgelagerten Rechte nicht. Wiederholte Klicks auf eine vorgemerkte Aktion können die Auswertung erschweren. Warte auf die Live-Aktualisierung oder prüfe den Anbieter, bevor du es erneut versuchst.

## Das Postfach wurde wiederhergestellt, synchronisiert aber weiterhin nicht {icon="point"}

Das ist beabsichtigt. Nach einer Wiederherstellung bleibt das Postfach pausiert, damit eine Person mit Adminrechten Zugangsdaten, Verbindungsstatus und Ordnererkennung prüfen kann, bevor die Hintergrundarbeit fortgesetzt wird. Schließe diese Prüfungen unter **Postfachwerkzeuge > Postfachstatus** ab und wähle anschließend **Postfach fortsetzen**.
