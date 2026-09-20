---
id: filesv2-start
title: Dateien ansehen und bearbeiten
icon: ti ti-folders
description: Ablagen öffnen, Dokumente bearbeiten, Vorlagen nutzen und Dateien teilen.
order: 100
---

Files v2 zeigt deine zugänglichen Cloud- und FreeIPA-Verzeichnisse in einer Oberfläche. Die Kennzeichnung neben dem Namen einer Ablage zeigt ihre Herkunft.

## Zurechtfinden

Die Seitenleiste zeigt deine Ablagen mit ihren Ordnern als Baum; der aktuelle Ordner ist hervorgehoben, und ein Ordner, den du öffnest, zeigt statt seines Symbols kurz einen Ladekreis. Ein Klick auf einen Ordner in der Liste öffnet ihn; die erste Zeile **..** führt zurück in den übergeordneten Ordner. Ein Klick auf eine Datei öffnet rechts das Detailpanel, für Ordner nutzt du dafür den kleinen Info-Button am Zeilenende. Das X schließt das Panel und hebt die Auswahl auf.

Über der Liste wählst du **Liste**, **Grid** oder **Baum**. Der Baum zeigt die ganze Ablage ab ihrer Wurzel mit hervorgehobenem aktuellen Ordner; ein Klick auf einen Ordnernamen macht ihn zum aktuellen Ordner, ein Klick auf sein Symbol klappt auf oder zu, mehrere gleichzeitig. Neue Einträge und Uploads landen immer im aktuellen Ordner, den jeder Namensdialog anzeigt. Im Grid erscheint zusätzlich die Kachelgröße. Ansicht und Größe merkt sich der Browser pro Ablage. **Nächste Seite** und **Erste Seite** blättern in großen Ordnern; Ablage, Ordner, Seite und eine einzeln ausgewählte Datei bleiben in der Adresse, sodass du neu laden oder ein Lesezeichen setzen kannst.

## Sortieren, filtern und ziehen

Öffne **Sortieren und filtern** über den Symbol-Button rechts neben der Suche. Das Menü enthält **Sortieren nach**, **Reihenfolge** und **Typ**. Wähle Name, Datum oder Größe, aufsteigende oder absteigende Reihenfolge sowie alle Einträge, Dateien oder Ordner. **Ordner gruppieren** ist standardmäßig an: Ordner stehen vor Dateien, beide nach Name sortiert. Schalte es aus, um Ordner und Dateien gemeinsam zu sortieren. Der Browser merkt sich die Gruppierung pro Ablage. **Zurücksetzen** stellt Name aufsteigend, alle Typen und die Gruppierung wieder her. Der Eintrag `..` bleibt auch bei anderer Sortierung oder einem Typfilter über den Einträgen. Auch die Spaltenköpfe der Liste sortieren. Sortierung und Filter gelten über alle Seiten. Bei aktiver Gruppierung erscheinen alle Ordner vor den Dateien. Die Optionen bleiben in der Adresse. Ist eine gespeicherte Seite abgelaufen oder ungültig geworden, kehrt der Browser mit einem Hinweis zur ersten Seite zurück.

Ziehe einen Eintrag auf einen Ordner, um ihn dorthin zu verschieben; eine hervorgehobene oder angehakte Auswahl wandert gemeinsam. Die Zeile **..** verschiebt in den übergeordneten Ordner. Verweile kurz auf einem Ordner, dann öffnet er sich (Liste und Grid) oder klappt auf (Baum), sodass du tiefer ablegen kannst, ohne loszulassen. Dateien und Ordner von deinem Gerät werden beim Ablegen hochgeladen; die Ordnerstruktur bleibt erhalten. Große Auswahlen sind begrenzt und lassen sich abbrechen.

Geöffnete oder heruntergeladene Dateien erscheinen unter **Zuletzt**; **Favoriten** sammelt deine markierten Einträge. Am Desktop öffnen sich kompakte Menüs per Hover, Fokus oder Klick, mobil Dialoge über die Navigation. Zuletzt zeigt relative Zeitangaben, Favoriten sind alphabetisch sortiert. Wähle einen Ordner, um ihn zu öffnen, oder eine Datei für ihre Details. Der ungefüllte Stern neben Vorschau und Herunterladen markiert einen Favoriten: Ein goldener Umriss zeigt den gespeicherten Zustand. Bei Hover oder Tastaturfokus erscheint ein X zum Entfernen; auf Touch genügt das Antippen des markierten Sterns. Fehlende oder nicht mehr zugängliche Einträge werden beim Aktualisieren ausgelassen. PDF- und Office-Dateien zeigen in Liste und Grid ein Dateityp-Icon. PDFs kannst du weiterhin mit ihrem Inhalt öffnen. Bilder behalten ihre Vorschaubilder.

