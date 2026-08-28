---
id: notebooks-core-model
title: "Grundmodell"
icon: "ti ti-components"
description: "Die stabilen Konzepte hinter Notizbüchern, Notizen, benannten Blöcken, Anhängen und Skripten."
order: 110
---

Ein Notizbuch ist ein gemeinsamer Arbeitsbereich. Eine Notiz ist das Quelldokument. Benannte Blöcke und Skripte ergänzen diese Quelle, ersetzen sie aber nicht.

## Die Objekte {icon="box-multiple"}

:::reference
- **Notizbuch:** Arbeitsbereich mit Notizen, Anhängen, Einstellungen, Berechtigungen, Exporten, optionalen Skripten und lokalem Zustand. Seine unveränderliche sechsstellige ID wird in URLs und APIs verwendet.
- **Notiz:** Markdown-Dokument mit Text, Aufgaben, Links, Tabellen, Datenblöcken, Anhängen und Skriptausgaben. Auch seine sechsstellige ID ist unveränderlich.
- **Notizbaum:** Notizen können übergeordnete Notizen haben. Die Seitenleiste nutzt diese Hierarchie zur Navigation.
- **Tag:** Eine aus dem Inhalt gelesene `#Markierung`, die Suche, Tag-Seiten und Skripte verwenden.
- **Anhang:** Eine in das Notizbuch hochgeladene Datei, die Markdown mit `attach://shortId` referenziert.
- **Benannter Block:** Tabelle, Liste, Aufgabenliste, Datenblock oder Abschnitt mit einem `@name`, den Skripte lesen können.
- **Skript:** Vertrauenswürdiger JavaScript-Block, der Notizbuch-APIs liest und Ausgaben in der Notiz rendert.
:::

:::success Verlässliche Quelle
Halte wichtige Informationen in Markdown sichtbar. Skripte und Formeln sollen lesbare Quelldaten zusammenfassen oder aktualisieren und nicht deren einzige Kopie verstecken.
:::
