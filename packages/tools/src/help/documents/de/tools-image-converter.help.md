---
id: tools-image-converter
title: Bilder konvertieren
icon: ti ti-arrows-exchange
description: Mehrere Bilder gemeinsam in JPEG, PNG, WebP oder Base64-HTML umwandeln.
order: 117
---

Der Bildkonverter verarbeitet mehrere vom Browser unterstützte Bilder gemeinsam, ohne sie hochzuladen. Füge Dateien über die Dateiauswahl hinzu oder ziehe sie in den Arbeitsbereich. Jede Vorschau lässt sich vor dem Export auswählen, entfernen oder im Uhrzeigersinn drehen.

Die Export-Einstellungen öffnen sich automatisch, sobald der Stapel ein Bild enthält, und schließen sich wieder, wenn der Stapel leer ist.

## Ausgabeformat wählen {icon="photo"}

:::reference
- **JPEG:** Ein breit kompatibles Fotoformat. Wähle die Qualität und die Hintergrundfarbe für transparente Pixel.
- **PNG:** Ein verlustfreies Format, das Transparenz erhält. Es hat keine Qualitätseinstellung.
- **WebP:** Ein kompaktes Webformat mit einstellbarer Qualität, das Transparenz unterstützt.
- **Base64-HTML:** Das Menü neben jeder Exportaktion kopiert vollständige `<img>`-Tags, deren Bilddaten direkt im jeweiligen `src`-Attribut eingebettet sind.
:::

Maximale Breite und Höhe erhalten das Seitenverhältnis und vergrößern kleinere Bilder nie. Lass ein Feld leer, wenn Breite oder Höhe nicht begrenzt werden soll. Die Limits gelten nach der Drehung, sodass die exportierten Maße innerhalb der gewünschten Grenzen bleiben.

## Stapel exportieren {icon="package-export"}

Wähle einzelne Vorschauen aus, wenn nur ein Teil des Stapels exportiert werden soll. Ohne Auswahl exportiert die Hauptaktion jedes Bild. Mit aktiver Auswahl bleiben getrennte Aktionen **Alle exportieren** und **Auswahl exportieren** verfügbar.

Eine einzelne konvertierte Datei wird direkt heruntergeladen. Mehrere Dateien werden gemeinsam als `converted-images.zip` heruntergeladen. Nutze das Menü neben einer der Exportaktionen, um stattdessen einen Base64-HTML-Tag pro Bild zu kopieren. Doppelte Dateinamen erhalten eine fortlaufende Nummer, damit kein Ergebnis ein anderes überschreibt.

:::info E-Mail-Signaturen
Base64-Bild-Tags sind in kontrolliertem HTML nützlich, werden von E-Mail-Programmen und empfangenden Systemen aber nicht einheitlich unterstützt. Hochgeladene oder gehostete Signaturbilder sind meist zuverlässiger.
:::

## Verarbeitung im Browser verstehen {icon="shield-check"}

Der Konverter behält Quelldateien und Ergebnisse im aktuellen Browser-Tab. Er lädt sie nicht hoch und speichert sie nicht dauerhaft. Welche Eingabeformate unterstützt werden, hängt davon ab, was der Browser dekodieren kann. Vektorbilder werden gerastert, animierte Bilder werden zu Standbildern, und Bildmetadaten bleiben in der konvertierten Ausgabe nicht erhalten.
