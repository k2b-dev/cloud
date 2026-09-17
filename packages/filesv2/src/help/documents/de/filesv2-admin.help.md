---
id: filesv2-admin
title: Ablagen und Verzeichnisse verwalten
icon: ti ti-settings
description: Filegate verbinden, Verzeichnisse prüfen und Archiv sowie Lebenszyklus verwalten.
order: 200
---

Öffne **Dateiverwaltung**, um Files v2 zu verwalten. Die vier Ansichten trennen Speicherinformationen, aktuelle Verzeichnisse, archivierte Verzeichnisse und Einstellungen. Filter, Ordner und Seiten bleiben in der Adresse erhalten, auch beim Vor- und Zurücknavigieren.

## Ablagen unter Einstellungen verbinden

Trage die **Backend-URL** und den **Backend-Token** von Filegate ein. Die Anwendung muss diese Adresse erreichen können. Öffentliche Adressen für direkte Browser-Downloads liefert Filegate. Ein vorhandener Token wird nie angezeigt; lasse sein Feld leer, um ihn beizubehalten. **Konfiguration speichern** übernimmt deine Änderungen, **Verwerfen** stellt die gespeicherten Werte wieder her. Beim Verlassen mit ungespeicherten Änderungen erscheint eine Rückfrage.

Aktiviere Cloud und FreeIPA unabhängig und wähle ihre Filegate-Roots. **Erweiterte Pfade** enthält den optionalen Basispfad und die dazu relativen Nutzer-, Gruppen- und Archivpfade. Halte diese Pfade getrennt, damit sich Bereiche und reservierte Verzeichnisse nicht überschneiden.

Cloud-Ablagen setzen aktivierte lokale Linux-Identitäten voraus. Nur berechtigte Nutzerkonten und POSIX-Gruppen haben Verzeichnisse. **Lokale Verzeichnisse automatisch erstellen** ist zunächst ausgeschaltet. Die automatische Archivierung ist standardmäßig eingeschaltet und separat deaktivierbar. Sie archiviert verwaltete Verzeichnisse gelöschter lokaler Konten oder Gruppen sowie von Gruppen mit deaktiviertem POSIX. Die Dateien bleiben wiederherstellbar. Ein unbekannter Identitätszustand gilt nie als Löschung. FreeIPA hat keine automatische Erstellung oder Archivierung: Wähle die Verzeichnisaktionen ausdrücklich aus.

## Übersicht lesen

Die Übersicht zeigt Kapazität, verfügbaren Speicher, aktive Uploads, Anzahlen und Größen für den ausgewählten Root. Unbekannte Werte bleiben unbekannt. Statistiken gelten für den gesamten Root, auch für Pfade außerhalb des Basispfads eines Bereichs.

Index und Versionshistorie werden in Filegate konfiguriert. **Statistik aktualisieren** fordert eine neue Zusammenfassung an. **Index neu aufbauen** verlangt eine Bestätigung, weil die Aktion den gesamten Root betrifft.

## Verzeichnisse prüfen

Wähle Bereich und **Nutzer** oder **Gruppen**. Suche nach Namen oder filtere nach Zustand. **Aktualisieren** liest den aktuellen Dateisystembestand einschließlich manuell auf dem Server angelegter Verzeichnisse. **Nächste Seite** setzt die Bestandsanzeige fort.

- **Vorhanden:** Das Verzeichnis ist für sein ermitteltes Konto verfügbar.
- **Fehlt:** Das erwartete Verzeichnis ist nicht vorhanden.
- **Nicht zugeordnet:** Ein vorhandenes Verzeichnis hat keine bestätigte Zuordnung.
- **Verwaist:** Die Identität fehlt bestätigt oder ist nicht mehr berechtigt.
- **Stillgelegt:** Das Verzeichnis wurde ausdrücklich aus der aktiven Nutzung genommen.
- **Konflikt:** Pfad, Identität oder Unix-Eigentümer müssen geprüft werden.
- **Unbekannt:** Die Anwendung konnte den aktuellen Zustand nicht ermitteln.

Öffne einen Verzeichnisnamen, um Dateien und Ordner anzusehen. **Papierkorb** öffnet den obersten Ordner `trash` des Verzeichnisses. Dateien werden nach erneuter Zugriffsprüfung direkt von Filegate heruntergeladen. Ein nicht vorhandener Papierkorbordner wird als fehlend gemeldet.

Jede Zeile bietet nur aktuell verfügbare Aktionen:

- **Details** zeigt Pfad, Herkunft, Identitätsnummern und Zustand.
- **Verzeichnis erstellen** erstellt eine fehlende berechtigte Nutzer- oder Gruppenablage. FreeIPA verwendet dabei UID, GID und die erforderlichen Berechtigungen.
- **Verzeichnis zuordnen** verbindet ein passendes vorhandenes Verzeichnis, ohne Dateien zu verschieben.
- **Archivieren** verschiebt ein Verzeichnis aus der aktiven Nutzung. Gib einen Archivpfad relativ zum Basispfad des Bereichs an; der gespeicherte Archivpfad wird vorgeschlagen.
- **Verzeichnis stilllegen** beendet die aktive Nutzung und verhindert automatische Neuerstellung. Die Dateien bleiben an ihrem Ort.
- **Endgültig löschen** verlangt die Eingabe des exakt angezeigten Pfads. Diese Aktion kann nicht rückgängig gemacht werden.

**In Bearbeitung** bedeutet, dass der Abschluss noch nicht bestätigt ist. Aktualisiere den Bestand und nutze **Aktion erneut versuchen**, wenn angeboten. Dabei werden aktuelle Identität, Berechtigungen und Dateisystem erneut geprüft. Ein Konflikt muss vor einem weiteren Versuch untersucht werden.

## Archiv wiederherstellen oder entfernen

Das Archiv zeigt ursprüngliche Pfade und Archivierungszeitpunkte. Öffne ein archiviertes Verzeichnis, um seinen Inhalt zu prüfen. **Wiederherstellen** verschiebt es nach Bestätigung an den ursprünglichen Ort; das Ziel muss frei sein. Endgültiges Löschen eines Archivs oder einer einzelnen Datei erfordert den exakten Pfad. Diese Löschaktionen gibt es ausschließlich in der Administratoroberfläche.

## Terminal verwenden

`cld filesv2 admin inventory --area freeipa --kind groups --json` liest denselben Bestand. Übergib einen zurückgegebenen `next`-Cursor als `--after`. `cld filesv2 admin configuration get --json` liest die Konfiguration. Übermittle eine vollständige bearbeitete Konfiguration mit `cld filesv2 admin configuration set --input-file ./filesv2.json` oder `--stdin`. Ein fehlender oder leerer `token` behält das Secret bei.

`cld filesv2 help` zeigt die Verzeichnis-, Archiv- und Inspektionsbefehle. CLI-Aktionen benötigen dieselben Adminrechte und Bestätigungen wie ihre Entsprechungen in der Oberfläche.
