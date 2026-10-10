---
id: tools-document-markdown
title: Dokument in Markdown umwandeln
icon: ti ti-markdown
description: Extrahiere den lesbaren Text eines Dokuments als reines Markdown und kenne unterstützte Dateien, Limits und die Verarbeitung auf dem Server.
order: 115
---

Nutze **Dokument zu Markdown**, wenn du den lesbaren Text eines Dokuments als reines Markdown brauchst. Du musst angemeldet sein.

## Dokument umwandeln {icon="files"}

Der Konverter akzeptiert PDF, Word (`.doc` und `.docx`), OpenDocument-Text, RTF, PowerPoint- und OpenDocument-Präsentationen, Excel (`.xlsx`) und OpenDocument-Tabellen, CSV und EPUB. Ein Dokument darf bis zu 20 MB groß sein.

:::warning Scans und geschützte Dokumente
Der Konverter führt keine OCR aus. Ein gescanntes PDF ohne lesbaren Text braucht zuerst OCR in einem anderen Werkzeug. Passwortgeschützte, verschlüsselte, beschädigte oder nicht unterstützte Dateien kann der Konverter nicht umwandeln.
:::

:::steps
1. Ziehe die Datei auf das Werkzeug oder wähle sie von deinem Gerät aus.
2. Wähle **Markdown kopieren** oder wähle **.md herunterladen**, um eine `.md`-Datei zu speichern.
:::

Das extrahierte Markdown darf bis zu 1 MB groß sein. Ein gekürztes Ergebnis kennzeichnet das Werkzeug deutlich.

## Verstehen, wohin die Datei geht {icon="server"}

Das Werkzeug sendet das gewählte Dokument an diesen Cloud-Server und wandelt es im Arbeitsspeicher um. Tools speichert weder den Upload noch das Markdown-Ergebnis dauerhaft. Die Antwort ist privat und darf nicht zwischengespeichert werden. Die Vorschau zeigt das Ergebnis als reinen Text und führt enthaltenes HTML nicht aus.

Wenn du abbrichst, stoppt die Browser-Anfrage und das Werkzeug ignoriert ein verspätetes Ergebnis. Die native Konvertierung auf dem Server kann ihren aktuellen, begrenzten Arbeitsschritt trotzdem noch abschließen.

:::info Web- und API-Werkzeug
Für Dokument zu Markdown gibt es bewusst kein eigenes `cld tools`-Kommando. Angemeldete Personen nutzen die Tools-Seite. Authentifizierte Integrationen können Dateien an den Tools-Endpunkt `/tools/api/documents/markdown` senden, den OpenAPI beschreibt. Der Endpunkt ruft keine URLs ab und löst keine Ressourcen auf, die einer anderen App gehören.
:::
