---
id: tools-markdown-pdf
title: Markdown in PDF umwandeln
icon: ti ti-file-type-pdf
description: Wandle Markdown mit einer Druckvorlage oder eigenem CSS in ein A4-PDF um und kenne die Limits und die private Verarbeitung im Arbeitsspeicher.
order: 116
---

Nutze **Markdown zu PDF**, um Markdown in ein herunterladbares A4-PDF zu verwandeln. Du musst angemeldet sein.

:::steps
1. Gib Markdown ein oder füge es ein.
2. Wähle unter **Vorlage** eine Druckvorlage.
3. Wähle **PDF erstellen**.
4. Prüfe die erzeugten Seiten, bevor du sie herunterlädst.
:::

## Vorlage wählen {icon="template"}

- **Dokument** nutzt neutrale Typografie und ausgewogene Abstände für allgemeine Dokumente.
- **Bericht** betont Überschriften und Tabellen für formellere Ausgaben.
- **Kompakt** nutzt engere Schrift und Abstände für technische Notizen und Runbooks.
- **Eigene Vorlage** zeigt direkt unter dem Markdown-Editor ein vollständiges, minimales Stylesheet.

Eigenes CSS ersetzt eine Vorlage, statt sie zu überschreiben. Es darf bis zu 32 KiB groß sein. Es kann Druckränder über `@page`, Typografie, Farben, Tabellen und Abstände ändern. Es kann keine Stylesheets, Schriften, Bilder oder andere externe Ressourcen importieren.

## Die aktuellen Grenzen kennen {icon="shield-lock"}

Markdown darf bis zu 256 KiB groß sein. Das Werkzeug zeigt rohes HTML als Text an und führt es nicht aus. Markdown-Bilder erscheinen im erzeugten Dokument als Links. Der Renderer ruft sie nicht ab.

Das Werkzeug sendet Markdown und CSS an diesen Cloud-Server. Es verarbeitet die Eingaben und das erzeugte PDF im Arbeitsspeicher und speichert sie nicht dauerhaft. Die Antwort ist privat und darf nicht zwischengespeichert werden.

Wenn du abbrichst, stoppt die Browser-Anfrage und das Werkzeug ignoriert ein verspätetes Ergebnis. Die bereits gestartete, begrenzte Verarbeitung auf dem Server kann trotzdem abgeschlossen werden. Änderst du nach dem Erstellen Markdown, Vorlage oder CSS, markiert das Werkzeug die sichtbare Vorschau als veraltet.

:::info Web- und API-Werkzeug
Markdown zu PDF hat kein eigenes `cld tools`-Kommando. Authentifizierte Integrationen können den Tools-Endpunkt `/tools/api/markdown/pdf` aufrufen, den OpenAPI dokumentiert. Er akzeptiert Markdown und CSS direkt. Er ruft keine URLs ab und löst keine Ressourcen auf, die einer anderen App gehören.

API-Aufrufe können eine der Vorlagen Dokument, Bericht oder Kompakt mit zusätzlichem CSS anpassen. Sendet ein Aufruf keine Vorlage, gilt das übergebene CSS als vollständiges Stylesheet.
:::
