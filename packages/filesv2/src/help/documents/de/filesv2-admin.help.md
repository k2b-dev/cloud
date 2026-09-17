---
id: filesv2-admin
title: Ablagen konfigurieren und prüfen
icon: ti ti-settings
description: Filegate verbinden, Dateibereiche konfigurieren und Verzeichniszuordnungen prüfen.
order: 200
---

Administratoren konfigurieren Files v2 unter **Dateiverwaltung**.

## Ablagen verbinden

Trage die **Backend-URL** und den **Backend-Token** von Filegate ein. Die Anwendung muss diese Adresse erreichen können. Die öffentlichen Adressen für direkte Browser-Downloads liefert Filegate. Ein vorhandener Token wird nie angezeigt; lasse das Feld leer, um ihn beizubehalten.

Cloud und FreeIPA werden unabhängig konfiguriert. Jeder Bereich hat einen Filegate-Root und einen optionalen relativen Basispfad. Nutzer-, Gruppen- und Archivverzeichnisse liegen relativ zu diesem Basispfad. Wähle getrennte Verzeichnispfade, damit sich Bereiche und reservierte Verzeichnisse nicht überschneiden.

Cloud-Dateien setzen lokale Linux-Identitäten voraus. Für FreeIPA-Dateien muss FreeIPA aktiviert sein. Speichere die Konfiguration, bevor du den Bestand des ausgewählten Bereichs prüfst.

Index und Versionshistorie werden in Filegate konfiguriert. Files v2 bietet dafür keine zusätzlichen Schalter. Die Root-Statistiken gelten für den gesamten Root, auch wenn der Bereich einen Basispfad verwendet. Unbekannte Anzahlen und Größen werden als unbekannt angezeigt.

## Dateisystembestand prüfen

Wähle **Cloud** oder **FreeIPA** und danach **Nutzer** oder **Gruppen**. **Aktualisieren** prüft den aktuellen Dateisystembestand, einschließlich manuell auf dem Server angelegter Verzeichnisse.

- **Vorhanden:** Das Verzeichnis ist für sein ermitteltes Konto verfügbar.
- **Fehlt:** Das erwartete Verzeichnis ist nicht vorhanden.
- **Nicht zugeordnet:** Ein Verzeichnis ist keinem geeigneten Konto zugeordnet.
- **Konflikt:** Das bestehende Verzeichnis oder die Zuordnung muss geprüft werden.
- **Unbekannt:** Die Anwendung konnte den aktuellen Zustand nicht ermitteln.

Ein unbekannter Zustand belegt keine Löschung eines Kontos oder Verzeichnisses. Prüfe zuerst die Verfügbarkeit der Identitätsdaten und die Verbindung zum Dateiserver.

Wenn **Verzeichnis zuordnen** verfügbar ist, prüfe Konto und Pfad vor der Bestätigung. Die bestehenden Dateien bleiben an ihrem Ort. Ein Verzeichnis ohne passende geeignete Identität kann mit dieser Aktion nicht zugeordnet werden.

## Über das Terminal verwalten

`cld filesv2 admin inventory --area freeipa --kind groups --json` liest denselben Bestand und die Root-Statistiken. Wähle `cloud` oder `freeipa` als Bereich und `users` oder `groups` als Art. Übergib einen zurückgegebenen `next`-Cursor als `--after`, um weiterzulesen.

`cld filesv2 admin configuration get --json` liest die Konfiguration. Übermittle die vollständige bearbeitete Konfiguration mit `cld filesv2 admin configuration set --input-file ./filesv2.json` oder `--stdin`. Ein fehlender oder leerer `token` behält das gespeicherte Secret bei. Die Leseantwort enthält dieses Secret nie.

Nach Prüfung des Bestandseintrags ordnet `cld filesv2 admin adopt <identity-uuid> --area cloud --kind users --yes` dessen vorhandenes Verzeichnis zu. Diese Befehle benötigen dieselben Adminrechte wie die Oberfläche. Sie erstellen, archivieren oder löschen keine Verzeichnisse.
