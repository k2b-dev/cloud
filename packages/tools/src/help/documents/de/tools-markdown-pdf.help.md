---
id: tools-markdown-pdf
title: Markdown in PDF umwandeln
icon: ti ti-file-type-pdf
description: Druckvorlagen, eigenes CSS, Limits und private PDF-Erzeugung im Arbeitsspeicher.
order: 116
---

Nutze **Markdown zu PDF**, um Markdown in ein herunterladbares A4-PDF zu verwandeln. Gib Markdown ein oder füge es ein, wähle eine Druckvorlage und wähle **PDF erstellen**. Prüfe die erzeugten Seiten, bevor du sie herunterlädst.

## Vorlage wählen {icon="template"}

- **Dokument** nutzt neutrale Typografie und ausgewogene Abstände für allgemeine Dokumente.
- **Bericht** betont Überschriften und Tabellen für formellere Ausgaben.
- **Kompakt** nutzt engere Schrift und Abstände für technische Notizen und Runbooks.
- **Benutzerdefiniert** zeigt direkt unter dem Markdown-Editor ein vollständiges, minimales Stylesheet an.

Eigenes CSS ersetzt eine Vorlage, statt sie zu überschreiben, und ist auf 32 KiB begrenzt. Es darf Druckränder über `@page`, Typografie, Farben, Tabellen und Abstände ändern. Es kann keine Stylesheets, Schriften, Bilder oder andere externe Ressourcen importieren.

## Die aktuellen Grenzen kennen {icon="shield-lock"}

Markdown ist auf 256 KiB begrenzt. Rohes HTML wird als Text angezeigt statt ausgeführt. Markdown-Bilder erscheinen im erzeugten Dokument als Links; der Renderer ruft sie nicht ab.

Du musst angemeldet sein. Markdown und CSS werden an diesen Cloud-Server gesendet. Das Werkzeug verarbeitet die Eingaben und das erzeugte PDF im Arbeitsspeicher, speichert sie nicht dauerhaft und verhindert das Zwischenspeichern der Antwort.

Abbrechen stoppt die Browser-Anfrage und ignoriert ein verspätetes Ergebnis. Die bereits gestartete serverseitige Verarbeitung kann trotzdem abgeschlossen werden. Änderst du nach dem Erzeugen Markdown, Vorlage oder CSS, markiert das Werkzeug die sichtbare Vorschau als veraltet.

:::info Web- und API-Werkzeug
Markdown zu PDF hat kein eigenes `cld tools`-Kommando. Authentifizierte Integrationen können den Tools-eigenen Endpunkt `/tools/api/markdown/pdf` aufrufen, der über OpenAPI dokumentiert ist. Er akzeptiert Markdown und CSS direkt; er ruft keine URLs ab und löst keine Ressourcen auf, die einer anderen Anwendung gehören.
API-Aufrufe können eine Vorlage mit zusätzlichem CSS anpassen. Ohne Vorlage gilt das übergebene CSS als vollständiges Stylesheet.
:::
