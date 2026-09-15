---
id: grids-forms
title: Formulare
icon: ti ti-forms
description: Gezielte und validierte Abläufe zur Dateneingabe erstellen.
order: 130
---
Ungespeicherte oder sendende Formulare warnen beim Verlassen der Seite.
Formulare validieren und schreiben Datensätze in eine Tabelle. Nutze eine Grids App für mehrseitige Abläufe.

**Berechnete Werte** zeigt bis zu 20 schreibgeschützte Formeln aus sichtbaren Eingaben. Beschriftungen erlauben 200 Zeichen, Hinweise 2.000. Unvollständige Werte zeigen einen Strich; leere Listen verbergen die Zusammenfassung. Fehler bleiben sichtbar.

**Feldbreite** setzt `width: "fullWidth"` (Standard) oder `"compact"` an `user_input`, `computedFields`, `inlineCreate.fields` und Objektlisten-Unterspalten. Aufeinanderfolgende kompakte Felder teilen Platz und umbrechen in Reihenfolge; volle Breite beginnt eine ganze Zeile. Das gilt auch für berechnete Spalten. `detailsOnly`-Berechnungen erscheinen auf Nachfrage, nur bei vorhandenen Zeilen.

Bei Objektlisten schlägt **Regeln und Berechnung → Standardwert** einen Wert nur beim Hinzufügen eines Eintrags vor. Vorhandene Werte bleiben unverändert. In der Konfiguration steht dafür ein fester `defaultValue` an der Unterspalte; Auswahlwerte verwenden Options-IDs. Der Wert muss die Spaltenregeln erfüllen. Berechnete Spalten haben keine Standardwerte. API-Schreibzugriffe ergänzen fehlende Zellen nicht aus diesen Vorschlägen.

## Ein gezieltes Formular erstellen {icon="forms"}

Jede Tabelle hat ein virtuelles Standardformular. Eigene Formulare steuern Eingaben, Beschriftungen, Hinweise, Standardwerte und öffentlichen Zugriff.

Der Datumsstandard `{"kind":"now"}` erscheint beim Öffnen eines Erstellformulars in deiner Datumszeitzone. Prüfe ihn vor dem Speichern. Bearbeiten behält gespeicherte Datumswerte bei.

In einem eigenen Formular kannst du:

- Titel, Beschreibung, Titelbild, Beschriftung der Senden-Schaltfläche und Erfolgsmeldung festlegen;
- Eingaben anordnen und erklären, was die einzelnen Antworten bedeuten;
- für eine kompatible Zahlen-, Dauer-, Datums- oder Datum-Uhrzeit-Eingabe festlegen, dass sie vor, nach, gleich oder ungleich einer anderen Eingabe sein muss;
- verborgene Werte anwenden, die die absendende Person nicht ändern kann, zum Beispiel einen festen Anfragestatus;
- für konfigurierte Relationsfelder das direkte Erstellen verknüpfter Datensätze erlauben;
- nach erfolgreichem Absenden weiterleiten;
- Eingaben pausieren, ohne das Formular zu löschen.

Eine angemeldete Person mit Schreibzugriff auf die Basis kann das Formular absenden. Eine enger begrenzte angemeldete Zielgruppe kann nur über eine Grids App absenden, die das Formular ausdrücklich enthält. Der öffentliche Token bleibt der eigenständige Weg für anonyme Eingaben.

Aktiviere **Öffentliches Formular** nur, wenn anonyme Eingaben vorgesehen sind. Die eindeutige öffentliche URL akzeptiert ausschließlich die konfigurierten Felder des Formulars und wendet immer seine verborgenen Werte an. Wenn du den öffentlichen Zugriff deaktivierst, wird der vorhandene Link ungültig. Beim erneuten Aktivieren entsteht ein neuer Link.

Prüfe vor dem Teilen ungültige Eingaben, Pflichtfelder, verknüpfte Datensätze, Erfolgstext und Weiterleitung.

Die feldübergreifende Validierung gehört in das Formular, wenn zwei Antworten übereinstimmen müssen, bevor ein Datensatz erstellt werden darf. Lege zum Beispiel fest, dass **Startdatum** am oder vor dem **Fälligkeitsdatum** liegen muss. Der Browser erklärt eine verletzte Regel am zugehörigen Feld; der Server prüft dieselbe Regel erneut. Nutze stattdessen einen Workflow, wenn die Validierung von anderen Datensätzen, der aktuellen Kapazität, Berechtigungen oder nebenläufig veränderlichen Auswirkungen abhängt.

## Ein Formular in einer Grids App wiederverwenden {icon="app-window"}

Eine Grids App kann ein vorhandenes aktives Formular als Block darstellen. Das Formular bleibt für seine Eingaben und Validierung verantwortlich. Die App kann feste Relationswerte aus deklarierten Seitenparametern ergänzen, die aktuell angemeldete Person einem Principal-Eingabefeld zuweisen und nach erfolgreichem Absenden zu einer anderen Seite wechseln.

Darstellung und Absenden prüfen die veröffentlichte Capability und `availableWhen`. Inaktive oder nicht deklarierte Formulare bleiben gesperrt.

Wähle **Datensatz dieser Seite bearbeiten** für ein Formular auf einer passenden Datensatzseite, um einen bestehenden Entwurf mit seinen konfigurierten verknüpften Eingaben gemeinsam zu ändern. Anlegen bleibt der Standard; öffentliche Links und globale Seitenleistenformulare legen immer neue Datensätze an. Bestehende verknüpfte Änderungen benötigen exklusive Verbindungen zu diesem Eltern-Datensatz innerhalb derselben Base. Das Entfernen einer Zeile löst die Verknüpfung, löscht aber keinen Kinddatensatz. Finalisierte Datensätze bleiben schreibgeschützt.

Speichern prüft Versionen und übernimmt verknüpfte Änderungen gemeinsam. Verbindungsfehler im offenen Dialog erneut versuchen; bei Versionskonflikten neu laden und vor dem Speichern prüfen. CLI/API-Versionen, Idempotenzschlüssel, Payloads und Grenzen stehen in der [API-Referenz](/app/grids/help/grids-custom-app-api).
