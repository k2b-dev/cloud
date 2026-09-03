---
id: notebooks-troubleshooting
title: "Fehlerbehebung"
icon: "ti ti-lifebuoy"
description: "Probleme mit Abfragen, Daten, Formeln, Anhängen und Ansichten beheben."
order: 180
---

Prüfe den Markdown-Quelltext und deine Berechtigungen im Notizbuch, bevor du seine Struktur änderst.

## Häufige Symptome {icon="stethoscope"}

:::reference
- **Eine Abfrage zeigt einen Fehler:** Öffne ihren Quelltext und prüfe die markierte Zeile. Verwende source: notes, unterstützte Felder und Operatoren und schließe den Block mit :::.
- **Benannte Daten fehlen in einer Abfrage:** Setze @name direkt über :::data. Verwende eindeutige Namen und Schlüssel, flache Werte und dieselbe Feldschreibweise in der Abfrage. Ungültige oder doppelt benannte Daten werden nicht indexiert.
- **Eine Abfrage liefert keine Notizen:** Prüfe scope, Tags, Werttypen und match. Der Standard match: all verlangt jeden Filter. Abfragen lesen gespeicherte Notizen, nicht ungespeicherten Text in einem anderen Editor.
- **Eine Formel zeigt einen Fehler:** Prüfe Funktionsnamen, Argumentanzahl, Spaltennamen und zirkuläre Bezüge. Spaltennamen mit Leerzeichen brauchen Backticks.
- **Ein Anhang fehlt:** Prüfe, ob die Datei in diesem Notizbuch existiert und der Markdown-Link attach://shortId verwendet.
- **Bearbeitung oder Kommentare fehlen:** Leserechte öffnen nur die Buchansicht. Nutzer mit Schreib- oder Adminrechten können für den Detailbereich zu Bearbeiten oder Schreibgeschützt wechseln. Gesperrte Notizen lassen sich nicht bearbeiten.
- **Ein altes Skript läuft nicht mehr:** Ausführbare Skripte werden nicht mehr unterstützt. Vorhandene Skriptblöcke bleiben lesbarer Code; ersetze Seitenlisten durch :::query und Inhaltsverzeichnisse durch :::toc. Für Skriptbuttons und Schreibaktionen gibt es keinen Ersatz.
:::

## Aktualisierungen prüfen {icon="refresh"}

Beim Bearbeiten wird der Notiztext mit anderen Bearbeitern synchronisiert. Gespeicherte Änderungen aktualisieren Abfragevorschauen und Buchinhalte. Die schreibgeschützte Ansicht empfängt keine gemeinsamen Textänderungen: Lade sie neu, wenn sich die gespeicherte Quelle geändert hat.

Kann eine Buchseite nicht aktualisiert werden, bleibt der letzte lesbare Inhalt sichtbar und du kannst es erneut versuchen. Entfällt der Zugriff oder die Seite, zeigt Notebooks den alten Inhalt nicht weiter an und prüft die Seite erneut. Ohne JavaScript musst du für Änderungen neu laden.
