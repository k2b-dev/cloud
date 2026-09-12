# Lokale Auslagenerstattungs-Demo

Stand: 11. September 2026. Privat veröffentlicht und über die App-API getestet.

## Ausprobieren

- [App öffnen](http://localhost:3000/apps/x6jZju)
- [Freigegebenes Beispiel](http://localhost:3000/apps/x6jZju/antrag?request_id=n4DQk3)
- [Entwurf zum Bearbeiten](http://localhost:3000/apps/x6jZju/antrag?request_id=BBfkmZ)
- [Neuen Antrag erstellen](http://localhost:3000/apps/x6jZju/neu)
- [Zahlungsübersicht](http://localhost:3000/apps/x6jZju/zahlungen)
- [Base verwalten](http://localhost:3000/app/grids/JcBCY7)

Die veröffentlichte Definition steht in `app.json`. Tabellen: Kostenstellen (`AuCwGm`), Erstattungen (`csW4Zu`) und vorbereitete, noch leere Auszahlungen (`nX6686`).

## Ablauf

Erstellen → Ausgaben, Belege und Kontodaten ergänzen → einreichen → Kostenstellenfreigabe → abschließende Freigabe. Eine Rückgabe vor der abschließenden Freigabe entfernt die Freigabemarker und erlaubt wieder Änderungen.

Gemeinsame Seiten filtern anhand der Principal-Zuständigkeiten der Kostenstelle. Die beiden Freigabefelder werden serverseitig an den handelnden Nutzer gebunden. Der gesetzte Principal ist zugleich Freigabemarker und Anzeige der bestätigenden Person.

## Geprüft

- Tatsächliche App-Endpunkte: Erstellen, Bearbeiten, Beleg-Upload, Einreichen, beide Freigaben und Rückgabe.
- Manipulierter Freigabenutzer: abgewiesen (400). Veraltete Bearbeitung: abgewiesen (409).
- Upload nach Einreichung, erneute abschließende Freigabe und Einreichen eines unvollständigen Entwurfs: nicht verfügbar (404).
- Exakte Dezimalwerte in der Ausgabenliste und berechnete Gesamtsumme.
- 135 Resolver-Tests, 31 Vertrags-Tests, 13 Postgres-Integrationstests erfolgreich; zusätzlich 63 fokussierte Tests inklusive Hilfe-Katalog erfolgreich. Diese Läufe überschneiden sich.
- Grids-Typecheck, Biome für die zehn geänderten TypeScript-Dateien und git diff --check erfolgreich. Nur Grids neu gestartet.

## Demo-Grenzen

Nur der lokale Ersteller hat Zugriff auf die App und spielt alle drei Rollen. Keine echten Gruppen oder fremden Bases verändert. Getrennte Nutzer und Rollenisolierung müssen vor realem Einsatz geprüft werden; kein Nachweis eines personell getrennten Vier-Augen-Prinzips.

Beleg und Kontodaten sind fiktiv. Keine Überweisung, IBAN-Validierung, verbundene Auszahlungserfassung oder Bankdatei. Die Zahlungsübersicht dient nur der Vorbereitung.

Abgeschlossene Anträge sind über die App nicht mehr bearbeitbar. Das ist keine native finale Festschreibung: Base-Administratoren können Daten weiterhin verändern. Der Auswahlstatus beschreibt die Einreichung; die Principal-Felder zeigen den Freigabestand.

Keine separate Browser-Abnahme und keine neuen Commits für diesen Aufbau.