## Suchen

Das Suchfeld oben durchsucht Namen überall unterhalb des aktuellen Ordners; Treffer zeigen ihren Pfad relativ zum Ordner. Enter startet die Suche, das Leeren des Feldes führt zurück zur Auflistung. Die FreeIPA-Suche liest auch bei aktiviertem Index den aktuellen Dateisystembestand. Ein unlesbarer Unterordner bricht die Suche ab; suche dann in einem zugänglichen Ordner. Ändern sich Rechte oder verschwindet ein Treffer beim Blättern, starte die Suche erneut. Ablagen ohne Suchindex werden bei Bedarf durchsucht; enthält ein Ordner dafür zu viele Einträge, suche in einem kleineren Ordner. Die Lupe oben in der Seitenleiste öffnet die globale Cloud-Suche nur für Dateien über alle deine Ablagen; ein Treffer führt in seinen Ordner mit ausgewählter Datei.

## Auswählen und handeln

Ein Klick auf eine Datei öffnet nur ihre Details; ausgewählt ist nichts, bis du **Auswählen** neben der Eintragszahl wählst. Dann erscheinen in jeder Ansicht Kontrollkästchen: ein Klick wechselt die Auswahl eines Eintrags, Umschalt-Klick wählt einen Bereich, Strg/Cmd-A die geladene Seite, **Fertig** beendet die Auswahl. Pfeiltasten bewegen die Hervorhebung, Leertaste wechselt während der Auswahl, Escape hebt auf. Mit einer Auswahl erscheinen **n ausgewählt** und ein Menü **Aktionen** unter dem Suchfeld: herunterladen (eine Datei direkt, mehrere Einträge oder Ordner als ZIP), in neuen Ordner verschieben, in einen anderen Ordner verschieben, in diese oder eine andere Ablage kopieren, öffentlich teilen oder in den Papierkorb verschieben. Ein Rechtsklick auf eine Zeile bietet dieselben Aktionen.

Mehrfachaktionen können teilweise gelingen. Erfolgreiche Änderungen bleiben bestehen; fehlgeschlagene Einträge kannst du erneut versuchen. Verschieben bleibt innerhalb einer Ablage. Kopieren kann in eine andere kompatible Ablage zielen; die Originale bleiben erhalten. Du kannst zwischen Cloud- und FreeIPA-Ablagen kopieren, wenn du die Quelle lesen und ins Ziel schreiben darfst. Dabei gelten die Eigentümerregeln der Zielablage.

## Dokumente gemeinsam bearbeiten

Hat deine Administration Collabora Online angebunden, öffnen sich Textdokumente, Tabellen und Präsentationen (`odt`, `ods`, `odp`, `docx`, `xlsx`, `pptx`) in einem Editor, der den Hauptbereich füllt: Doppelklick auf die Datei oder **Bearbeiten** im Detailpanel. Mehrere Personen können gleichzeitig im selben Dokument arbeiten und sehen die Änderungen der anderen. Der Dokumentname steht in der oberen Leiste; Collabora zeigt, wann es zuletzt gespeichert hat, und sein Schließen-Button (X) führt zurück in den Ordner mit ausgewählter Datei. Darfst du eine Datei nur lesen, öffnet sie sich schreibgeschützt. Die Cloud prüft vor dem Speichern auf Änderungen und stimmt ihre eigenen Schreibvorgänge ab. Wurde die Datei inzwischen geändert, zeigt Collabora einen Konfliktdialog. Wähle Überschreiben nur, wenn du diese Änderungen bewusst ersetzen möchtest. Externe NFS-Schreibvorgänge lassen sich nicht vollständig koordinieren. Jedes Speichern wird zur aktuellen Datei; die Versionsgeschichte bleibt im Detailpanel. Nach einem Themewechsel öffnest du den Editor erneut, damit er das neue Theme übernimmt.

Das Plus-Menü bietet dann zusätzlich **Neues Textdokument**, **Neue Tabelle** und **Neue Präsentation**. Du gibst einen Namen ein, die Dateiendung wird ergänzt, und das neue Dokument öffnet sich im Editor.

## Hinzufügen, hochladen und ändern

