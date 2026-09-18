---
id: filesv2-start
title: Dateien ansehen und herunterladen
icon: ti ti-folders
description: Persönliche Ablagen und Gruppenablagen öffnen und einzelne Dateien herunterladen.
order: 100
---

Files v2 zeigt deine zugänglichen Cloud- und FreeIPA-Verzeichnisse in einer Oberfläche. Die Kennzeichnung neben dem Namen einer Ablage zeigt ihre Herkunft.

## Ordner öffnen

Wähle eine Ablage in der Workspace-Seitenleiste und öffne einen Ordner per Doppelklick oder über seine Aktion **Öffnen**. Auf dem Smartphone findest du die Ablagen im Cloud-Menü. Über den Ordnerpfad oberhalb der Liste gelangst du zu übergeordneten Ordnern. **Nächste Seite** zeigt weitere Einträge; **Erste Seite** öffnet den Anfang des aktuellen Ordners. Ablage, Ordner und Seite bleiben in der Adresse erhalten und können neu geladen oder als Lesezeichen gespeichert werden.

**Aktualisieren** liest den aktuellen Dateisystembestand erneut ein. Das erfasst auch außerhalb der Cloud angelegte Verzeichnisse und Dateien.

## Auswählen und Vorschau öffnen

Wechsle über die Ansichtssteuerung zwischen **Liste** und **Grid**. Unter **Darstellungsoptionen** änderst du die Listendichte oder Vorschaugröße. Der Browser merkt sich diese Einstellungen.

Ein Klick wählt einen Eintrag aus und zeigt seine Details mit verfügbarer Vorschau. Doppelklick oder Enter öffnet eine größere Vorschau. Auf Touchscreens öffnet ein Antippen den Eintrag; nutze **Einträge auswählen** oder die Kontrollkästchen für eine Auswahl.

Mit Strg/Cmd-Klick ergänzt du Einträge, mit Shift-Klick wählst du einen Bereich aus. Die Pfeiltasten bewegen sich durch Liste und Grid, die Leertaste schaltet die Auswahl um und Escape hebt sie auf. Strg/Cmd-A wählt die aktuelle Seite aus. Ein Ordner- oder Seitenwechsel hebt die Auswahl auf. Ein einzelner ausgewählter Eintrag bleibt zum Verlinken in der Adresse erhalten.

Das Detailpanel öffnet sich neben der Liste und zeigt den vollständigen Namen, Pfad, Änderungszeitpunkt, die Größe und den Dateibereich. **Details schließen** schließt es und hebt die Auswahl auf. Dateien ohne Vorschau kannst du herunterladen. Bei einer fehlgeschlagenen Vorschau hilft **Erneut versuchen**. Ordnerinhalte werden bei der gemeinsamen Dateigröße nicht mitgezählt.

## Datei herunterladen

Wähle **Herunterladen** neben einer Datei. Die Cloud prüft deinen aktuellen Zugriff und bereitet einen kurzzeitig gültigen Download direkt vom Dateiserver vor. Schlägt die Vorbereitung fehl, erscheint oberhalb der Liste eine Fehlermeldung. Du kannst den Download erneut anfordern.

Wähle mehrere einzelne Dateien aus und nutze **Herunterladen**. Dein Browser fragt möglicherweise nach der Erlaubnis für mehrere Downloads. Öffne Ordner, um ihre einzelnen Dateien herunterzuladen.

## Terminal verwenden

Melde dich mit `cld login --server <Cloud-URL>` an. `cld filesv2 bases list --json` zeigt deine Ablagen-IDs. Mit `cld filesv2 list <base-id> --path Documents --json` liest du einen Ordner. Enthält das Ergebnis einen `next`-Cursor, übergib ihn unverändert als `--after` für die nächste Seite.

`cld filesv2 download <base-id> Documents/report.pdf --out ./report.pdf` lädt eine Datei direkt von Filegate in eine neue lokale Datei. Bestehende Pfade werden nie überschrieben. Mit `--json` erhältst du den gespeicherten Pfad und die Byteanzahl. `cld filesv2 help` zeigt alle verfügbaren Befehle.

`cld filesv2 stat <base-id> <path> --json` liest aktuelle Dateidetails. `cld filesv2 thumbnail <base-id> Photos/team.jpg --out ./team.png` speichert eine Bildvorschau.

## Wenn eine Ablage nicht verfügbar ist

Ein leerer Ordner bedeutet etwas anderes als ein fehlendes oder nicht erreichbares Verzeichnis. Die Seite zeigt, ob ein Verzeichnis fehlt, zugeordnet werden muss oder derzeit nicht erreichbar ist. Kontaktiere die Administration, wenn ein Verzeichnis geprüft werden muss.

Cloud-Ablagen setzen aktivierte lokale Linux-Identitäten voraus. Nur POSIX-Gruppen können eine Gruppenablage haben. FreeIPA-Ablagen werden unabhängig konfiguriert; FreeIPA-Nutzer können zusätzlich auf zugängliche lokale Cloud-Gruppenablagen zugreifen.
