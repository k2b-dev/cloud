---
id: notebooks-troubleshooting
title: "Fehlerbehebung"
icon: "ti ti-lifebuoy"
description: "Häufige Probleme mit Markdown, @ref, Formeln, Skripten, Anhängen und Suche beheben."
order: 180
---

Die meisten Probleme betreffen Markdown-Syntax, stabile `@ref`-Namen, aktivierte Skripte oder die Berechtigungen des Notizbuchs.

## Häufige Symptome {icon="stethoscope"}

:::reference
- **Ein Skript findet eine Tabelle nicht:** Prüfe, ob direkt über der Tabelle ein stabiler `@name` steht und das Skript denselben Namen verwendet.
- **Eine Formel zeigt einen Fehler:** Prüfe Funktionsname, Argumente, Spaltennamen und zyklische Verweise. Spaltennamen mit Leerzeichen benötigen Backticks.
- **Ein Skript läuft nicht:** Prüfe, ob Skriptblöcke in den Einstellungen aktiviert sind und der Code in einem `script`-Codeblock steht.
- **Die Suche findet eine Notiz nicht:** Tags werden aus `#tag` gelesen. Strukturierte Tag-Filter verlangen alle angegebenen Tags.
- **Ein Anhang fehlt:** Prüfe, ob die Datei im Notizbuch vorhanden ist und der Verweis `attach://shortId` verwendet.
- **Ein Skript schreibt an die falsche Stelle:** Schreibzugriffe über `current` ändern die Notiz mit dem Skript. `nb.update` verschiebt nur eine andere Notiz im aktuellen Notizbaum.
:::

## Schrittweise prüfen {icon="route"}

:::steps
1. **Markdown lesen:** Prüfe zuerst, ob die Rohfassung die erwarteten Daten enthält.
2. **Benannte Blöcke prüfen:** Vergleiche die `@ref`-Namen und nutze zum Erkunden Pluralmethoden wie `current.tables()`.
3. **Skript verkleinern:** Beginne mit `ui.text` oder `ui.table`, bevor du Aktionen, Eingaben, Diagramme oder Schreibzugriffe hinzufügst.
4. **Änderungen nachvollziehbar halten:** Bevorzuge sichtbare Markdown-Änderungen und benannte Blöcke, wenn andere das Ergebnis verstehen müssen.
:::