Das Plus neben dem Suchfeld bietet **Hochladen**, **Ordner hochladen**, **Neuer Ordner** und **Neue Datei**. Du kannst Dateien auch von deinem Gerät auf die Liste ziehen. Jede Datei geht direkt an den Dateiserver, nachdem Cloud deinen Zugriff geprüft hat, und wird erst veröffentlicht, wenn die Übertragung vollständig ist. Der Fortschritt erscheint als Benachrichtigung mit Fortschrittsbalken. Existieren Namen bereits, entscheidest du einmal pro Upload, ob du sie ersetzt oder nur die neuen Dateien hochlädst. Ein erneuter Versuch derselben unveränderten Datei am selben Ziel nutzt die vorhandene Upload-Sitzung. Prüfe nach einem ungeklärten Ergebnis zuerst den Zustand, bevor du einen anderen Upload startest. Namen dürfen keine Schrägstriche enthalten.

Das Detailpanel eines Eintrags bietet **In neuem Tab öffnen**, **Umbenennen**, **Duplizieren**, **Verschieben nach**, **Kopieren nach**, **Öffentlich teilen** und **In den Papierkorb**. Ordner bieten zusätzlich **Als Upload-Eingang freigeben**. Der Kopieren-Button in der Kopfzeile legt eine Cloud-Referenz in die Zwischenablage, die andere Apps verstehen.

## Papierkorb

Löschen entfernt nie etwas endgültig: Einträge wandern in den Papierkorb ihrer Ablage, der als **Papierkorb** am Ende des Wurzelordners und in der Seitenleiste erscheint. Öffne ihn, um Gelöschtes zu sehen; **Wiederherstellen** legt einen Eintrag an seinen ursprünglichen Ort zurück. Fehlt der ursprüngliche Speicherort, gib einen Zielpfad einschließlich des Namens an. Vorhandene Dateien werden niemals ersetzt. Noch nicht bestätigte Verschiebungen bleiben sichtbar. Weitere Einträge erreichst du über die nächste Seite. Nur die Administration kann den Papierkorb leeren.

## Versionen

Wo die Ablage Versionen behält, listet das Detailpanel frühere Versionen einer Datei ganz unten. Zu jeder Version kannst du einen Kommentar hinterlegen, sie herunterladen, an Ort und Stelle wiederherstellen oder als neue Datei neben der aktuellen wiederherstellen. Beim Wiederherstellen als neue Datei bleiben die ursprüngliche Datei und ihre Versionsgeschichte unverändert. Nur die Administration darf Versionen endgültig löschen. Beim Wiederherstellen an Ort und Stelle bleibt der aktuelle Stand als neue Version erhalten.

## Öffentlich teilen

Wähle Einträge und **Öffentlich teilen**, oder gib einen Ordner in seinen Details als **Upload-Eingang** frei. Vergib einen Namen und wähle 1, 7, 30 oder 90 Tage oder unbegrenzte Gültigkeit. Eine interne Notiz bleibt privat; ein separater öffentlicher Hinweis erscheint für Besucher. Kopiere den Link beim Erstellen: Er wird nur einmal gezeigt und lässt sich später nicht zurückholen. Unter **Freigaben** siehst und sperrst du deine Links, auch wenn du inzwischen keinen Dateizugriff mehr hast. Die Administration kann alle Links sperren. Geänderte Zugriffsrechte verhindern neue öffentliche Aktionen; bereits ausgestellte Übertragungen können während ihrer kurzen Lease-Gültigkeit noch enden.

Download-Freigaben zeigen den aktuellen Inhalt. Besucher können geteilte Ordner öffnen, einzelne Dateien oder ein ZIP herunterladen. Änderungen und später hinzugefügte Dateien in geteilten Ordnern werden sichtbar.

Ein Upload-Eingang nimmt Dateien an, ohne Zugriff auf den Ordnerinhalt zu geben. Lege ein Limit pro Datei und ein kumulatives Gesamtlimit fest; standardmäßig gelten 100 MiB und 1 GiB. Das Löschen empfangener Dateien gibt dieses Budget nicht frei. Laufende Uploads reservieren Platz; bei ungeklärtem Ergebnis bleibt er bis zur Prüfung reserviert. Bestehende Dateien werden nie ersetzt. Standardmäßig sehen Besucher nur die Bestätigung ihres Uploads. Mit der Namensoption sehen alle mit dem Link die Namen erfolgreicher Uploads genau dieses Eingangs; andere Dateien und Downloads werden dadurch nicht zugänglich.

## Datei herunterladen

