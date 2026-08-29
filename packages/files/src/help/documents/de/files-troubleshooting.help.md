---
id: files-troubleshooting
title: Probleme beheben
icon: ti ti-lifebuoy
description: Fehlende Ablagen, leere Suchen, nicht verfügbare Vorschauen, langsame Ordner und fehlgeschlagene Dateiaktionen prüfen.
order: 120
---

Prüfe zuerst die gewählte Dateiablage und den Ordnerpfad. Unerwartete Ergebnisse entstehen häufig, weil eine andere Ablage geöffnet ist, ein Filter auf den aktuellen Ordner wirkt oder der Zugriff auf den Zielpfad fehlt.

## Häufige Probleme {icon="lifebuoy"}

:::reference
- **Eine persönliche Ablage oder Gruppenablage fehlt:** Files zeigt nur Ablagen an, die über das aktuelle IPA-Konto und rekursive Gruppenmitgliedschaften zugänglich sind. Bitte eine Person mit Administratorrechten, das Konto und die Gruppenzugriffe zu prüfen.
- **Ein Ordner wirkt leer:** Entferne den Filter der Ordnersuche. Aktiviere bei Bedarf in den Ansichtseinstellungen die Anzeige verborgener Dateien.
- **Die übergreifende Suche findet nichts:** Prüfe die ausgewählten Ablagen und das glob-Muster. Verwende `**/*name*` für eine breite Namenssuche oder ein Muster wie `**/*.pdf` für einen Dateityp.
- **Für eine Datei ist keine Vorschau verfügbar:** Nicht jeder Dateityp kann sicher im Browser angezeigt werden. Lade die Datei herunter oder öffne sie in einem neuen Tab, wenn diese Aktion angeboten wird.
- **Ein Ordner lädt langsam:** Deaktiviere exakte Dateigrößen. Die Berechnung genauer Ordnergrößen verursacht zusätzliche Arbeit auf dem Server.
- **Verschieben oder Umbenennen schlägt fehl:** Prüfe, ob das Ziel existiert, du dort Schreibzugriff hast und der Zielname nicht bereits vergeben ist.
- **Löschen ist im Papierkorb nicht verfügbar:** Der Papierkorb dient zur Wiederherstellung. Der Dateibrowser löscht keine Elemente aus dem Papierkorb.
:::

## Vor einem erneuten Upload prüfen {icon="paperclip"}

:::steps
1. Entferne den aktuellen Filter und prüfe den erwarteten Ordner.
2. Aktualisiere den Ordner einmal.
3. Suche nach einem gleichnamigen Element oder einem teilweise hochgeladenen Ordner.
4. Wiederhole den Upload erst, wenn der erste Upload nicht abgeschlossen wurde.
:::

:::warning Gemeinsam genutzter Speicher
Änderungen in einer Gruppenablage betreffen alle Personen, die diesen Speicher verwenden. Prüfe vor dem Verschieben oder Löschen mehrerer Elemente den Pfad und die Anzahl der ausgewählten Elemente.
:::
