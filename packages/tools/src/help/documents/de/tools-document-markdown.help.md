---
id: tools-document-markdown
title: Dokument in Markdown umwandeln
icon: ti ti-markdown
description: Unterstützte Dokumente, Server-Verarbeitung, Limits und sichere Markdown-Ausgabe.
order: 115
---

Nutze **Dokument zu Markdown**, wenn du den lesbaren Text eines Dokuments als reines Markdown brauchst. Ziehe die Datei auf das Werkzeug oder wähle sie von deinem Gerät, dann kopiere das Ergebnis oder lade es als `.md`-Datei herunter.

## Unterstützte Dokumente {icon="files"}

Der Konverter akzeptiert PDF, Word (`.doc` und `.docx`), OpenDocument-Text, RTF, PowerPoint- und OpenDocument-Präsentationen, Excel (`.xlsx`) und OpenDocument-Tabellen, CSV und EPUB. Dokumente sind auf 20 MB begrenzt. Extrahiertes Markdown ist auf 1 MB begrenzt; ein gekürztes Ergebnis kennzeichnet das Werkzeug deutlich.

:::warning Scans und geschützte Dokumente
Der Konverter führt keine OCR aus. Ein gescanntes PDF ohne lesbaren Text braucht zuerst OCR in einem anderen Werkzeug. Passwortgeschützte, verschlüsselte, beschädigte oder nicht unterstützte Dateien lassen sich nicht umwandeln.
:::

## Wohin die Datei geht {icon="server"}

Du musst angemeldet sein. Das gewählte Dokument wird an diesen Cloud-Server gesendet und im Arbeitsspeicher umgewandelt. Tools speichert weder den Upload noch das Markdown-Ergebnis dauerhaft. Die Antwort darf nicht zwischengespeichert werden. Die Vorschau zeigt das Ergebnis als reinen Text und führt enthaltenes HTML nicht aus.

Abbrechen stoppt die Browser-Anfrage und ignoriert ein verspätetes Ergebnis. Die zugrunde liegende native Konvertierung kann ihren aktuellen, begrenzten Arbeitsschritt auf dem Server trotzdem noch abschließen.

:::info Web- und API-Werkzeug
Für Dokument zu Markdown gibt es bewusst kein eigenes `cld tools`-Kommando. Angemeldete Personen nutzen die Tools-Seite. Authentifizierte Integrationen können Dateien an den Tools-Endpunkt `/tools/api/documents/markdown` senden, der über OpenAPI beschrieben ist. Der Endpunkt ruft keine URLs ab und löst keine Ressourcen auf, die einer anderen Anwendung gehören.
:::