Wähle **Herunterladen** neben einer Datei. Die Cloud prüft deinen aktuellen Zugriff und bereitet einen kurzzeitig gültigen Download direkt vom Dateiserver vor. Schlägt die Vorbereitung fehl, erscheint oberhalb der Liste eine Fehlermeldung. Du kannst den Download erneut anfordern.

Wähle mehrere Einträge oder einen Ordner und nutze **Herunterladen**, um ein ZIP zu erhalten.

## Terminal verwenden

Melde dich mit `cld login --server <Cloud-URL>` an. `cld filesv2 bases list --json` zeigt deine Ablagen-IDs. Mit `cld filesv2 list <base-id> --path Documents --json` liest du einen Ordner. Enthält das Ergebnis einen `next`-Cursor, übergib ihn unverändert als `--after` für die nächste Seite.

`cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf` lädt eine Datei direkt von Filegate in eine neue lokale Datei. Bestehende Pfade werden nie überschrieben. Mit `--json` erhältst du den gespeicherten Pfad und die Byteanzahl. `cld filesv2 help` zeigt alle verfügbaren Befehle.

`cld filesv2 search <base-id> Bericht --path Dokumente --json` sucht Namen unterhalb eines Ordners und `cld filesv2 mkdir <base-id> Dokumente/2026` legt einen Ordner an. `rename`, `move --to`, `copy --to [--target-base]`, `delete`, `trash list|restore`, `versions list|comment|restore|download`, `shares list|create|revoke`, `archive --out` für ein ZIP mehrerer Einträge sowie `documents create --kind` und `edit-url` für Office-Dokumente decken die übrigen Vorgänge ab. `cld filesv2 upload <base-id> ./bericht.pdf --to Dokumente/bericht.pdf` lädt eine Datei direkt zum Dateiserver hoch; mit `--replace` ersetzt du eine bestehende Datei. `cld filesv2 stat <base-id> <path> --json` liest aktuelle Dateidetails. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` speichert eine Bildvorschau.

## Wenn eine Ablage nicht verfügbar ist

Ein leerer Ordner bedeutet etwas anderes als ein fehlendes oder nicht erreichbares Verzeichnis. Die Seite zeigt, ob ein Verzeichnis fehlt, zugeordnet werden muss oder derzeit nicht erreichbar ist. Kontaktiere die Administration, wenn ein Verzeichnis geprüft werden muss.

Cloud-Ablagen setzen aktivierte lokale Linux-Identitäten voraus. Nur POSIX-Gruppen können eine Gruppenablage haben. FreeIPA-Ablagen werden unabhängig konfiguriert; FreeIPA-Nutzer können zusätzlich auf zugängliche lokale Cloud-Gruppenablagen zugreifen.

## Markdown bearbeiten und Vorlagen nutzen

Öffne eine `.md`- oder `.markdown`-Datei im Editor über die ganze Arbeitsfläche oder wähle **Hinzufügen → Markdown-Dokument**. Das funktioniert auch ohne Office-Editor. Unterstützt werden UTF-8-Dateien bis 2 MiB. Speichere über den Editor-Button oder Strg/Cmd+S. Speichern und X stehen rechts in der Toolbar. Nach erfolgreichem Speichern erscheint kurz ein Haken; mit dem X kehrst du zum Ordner zurück. Beim Verlassen wirst du auf ungespeicherte Änderungen hingewiesen. Bei Speicherfehlern oder einer inzwischen geänderten Datei bleibt dein Entwurf erhalten: Lade die Datei neu oder speichere eine Kopie unter einem neuen Namen.

**Hinzufügen → Vorlage** zeigt die für dich verfügbaren Vorlagen. Wähle eine und einen Namen für eine unabhängige Datei im aktuellen Ordner. Dort brauchst du Schreibzugriff. Vorhandene Dateien werden niemals ersetzt. Eine Vorlage kann für dich verfügbar sein, auch wenn du ihre ursprüngliche Datei nicht öffnen darfst. Spätere Vorlagenänderungen verändern deine Kopie nicht. Wenn keine Vorlagen erscheinen, kann die Administration dir oder deinen Gruppen Nutzungsrechte geben.

Im Terminal gibt es dafür `cld filesv2 documents markdown <ablagen-id> Notizen.md`, `cld filesv2 templates list --json` und `cld filesv2 templates use <vorlagen-id> <ablagen-id> Notizen.md`. Zum bedingten Ersetzen ergänzt du `upload` um `--replace --expected-revision <revision>`; ein Konflikt lässt die aktuelle Datei unverändert.
