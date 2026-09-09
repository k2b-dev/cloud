---
id: kit-sharing
title: Teilen und lokale Daten
icon: ti ti-code
description: Teilen und lokale Daten in Kit
order: 103
---

Öffne als App-Administrator **Einstellungen → Teilen**. Lesen zeigt Metadaten;
Benutzen erlaubt Ausführen und Lesen des Codes; Admin erlaubt Bearbeiten, Teilen
und Löschen. Mindestens ein Administrator muss bleiben. Benutzer können den
ausgelieferten Quelltext einsehen: Hinterlege darin keine Geheimnisse.

Eine Freigabe teilt Code, nicht deine lokalen Dateien. Werkzeuge einer App teilen
Dateien und KV auf demselben Benutzer und Gerät. Andere Benutzer, Geräte und
Browserprofile haben getrennte Daten. Lokale Daten sind kein Cloud-Backup.

Alle Benutzer mit Benutzen-Recht können unter **Einstellungen → Lokale Daten**
Dateien und gespeicherte Werte ansehen und herunterladen. **Lokale Daten löschen**
in der Seitenleiste fragt nach, beendet den Durchlauf und löscht nur die lokalen
Daten dieser App und dieses Benutzers. Schließe vorher andere Tabs derselben App.
Quelltext und Freigaben bleiben erhalten. Auch das Löschen von Browserdaten
entfernt lokale Ergebnisse.

Die CLI kann persistenceEnabled im Manifest verwalten. Bei Deaktivierung schlagen
Script-Lese- und Schreibzugriffe fehl; vorhandene Daten bleiben erhalten und im
lokalen Explorer sichtbar. Es gibt keinen temporären Ersatzspeicher. Kit bietet
in den Einstellungen keinen Schalter dafür. Das Löschen der Cloud-App entfernt
Quelltext und Freigaben, nicht Browserspeicher auf anderen Geräten.
