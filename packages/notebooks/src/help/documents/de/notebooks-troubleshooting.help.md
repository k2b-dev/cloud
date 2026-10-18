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

## Ein Bild fehlt im PDF {icon="photo"}

Das PDF markiert jedes fehlende Bild mit **Bild nicht enthalten: …** und einem Grund. Der Download-Dialog listet dieselben Auslassungen auf.

:::reference
- **Datei nicht gefunden:** Hänge die Datei erneut an dieses Notizbuch an. Ein Anhang aus einem anderen Notizbuch ist hier nicht verfügbar.
- **Format kann nicht gedruckt werden:** Verwende JPEG, PNG, WebP oder GIF. SVG-Dateien bleiben als Download verfügbar.
- **Datei konnte nicht gelesen werden:** Öffne und prüfe die Datei. Exportiere sie erneut und hänge die neue Kopie an.
- **Datei zu groß:** Hänge ein kleineres Bild an. Die Größenbegrenzung für Anhänge gilt auch für Bilder im PDF.
- **Kein Platz mehr im PDF:** Verwende kleinere Bilder oder teile die Notiz auf. Bilder teilen sich die **Maximale Eingabegröße** mit dem Dokument. Die Administration kann diese Grenze erhöhen. Große Bilder werden mit 300, 200 oder 150 dpi gedruckt.
- **Vorbereitung dauerte zu lange:** Versuche es erneut oder verwende weniger oder kleinere Bilder. Die Vorbereitung der Bilder bekommt dieselbe Zeit wie der PDF-Renderer, höchstens 115 Sekunden. Die Administration kann das **Zeitlimit** des Renderers erhöhen.
- **Adresse nicht erlaubt:** Hänge das Bild an dieses Notizbuch an und verwende seinen Anhang-Link.
- **Wird noch nicht im PDF gedruckt:** Externe HTTP(S)-Bilder werden noch nicht aufgenommen. Hänge das Bild stattdessen an oder öffne die Notiz, um es anzusehen.
- **Adresse nicht erreichbar:** Prüfe die Adresse oder versuche es später erneut.
:::

## Aktualisierungen prüfen {icon="refresh"}

**Bearbeiten** synchronisiert den Notiztext mit anderen Personen, die ihn bearbeiten. Gespeicherte Änderungen aktualisieren Abfragevorschauen und Buchinhalte. **Schreibgeschützt** empfängt keine gemeinsamen Textänderungen. Lade die Ansicht neu, nachdem sich der gespeicherte Quelltext geändert hat.

Wenn **Bearbeiten** nicht mehr synchronisiert, etwa weil deine Sitzung abgelaufen ist oder die Notiz gelöscht wurde, bleibt die Notiz sichtbar und wird schreibgeschützt. Die Leiste unter der Notiz zeigt, ob deine Änderungen gespeichert sind. Mit **Erneut anmelden** kannst du nach der Anmeldung weiter bearbeiten. Nutze sonst **Text kopieren**, bevor du **Neu laden** wählst. Sind Änderungen nicht gespeichert, fragt Notebooks nach, bevor du die Notiz verlässt.

Kann eine Buchseite nicht aktualisiert werden, bleibt ihr letzter lesbarer Inhalt sichtbar, und du kannst es erneut versuchen. Endet dein Zugriff oder verschwindet die Seite, zeigt Notebooks den alten Inhalt nicht mehr und prüft die Seite erneut. Ohne JavaScript lädst du die Seite neu, um Änderungen zu sehen.
