---
id: filesv2-admin
title: Ablagen und Verzeichnisse verwalten
icon: ti ti-settings
description: Filegate verbinden, Verzeichnisse prüfen und Archiv sowie Lebenszyklus verwalten.
order: 200
---

Öffne **Dateiverwaltung**, um Files v2 zu verwalten. Die Ansichten trennen Speicherinformationen, aktuelle Verzeichnisse, archivierte Verzeichnisse, öffentliche Freigaben und Einstellungen. Filter, Ordner und Seiten bleiben in der Adresse erhalten, auch beim Vor- und Zurücknavigieren.

## Ablagen unter Einstellungen verbinden {icon="plug"}

Trage die **Backend-URL** und den **Backend-Token** von Filegate ein. Die Anwendung muss diese Adresse erreichen können. Öffentliche Adressen für direkte Browser-Downloads liefert Filegate 6. Sein öffentlicher Host muss außerhalb des Gültigkeitsbereichs der Cloud-Cookies liegen; ein anderer Port auf demselben Host genügt nicht. Konfiguriere den exakten Cloud-Origin für CORS. Eigene Übertragungen führt Cloud über die Backend-Adresse aus. Ein vorhandener Token wird nie angezeigt; lasse sein Feld leer, um ihn beizubehalten. **Konfiguration speichern** übernimmt deine Änderungen, **Verwerfen** stellt die gespeicherten Werte wieder her. Beim Verlassen mit ungespeicherten Änderungen erscheint eine Rückfrage.

Aktiviere Cloud und FreeIPA unabhängig und wähle ihre Filegate-Roots. **Erweiterte Pfade** enthält den optionalen Basispfad und die dazu relativen Nutzer-, Gruppen- und Archivpfade. Halte diese Pfade getrennt, damit sich Bereiche und reservierte Verzeichnisse nicht überschneiden.

Cloud-Ablagen setzen aktivierte lokale Linux-Identitäten voraus. Nur berechtigte Nutzerkonten und POSIX-Gruppen haben Verzeichnisse. **Lokale Verzeichnisse automatisch erstellen** ist zunächst ausgeschaltet. Die automatische Archivierung ist standardmäßig eingeschaltet und separat deaktivierbar. Sie archiviert verwaltete Verzeichnisse gelöschter lokaler Konten oder Gruppen sowie von Gruppen mit deaktiviertem POSIX. Die Dateien bleiben wiederherstellbar. Ein unbekannter Identitätszustand gilt nie als Löschung. FreeIPA hat keine automatische Erstellung oder Archivierung: Wähle die Verzeichnisaktionen ausdrücklich aus.

**Collabora Online** bindet einen Editor für Textdokumente, Tabellen und Präsentationen an. Trage die **Collabora-Adresse** ein, von der Browser den Editor laden; bleibt sie leer, ist die Bearbeitung deaktiviert. Wähle das **Format neuer Dokumente**: OpenDocument oder Microsoft Office. **Erweitert** enthält zwei optionale Adressen für Umgebungen, in denen diese Anwendung Collabora oder Collabora diese Cloud über andere Adressen erreicht als Browser. Collabora muss die Adresse dieser Cloud erreichen können und diese Anwendung Collabora.

## Übersicht lesen {icon="layout-dashboard"}

Die Übersicht zeigt Kapazität, verfügbaren Speicher, aktive Uploads, Anzahlen und Größen für den ausgewählten Root. Unbekannte Werte bleiben unbekannt. Anzahlen und Größen setzen einen vollständigen beobachteten Scan voraus; unvollständige Summen oder Summen unbekannter Aktualität gelten nicht als aktuelle Anzahlen. Die Beobachtungsdaten beschreiben Quelle und Zeitraum, keine atomare Quote. Statistiken gelten für den gesamten Root, auch für Pfade außerhalb des Basispfads eines Bereichs.

Index, Versionshistorie, Managed-Modus und Unix-Ausführung werden in Filegate konfiguriert. FreeIPA benötigt aktivierte Unix-Ausführung und einen ausdrücklich dafür konfigurierten Daemon, der Unix-Identitäten wechseln kann. Fehlt das, verweigert Filesv2 den Zugriff, statt das Servicekonto zu verwenden. Managed gilt nur für Roots, deren sämtliche Schreibzugriffe über Filegate laufen; bei direkten externen Schreibern bleibt es aus. Es ermöglicht atomare Prüfungen zwischen Filegate-Aktionen, schützt aber nicht vor gleichzeitigen externen NFS-Schreibzugriffen. Der Editor bleibt auf nicht verwalteten Roots mit nicht atomarer Konflikterkennung nutzbar. **Aktualisieren** fordert eine neue Zusammenfassung an. **Index neu aufbauen** verlangt eine Bestätigung, weil die Aktion den gesamten Root betrifft.

## Verzeichnisse prüfen {icon="folders"}

Wähle Bereich und **Nutzer** oder **Gruppen**. Suche nach Namen oder filtere nach Zustand. **Aktualisieren** liest den aktuellen Dateisystembestand einschließlich manuell auf dem Server angelegter Verzeichnisse. FreeIPA-Verzeichnisse werden auch bei aktivem Index direkt im Dateisystem gelesen. Mit Filegate 6.1 liest auch die FreeIPA-Dateinamensuche den aktuellen Dateisystembestand unter der Unix-Identität des Nutzers, unabhängig vom Index. Unlesbare Teilbäume brechen die Suche ab. **Nächste Seite** setzt die Bestandsanzeige fort.

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

