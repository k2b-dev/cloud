---
id: filesv2-start
title: Dateien ansehen und herunterladen
icon: ti ti-folders
description: Persönliche Ablagen und Gruppenablagen öffnen und einzelne Dateien herunterladen.
order: 100
---

Files v2 zeigt deine zugänglichen Cloud- und FreeIPA-Verzeichnisse in einer Oberfläche. Die Kennzeichnung neben dem Namen einer Ablage zeigt ihre Herkunft.

## Zurechtfinden

Die Seitenleiste zeigt deine Ablagen mit ihren Ordnern als Baum; der aktuelle Ordner ist hervorgehoben, und ein Ordner, den du öffnest, zeigt statt seines Symbols kurz einen Ladekreis. Ein Klick auf einen Ordner in der Liste öffnet ihn; die erste Zeile **..** führt zurück in den übergeordneten Ordner. Ein Klick auf eine Datei öffnet rechts das Detailpanel, für Ordner nutzt du dafür den kleinen Info-Button am Zeilenende. Das X schließt das Panel und hebt die Auswahl auf.

Über der Liste wählst du **Liste**, **Grid** oder **Baum**. Der Baum zeigt die ganze Ablage ab ihrer Wurzel mit hervorgehobenem aktuellen Ordner; ein Klick auf einen Ordnernamen macht ihn zum aktuellen Ordner, ein Klick auf sein Symbol klappt auf oder zu, mehrere gleichzeitig. Neue Einträge und Uploads landen immer im aktuellen Ordner, den jeder Namensdialog anzeigt. Im Grid erscheint zusätzlich die Kachelgröße. Ansicht und Größe merkt sich der Browser pro Ordner. **Nächste Seite** und **Erste Seite** blättern in großen Ordnern; Ablage, Ordner, Seite und eine einzeln ausgewählte Datei bleiben in der Adresse, sodass du neu laden oder ein Lesezeichen setzen kannst.

## Suchen

Das Suchfeld oben durchsucht Namen überall unterhalb des aktuellen Ordners; Treffer zeigen ihren Pfad relativ zum Ordner. Enter startet die Suche, das Leeren des Feldes führt zurück zur Auflistung. Ablagen ohne Suchindex werden bei Bedarf durchsucht; enthält ein Ordner dafür zu viele Einträge, suche in einem kleineren Ordner. Die Lupe oben in der Seitenleiste öffnet die globale Cloud-Suche nur für Dateien über alle deine Ablagen; ein Treffer führt in seinen Ordner mit ausgewählter Datei.

## Auswählen und handeln

**Auswählen** neben der Eintragszahl blendet in jeder Ansicht Kontrollkästchen ein; ein Klick wechselt dann die Auswahl eines Eintrags, **Fertig** blendet sie wieder aus. Ohne Kontrollkästchen fügt Strg/Cmd-Klick Einträge hinzu, Umschalt-Klick wählt einen Bereich, Strg/Cmd-A die geladene Seite. Pfeiltasten bewegen, Leertaste wechselt, Escape hebt auf. Mit einer Auswahl erscheinen **n ausgewählt** und ein Menü **Aktionen** unter dem Suchfeld: herunterladen (eine Datei direkt, mehrere Einträge oder Ordner als ZIP), in neuen Ordner verschieben, in einen anderen Ordner verschieben, in diese oder eine andere Ablage kopieren, öffentlich teilen oder in den Papierkorb verschieben. Ein Rechtsklick auf eine Zeile bietet dieselben Aktionen.

Verschieben bleibt innerhalb einer Ablage. Kopieren kann in eine andere Ablage zielen; die Originale bleiben erhalten, damit eine Gruppendatei nie versehentlich in einem privaten Verzeichnis verschwindet.

## Hinzufügen, hochladen und ändern

Das Plus neben dem Suchfeld bietet **Hochladen**, **Ordner hochladen**, **Neuer Ordner** und **Neue Datei**. Du kannst Dateien auch von deinem Gerät auf die Liste ziehen. Jede Datei geht direkt an den Dateiserver, nachdem Cloud deinen Zugriff geprüft hat, und wird erst veröffentlicht, wenn die Übertragung vollständig ist. Der Fortschritt erscheint als Benachrichtigung mit Fortschrittsbalken. Existieren Namen bereits, entscheidest du einmal pro Upload, ob du sie ersetzt oder nur die neuen Dateien hochlädst. Namen dürfen keine Schrägstriche enthalten.

