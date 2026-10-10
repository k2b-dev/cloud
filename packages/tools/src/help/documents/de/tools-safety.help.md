---
id: tools-safety
title: Daten sicher behandeln
icon: ti ti-shield-check
description: Erkenne, welche Werkzeuge Daten im Browser oder auf dem Server verarbeiten, und gehe sicher mit kopierten Geheimnissen und Webhook-Daten um.
order: 120
---

## Wissen, wo die Arbeit passiert {icon="route"}

- Generatoren, Kodierwerkzeuge, Farbumrechnung, Hashing, Passwörter, Verschlüsselung und Bildbearbeitung sind für die direkte interaktive Nutzung auf der Seite gedacht.
- **Dokument zu Markdown** sendet ein ausgewähltes Dokument an diesen Cloud-Server zur begrenzten Konvertierung im Arbeitsspeicher. Das Werkzeug speichert weder Upload noch Ergebnis dauerhaft.
- Der **Internet-Speedtest** tauscht Daten mit dem Cloud-Server aus, um die Verbindung zu messen.
- Der **Webhook-Tester** erstellt Endpunkte auf dem Server und speichert den Anfrageverlauf, damit du eingehende Aufrufe später untersuchen kannst.

## Sensible Werte schützen {icon="point"}

:::warning Webhook-Protokolle
Der Tester schwärzt gängige sensible Header wie Authorization und Cookie. Anfragepfade und -inhalte können trotzdem private Daten enthalten. Nutze wann immer möglich synthetische Testdaten.
:::

- Füge keine produktiven Zugangsdaten oder Geheimnisse in Beispiele oder Screenshots ein.
- Kopiere erzeugte Passwörter oder Schlüsselmaterial direkt in den vorgesehenen Passwortmanager oder das Ziel. Leere danach die Seite.
- Ein Hash ist keine Verschlüsselung. Du kannst ihn nicht umkehren, um die ursprüngliche Eingabe wiederherzustellen.
- Bewahre Schlüssel, Nonce und die Angaben zum Algorithmus auf, die ein Verschlüsselungsergebnis braucht. Der verschlüsselte Text allein reicht später nicht immer zum Entschlüsseln.
- Behandle Webhook-URLs als aktive Endpunkte, bis du sie entfernst oder nicht mehr nutzt.
