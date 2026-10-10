---
id: notebooks-troubleshooting
title: "Fehlerbehebung"
icon: "ti ti-lifebuoy"
description: "Probleme mit Abfragen, Daten, Formeln, Anhängen und Ansichten beheben."
order: 180
---

Bevor du die Struktur einer Notiz änderst, prüfe ihren Markdown-Quelltext und deinen Zugriff auf das Notizbuch.

## Häufige Probleme beheben {icon="stethoscope"}

:::reference
- **Eine Abfrage zeigt einen Fehler:** Öffne ihren Quelltext und prüfe die markierte Zeile. Verwende source: notes und unterstützte Felder und Operatoren. Schließe den Block mit :::.
- **Benannte Daten fehlen in einer Abfrage:** Setze @name direkt über :::data. Verwende eindeutige Namen und Schlüssel und flache Werte. Schreibe das Feld in der Abfrage genauso. Notebooks indexiert keine ungültigen oder doppelt benannten Daten.
- **Eine Abfrage liefert keine Notizen:** Prüfe scope, Tags, Werttypen und match. Der Standard match: all verlangt jeden Filter. Die Abfrage liest gespeicherte Notizen, nicht ungespeicherten Text in einem anderen Editor.
- **Eine Formel zeigt einen Fehler:** Prüfe die Schreibweise der Funktion, die Anzahl der Argumente, die Spaltennamen und zirkuläre Bezüge. Spaltennamen mit Leerzeichen brauchen Backticks.
- **Ein Anhang fehlt:** Prüfe, ob die Datei in diesem Notizbuch existiert und das Markdown attach://shortId verwendet.
- **Bearbeiten oder Kommentare fehlen:** Zugriff **Ansehen** öffnet nur die Buchansicht. Mit Zugriff **Bearbeiten** oder **Verwalten** wechselst du für den Detailbereich zu **Bearbeiten** oder **Schreibgeschützt**. Gesperrte Notizen kannst du nicht bearbeiten.
- **Ein altes Skript läuft nicht mehr:** Ausführbare Skripte werden nicht mehr unterstützt. Vorhandene Skriptblöcke bleiben lesbarer Code. Ersetze Seitenlisten durch :::query und Inhaltsverzeichnisse durch :::toc. Für Skriptbuttons und Schreibaktionen gibt es keinen Ersatz.
:::

## Aktualisierungen prüfen {icon="refresh"}

**Bearbeiten** synchronisiert den Notiztext mit anderen Personen, die ihn bearbeiten. Gespeicherte Änderungen aktualisieren Abfragevorschauen und Buchinhalte. **Schreibgeschützt** empfängt keine gemeinsamen Textänderungen. Lade die Ansicht neu, nachdem sich der gespeicherte Quelltext geändert hat.

Kann eine Buchseite nicht aktualisiert werden, bleibt ihr letzter lesbarer Inhalt sichtbar, und du kannst es erneut versuchen. Endet dein Zugriff oder verschwindet die Seite, zeigt Notebooks den alten Inhalt nicht mehr und prüft die Seite erneut. Ohne JavaScript lädst du die Seite neu, um Änderungen zu sehen.