## Archiv wiederherstellen oder entfernen {icon="archive"}

Das Archiv zeigt ursprüngliche Pfade und Archivierungszeitpunkte. Öffne ein archiviertes Verzeichnis, um seinen Inhalt zu prüfen. **Wiederherstellen** verschiebt es nach Bestätigung an den ursprünglichen Ort; das Ziel muss frei sein. Endgültiges Löschen eines Archivs oder einer einzelnen Datei erfordert den exakten Pfad. Diese Löschaktionen gibt es ausschließlich in der Administratoroberfläche und der Administrator-CLI.

## Freigaben und Upload-Eingänge verwalten {icon="share"}

**Freigaben** zeigt alle öffentlichen Links; normale Nutzer sehen nur ihre eigenen. Als Administrator kannst du einen Link unabhängig vom verbliebenen Zugriff seines Erstellers sperren. Links werden nur beim Erstellen ausgegeben. Bereits bestehende URLs bleiben nach der Umstellung der Token-Speicherung gültig, lassen sich aber auch von der Administration nicht mehr aus der Übersicht zurückholen. Interne Notizen bleiben privat; nur der separate öffentliche Hinweis erscheint für Besucher.

Für Eingänge gelten standardmäßig 100 MiB pro Datei und 1 GiB kumulativ insgesamt, auch für Links, die schon vor diesem Upgrade existierten. Bestätigte Uploads und offene Reservierungen zählen gemeinsam. Das Löschen empfangener Dateien gibt das Budget nicht frei. Der Abgleich läuft auch nach Ablauf oder Sperrung des Links weiter. Bei ungeklärten Übertragungen bleibt die Reservierung bestehen, bis ein verlässliches Ergebnis vorliegt. Prüfe den angezeigten Pfad, Fehler und die Sitzung. Ein fehlender Beleg bedeutet nicht, dass keine Datei geschrieben wurde.

## Papierkorb und Versionen prüfen {icon="history"}

Papierkorb- und Wiederherstellungsaktionen halten ihren Fortschritt vor dem Verschieben fest. Ein uneindeutiges Ergebnis bleibt offen und wird nicht als abgeschlossen ausgegeben. Direkt im `trash` gefundene Einträge können einen unbekannten ursprünglichen Pfad oder Löschzeitpunkt haben; zum Wiederherstellen muss dann ein Ziel angegeben werden. Vorhandene Ziele werden niemals ersetzt. Mehrfachaktionen können teilweise gelingen; prüfe die Einzelergebnisse und wiederhole nur fehlgeschlagene Teile.

Historische Versionen lassen sich nur über die Versionsaktion im administrativen Dateibrowser oder `admin versions delete` endgültig löschen. Prüfe und bestätige zuerst den exakten Dateipfad und die Version. Normale Nutzer können Versionen herunterladen, kommentieren und wiederherstellen, aber nicht endgültig löschen.

## Terminal verwenden {icon="terminal"}

`cld filesv2 admin inventory --area freeipa --kind groups --json` liest denselben Bestand. Übergib einen zurückgegebenen `next`-Cursor als `--after`. `cld filesv2 admin configuration get --json` liest die Konfiguration. Übermittle eine vollständige bearbeitete Konfiguration mit `cld filesv2 admin configuration set --input-file ./filesv2.json` oder `--stdin`. Ein fehlender oder leerer `token` behält das Secret bei.

`cld filesv2 admin shares list --json` zeigt alle Links; `admin shares revoke <share-id>` sperrt einen davon. `cld filesv2 admin uploads list --json` zeigt ungeklärte Eingangsreservierungen. Mit `--after` erreichst du weitere Seiten dieser Listen.

`cld filesv2 help` zeigt die Verzeichnis-, Archiv- und Inspektionsbefehle. CLI-Aktionen benötigen dieselben Adminrechte und Bestätigungen wie ihre Entsprechungen in der Oberfläche.

## Vorlagen verwalten {icon="template"}

Der Tab **Vorlagen** verwaltet wiederverwendbare Dateien unabhängig von Ablagen. Lade eine Datei hoch oder wähle eine vorhandene Datei, die du lesen darfst. Jede Vorlage ist eine eigenständige Kopie bis 20 MiB. Vergib einen Namen, optional eine Beschreibung und das Recht **Verwenden** an Nutzer, Gruppen oder alle Angemeldeten. Ohne Zugriffsregel erscheint sie nur in der Administration. Das sind Cloud-Rechte; eine POSIX-Gruppe oder Zugriff auf den ursprünglichen Ordner ist dafür nicht nötig.

Nutzer wählen **Hinzufügen → Vorlage** in einem beschreibbaren Ordner. Das Vorlagenrecht ersetzt niemals das Schreibrecht im Ziel. Das Ersetzen des Vorlageninhalts oder das Löschen einer Vorlage verändert keine bereits daraus erzeugten Dateien. Auch die importierte Originaldatei kann unabhängig geändert oder entfernt werden. Vorlageninhalte und Rechte liegen in PostgreSQL und müssen in Datenbank-Backups enthalten sein.

Die CLI bietet `admin templates list|upload|import|update|replace|delete` sowie `admin templates access list|grant|revoke`. Löschen erfordert `--yes`. Argumente stehen unter `--help`; die JSON-Regel für eine Berechtigung wird über `--input-file` oder `--stdin` übergeben.
