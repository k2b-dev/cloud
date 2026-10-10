---
id: tools-image-converter
title: Bilder konvertieren
icon: ti ti-arrows-exchange
description: Wandle mehrere Bilder gemeinsam im Browser in JPEG, PNG, WebP oder Base64-HTML um.
order: 117
---

Der **Bildkonverter** verarbeitet mehrere vom Browser unterstützte Bilder gemeinsam, ohne sie hochzuladen.

:::steps
1. Wähle **Bilder hinzufügen** oder ziehe Dateien irgendwo in den Arbeitsbereich.
2. Wähle bei Bedarf eine Vorschau vor dem Export aus, entferne sie oder drehe sie im Uhrzeigersinn.
:::

Die Exporteinstellungen öffnen sich automatisch, sobald der Stapel ein Bild enthält. Sie schließen sich wieder, wenn der Stapel leer ist.

## Ausgabeformat wählen {icon="photo"}

:::reference
- **JPEG:** Ein breit kompatibles Fotoformat. Wähle die Qualität und die Hintergrundfarbe für transparente Pixel.
- **PNG:** Ein verlustfreies Format, das Transparenz erhält. Es hat keine Qualitätseinstellung.
- **WebP:** Ein kompaktes Webformat mit einstellbarer Qualität, das Transparenz unterstützt.
- **Base64-HTML:** Das Menü neben jeder Exportaktion kopiert vollständige `<img>`-Tags. Jedes Tag enthält seine Bilddaten direkt im `src`-Attribut.
:::

**Maximale Breite** und **Maximale Höhe** erhalten das Seitenverhältnis und vergrößern kleinere Bilder nie. Lass ein Feld leer, wenn Breite oder Höhe keine Grenze braucht. Die Grenzen gelten nach der Drehung. Die exportierten Maße bleiben also innerhalb der gewünschten Grenzen.

## Stapel exportieren {icon="package-export"}

Um nur einen Teil des Stapels zu exportieren, wähle zuerst einzelne Vorschauen aus. Ohne Auswahl exportiert die Hauptaktion jedes Bild. Mit aktiver Auswahl bleiben die getrennten Aktionen **Alle exportieren** und **Auswahl exportieren** verfügbar. Jede Aktion zeigt ihre Anzahl an Bildern.

Eine einzelne konvertierte Datei wird direkt heruntergeladen. Mehrere Dateien werden gemeinsam als `converted-images.zip` heruntergeladen. Um stattdessen ein Base64-HTML-Tag pro Bild zu kopieren, nutze das Menü neben einer der Exportaktionen. Doppelte Dateinamen erhalten eine fortlaufende Nummer, damit kein Ergebnis ein anderes überschreibt.

:::info E-Mail-Signaturen
Base64-Bild-Tags sind in kontrolliertem HTML nützlich. E-Mail-Programme und empfangende Systeme unterstützen sie aber nicht einheitlich. Hochgeladene oder gehostete Signaturbilder sind meist zuverlässiger.
:::

## Verarbeitung im Browser verstehen {icon="shield-check"}

Der Konverter behält Quelldateien und Ergebnisse im aktuellen Browser-Tab. Er lädt sie nicht hoch und speichert sie nicht dauerhaft. Welche Eingabeformate funktionieren, hängt davon ab, was der Browser dekodieren kann. Der Konverter rastert Vektorbilder und macht animierte Bilder zu Standbildern. Die konvertierte Ausgabe enthält keine Bildmetadaten.
