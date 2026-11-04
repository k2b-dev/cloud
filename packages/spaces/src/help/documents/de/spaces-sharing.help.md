---
id: spaces-sharing
title: Space teilen und Einstellungen ändern
icon: ti ti-lock
description: Gib Personen die passende Zugriffsstufe, ändere die Space-Einstellungen und teile Kalenderexporte sicher.
order: 130
---

Gib jeder Person und Gruppe nur den Zugriff, den sie in diesem Space braucht.

## Space-Einstellungen öffnen {icon="settings"}

:::steps
1. Öffne **…** im Kopfbereich.
2. Wähle **Space-Einstellungen**.
:::

Die Einstellungen öffnen sich in einem Dialog. Schließt du ihn, kehrst du zur aktuellen Ansicht zurück.

Die Kategorien ordnen die Einstellungen nach Zuständigkeit und Auswirkung:

- **Space** enthält den gemeinsamen Namen und die Angaben, Tags und Workflow-Status.
- **Persönlich** enthält deine Browser-Voreinstellungen. Sie gelten sofort und nur für dich.
- **Verbindungen** enthält das Kalender-Abonnement, die Wormholes und das GitHub-Token für Linkvorschauen. Wormholes und Token ändern nur Personen mit Zugriff **Verwalten**.
- **Freigabe** enthält Zugriff und API Keys. Sie ist für Personen mit Zugriff **Verwalten**.
- **Verwaltung** enthält das endgültige Löschen des Space.

Formulare mit einer Fußzeile zeigen die Anzahl der Änderungen. Prüfe diese Zahl und wähle **Änderungen speichern**. Aktionen in einer Liste, etwa einen Status hinzufügen oder einen Schlüssel widerrufen, speichern sofort nach deiner Bestätigung. Änderungen am Zugriff gelten, wenn du in **Zugriff bearbeiten** **Speichern** wählst.

## Zugriffsstufe wählen {icon="shield-lock"}

:::reference
- **Ansehen:** Den Space und seine Einträge sehen. Eigene Voreinstellungen ändern und das Kalender-Abonnement kopieren.
- **Bearbeiten:** Zusätzlich Einträge, Kommentare, Status, Datumsangaben und Zuständigkeiten erstellen und ändern. Angaben zum Space, Tags, Status, die automatischen Kanban-Spalten und die Spaltenreihenfolge ändern.
- **Verwalten:** Zusätzlich Wormholes, GitHub-Token, Zugriff, API Keys, den Kalenderexport und das Löschen ändern.
:::

## Einer Integration oder einem Agenten Zugriff geben {icon="key"}

Füge den Agenten unter **Freigabe → Zugriff** hinzu. Der Eintrag zeigt Name und Kontoart. Mit Zugriff **Verwalten** und dem Token-Scope `admin` kann das Konto Freigaben über die API verwalten. Ein Token mit dem Scope `read` kann keine Freigaben ändern.

Gib dem neuen Konto zuerst Zugriff **Verwalten**, bevor du deinen eigenen Zugriff herabsetzt oder entfernst. Ein Agent kann als einziges verwaltendes Konto verbleiben. Den letzten verwaltenden Eintrag kannst du nicht entfernen; füge vorher einen weiteren hinzu. Ressourcenbezogene API Keys zählen dafür nicht und bleiben auf ihren Space beschränkt.

## Code Zugriff auf diesen Space geben {icon="code"}

Code eines Postfachs oder eines anderen Objekts läuft als sein Dienstkonto. Das Dienstkonto bekommt Zugriff auf einen Space wie eine Person. Nur Personen mit Zugriff **Verwalten** auf den Space fügen es hinzu. Gibt ein Cloud-Admin eine Version von Code frei, gibt diese Freigabe keinen Zugriff auf deinen Space.

:::steps
1. Frage die Person, die den Code schreibt, nach seiner Kennung, etwa `code-7k2q9m4xwt`.
2. Öffne **Space-Einstellungen → Freigabe → Zugriff** und wähle **Zugriff bearbeiten**.
3. Wähle unter **Dienstkonten** **Dienstkonto hinzufügen** und füge die Kennung ein.
4. Wähle **Ansehen** oder **Bearbeiten**.
5. Wähle **Speichern**.
:::

Das Dienstkonto steht jetzt unter **Dienstkonten**. Der nächste Lauf des Codes kann den Space nutzen. Du kannst die Kennung auch in die Suche nach Personen einfügen. Ein Name findet nie ein Dienstkonto.

Ein Dienstkonto bekommt **Ansehen** oder **Bearbeiten**, nie **Verwalten**. Der Zugriff gilt für alles, was die Stufe erlaubt, nicht nur für das, was der Code heute tut. Wer den Code bearbeitet, handelt mit diesem Recht. Um den Zugriff zu beenden, entferne das Dienstkonto und wähle **Speichern**. Danach scheitern Aufrufe des Codes an diesen Space.

## GitHub-Token hinterlegen {icon="brand-github"}

Das GitHub-Token ist optional und gehört zu einem Space. Spaces speichert es verschlüsselt und nutzt es nur für Vorschauen von GitHub-Links an Einträgen dieses Space. Spaces zeigt das Token nie wieder an.

Verwende bevorzugt ein fein abgestuftes Token, das nur Issues und Pull Requests der Repositories lesen kann, an denen der Space arbeitet. Entferne das Token, wenn du es nicht mehr brauchst.

## Kalenderexport teilen {icon="calendar-share"}

Nutze den Kalenderexport, wenn geplante Arbeit in einem externen Kalender erscheinen soll. **iCal-Adresse kopieren** erscheint nur bei eingeschaltetem Kalenderexport.

:::warning Kalenderlinks gewähren Zugriff
Jede Person mit der Export-URL kann die exportierten Termindetails lesen.
:::

:::steps
1. Öffne **…** im Kopfbereich.
2. Wähle **iCal-Adresse kopieren**.
3. Füge die kopierte Adresse als Abonnement in deinem Kalenderprogramm hinzu.
:::