Das Detailpanel eines Eintrags bietet **In neuem Tab öffnen**, **Umbenennen**, **Duplizieren**, **Verschieben nach**, **Kopieren nach**, **Öffentlich teilen** und **In den Papierkorb**. Ordner bieten zusätzlich **Als Upload-Eingang freigeben**. Der Kopieren-Button in der Kopfzeile legt eine Cloud-Referenz in die Zwischenablage, die andere Apps verstehen.

## Papierkorb

Löschen entfernt nie etwas endgültig: Einträge wandern in den Papierkorb ihrer Ablage, der als **Papierkorb** am Ende des Wurzelordners und in der Seitenleiste erscheint. Öffne ihn, um Gelöschtes zu sehen; **Wiederherstellen** legt einen Eintrag an seinen ursprünglichen Ort zurück. Nur die Administration kann den Papierkorb leeren.

## Versionen

Wo die Ablage Versionen behält, listet das Detailpanel frühere Versionen einer Datei ganz unten. Zu jeder Version kannst du einen Kommentar hinterlegen, sie herunterladen, an Ort und Stelle wiederherstellen, als neue Datei neben der aktuellen wiederherstellen oder sie löschen. Beim Wiederherstellen an Ort und Stelle bleibt der aktuelle Stand als neue Version erhalten.

## Öffentlich teilen

Wähle Einträge aus und nutze **Öffentlich teilen**, oder gib einen Ordner in seinen Details als **Upload-Eingang** frei. Vergib einen Namen, wähle die Gültigkeit des Links und ergänze bei Bedarf eine interne Notiz. Alle, die den Ordner mit den geteilten Einträgen öffnen können, sehen die Freigabe unter **Freigaben** in der Seitenleiste und können den Link kopieren oder widerrufen. Eine Download-Freigabe lässt jede Person mit dem Link die Einträge einzeln oder als ZIP herunterladen; ein Upload-Eingang lässt jede Person mit dem Link Dateien in diesen Ordner legen, ohne dessen Inhalt zu sehen. Bestehende Dateien werden dabei nie ersetzt.

## Datei herunterladen

Wähle **Herunterladen** neben einer Datei. Die Cloud prüft deinen aktuellen Zugriff und bereitet einen kurzzeitig gültigen Download direkt vom Dateiserver vor. Schlägt die Vorbereitung fehl, erscheint oberhalb der Liste eine Fehlermeldung. Du kannst den Download erneut anfordern.

Wähle mehrere einzelne Dateien aus und nutze **Herunterladen**. Dein Browser fragt möglicherweise nach der Erlaubnis für mehrere Downloads. Öffne Ordner, um ihre einzelnen Dateien herunterzuladen.

## Terminal verwenden

Melde dich mit `cld login --server <Cloud-URL>` an. `cld filesv2 bases list --json` zeigt deine Ablagen-IDs. Mit `cld filesv2 list <base-id> --path Documents --json` liest du einen Ordner. Enthält das Ergebnis einen `next`-Cursor, übergib ihn unverändert als `--after` für die nächste Seite.

`cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf` lädt eine Datei direkt von Filegate in eine neue lokale Datei. Bestehende Pfade werden nie überschrieben. Mit `--json` erhältst du den gespeicherten Pfad und die Byteanzahl. `cld filesv2 help` zeigt alle verfügbaren Befehle.

`cld filesv2 search <base-id> Bericht --path Dokumente --json` sucht Namen unterhalb eines Ordners und `cld filesv2 mkdir <base-id> Dokumente/2026` legt einen Ordner an. `rename`, `move --to`, `copy --to [--target-base]`, `delete`, `trash list|restore`, `versions list|comment|restore|delete` und `shares list|create|revoke` decken die übrigen Vorgänge ab. `cld filesv2 upload <base-id> ./bericht.pdf --to Dokumente/bericht.pdf` lädt eine Datei direkt zum Dateiserver hoch; mit `--replace` ersetzt du eine bestehende Datei. `cld filesv2 stat <base-id> <path> --json` liest aktuelle Dateidetails. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` speichert eine Bildvorschau.

## Wenn eine Ablage nicht verfügbar ist

Ein leerer Ordner bedeutet etwas anderes als ein fehlendes oder nicht erreichbares Verzeichnis. Die Seite zeigt, ob ein Verzeichnis fehlt, zugeordnet werden muss oder derzeit nicht erreichbar ist. Kontaktiere die Administration, wenn ein Verzeichnis geprüft werden muss.

Cloud-Ablagen setzen aktivierte lokale Linux-Identitäten voraus. Nur POSIX-Gruppen können eine Gruppenablage haben. FreeIPA-Ablagen werden unabhängig konfiguriert; FreeIPA-Nutzer können zusätzlich auf zugängliche lokale Cloud-Gruppenablagen zugreifen.
