---
id: tools-safety
title: Daten und Sicherheit
icon: ti ti-shield-check
description: Lokale Verarbeitung im Browser, Serveranfragen, sensible Daten und wiederholbare Prüfungen verstehen.
order: 120
---

## Wo die Arbeit passiert {icon="route"}

- Generatoren, Encoder, Farbumrechnung, Hashing, Passwörter, Verschlüsselung und Bildbearbeitung sind für die direkte interaktive Nutzung auf der Seite gedacht.
- Dokument zu Markdown sendet ein ausgewähltes Dokument an diesen Cloud-Server zur begrenzten Konvertierung im Arbeitsspeicher. Das Werkzeug speichert weder Upload noch Ergebnis dauerhaft.
- Der Internet-Speedtest tauscht Daten mit dem Cloud-Server aus, um die Verbindung zu messen.
- Der Webhook-Tester erstellt serverseitige Endpunkte und speichert den Anfrageverlauf, damit eingehende Aufrufe später untersucht werden können.

## Mit sensiblen Werten umgehen {icon="point"}

- Füge keine produktiven Zugangsdaten oder Geheimnisse in Beispiele oder Screenshots ein.
- Kopiere erzeugte Passwörter oder Schlüsselmaterial direkt in den vorgesehenen Passwortmanager oder das Ziel und leere danach die Seite.
- Ein Hash ist keine Verschlüsselung und lässt sich nicht umkehren, um die ursprüngliche Eingabe wiederherzustellen.
- Bewahre Schlüssel, Nonce und Angaben zum Algorithmus auf, die ein Verschlüsselungsergebnis erfordert. Der verschlüsselte Text allein reicht später möglicherweise nicht zum Entschlüsseln.
- Behandle Webhook-URLs als aktive Endpunkte, bis du sie entfernst oder nicht mehr nutzt.

:::warning Webhook-Protokolle
Der Tester schwärzt gängige sensible Header wie Authorization und Cookie, aber Anfragepfade und -inhalte können weiterhin private Daten enthalten. Nutze wann immer möglich synthetische Testdaten.
:::
