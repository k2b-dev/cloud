---
id: grids-forms
title: Formulare
icon: ti ti-forms
description: Erstelle gezielte, validierte Abläufe zur Eingabe von Datensätzen.
order: 130
---
Ein Formular validiert Datensätze und schreibt sie in eine Tabelle. Nutze für Abläufe mit mehreren Seiten eine Grids App.

Vor dem Absenden prüft der Browser Pflichtangaben, Werteformate und konfigurierte Feldgrenzen. Fehler erscheinen direkt an den Eingaben. Sendest du mit einem Fehler ab, erhält das erste fehlerhafte Feld den Fokus, und das Formular sendet keine Anfrage. Danach aktualisieren sich die Fehler, während du die Werte korrigierst. Der Server prüft trotzdem jede Übermittlung, einschließlich Zugriff und Verweisen auf andere Datensätze.

Zahleneingaben zeigen keine bedeutungslosen Nullen am Ende: `1.0000` erscheint als `1`. Dezimalmengen und exakte Dezimalwerte bleiben möglich. Der Text, den du eingibst, bleibt erhalten, bis du das Feld verlässt.

Ein Formular warnt vor dem Verlassen der Seite, solange es ungespeicherte Änderungen hat oder noch sendet.

**Berechnete Werte** zeigt bis zu 20 schreibgeschützte Formeln aus sichtbaren Eingaben. Beschriftungen erlauben 200 Zeichen, Hinweise 2.000. Unvollständige Werte zeigen einen Strich. Leere Listen blenden die Zusammenfassung aus. Fehler bleiben sichtbar.

**Feldbreite** setzt `width: "fullWidth"` (Standard) oder `"compact"` an `user_input`, `computedFields`, `inlineCreate.fields` und Spalten von Objektlisten. Aufeinanderfolgende kompakte Felder teilen sich den Platz und umbrechen der Reihe nach. Ein Feld mit voller Breite beginnt eine neue Zeile. Objektlisten-Tabellen verteilen mit den Breiten den Platz zwischen ihren Eingaben. Der Eintragsdialog verwendet das Formularlayout. `detailsOnly`-Berechnungen erscheinen im Eintragsdialog.

Bei Spalten von Objektlisten schlägt **Regeln und Berechnung → Standardwert** einen Wert nur vor, wenn jemand einen Eintrag hinzufügt. Vorhandene Werte bleiben unverändert. Setze dafür in der Konfiguration einen festen `defaultValue` an der Spalte. Auswahlspalten verwenden Options-IDs. Der Wert muss die Regeln der Spalte erfüllen. Berechnete Spalten haben keine Standardwerte. API-Schreibvorgänge ergänzen fehlende Zellen nicht aus diesen Vorschlägen.

## Objektlisten bearbeiten {icon="table"}

Objektlisten zeigen kompakte Zeilen. Beim Wechsel zur Bearbeitung bleiben Zeilenhöhen und Spaltenbreiten gleich. Lange Anzeigewerte werden gekürzt. Öffne den Eintragseditor, um sie vollständig zu lesen. Fehlermeldungen stehen unter der Tabelle und nennen Eintrag und Feld.

- Wähle einen Wert, um seine Zeile zu bearbeiten. Ein neuer Eintrag öffnet sich direkt zur Eingabe.
- **Tab** wechselt zwischen Feldern und Zeilen.
- In einzeiligen Text- und Zahleneingaben:
  - **Enter** schließt die Zeile ab.
  - **Escape** setzt die Änderungen der Zeile zurück.
  - **Strg+Enter** oder **Cmd+Enter** fügt einen weiteren Eintrag hinzu.

Reicht der Platz nicht aus, wähle die Zusammenfassung eines Eintrags, um seinen Editor zu öffnen. Einfache Textlisten bleiben auch auf dem Handy direkt bearbeitbar. **Eintrag bearbeiten** öffnet außerdem lange Texte, Mehrfachauswahl, Zusatzangaben und die Aktionen zum Verschieben oder Entfernen des Eintrags.

- **Übernehmen** führt zurück zum Formular.
- **Übernehmen & weitere** setzt die Eingabe fort.
- **Abbrechen** verwirft nur die Änderungen an diesem Eintrag.

Grids speichert alle Einträge gemeinsam mit dem Formular.

## Ein gezieltes Formular erstellen {icon="forms"}

Jede Tabelle hat ein virtuelles Standardformular. Ein eigenes Formular steuert Eingaben, Beschriftungen, Hinweise, Standardwerte und öffentlichen Zugriff.

**Erstellen** speichert ein neues eigenes Formular sofort und öffnet seinen Editor. Passe es an und wähle **Speichern**, oder wähle **Fertig**, um es so zu behalten, wie es erstellt wurde.

Ein Datumsfeld mit dem Standard `{"kind":"now"}` wird beim Öffnen eines Erstellformulars in deiner Datumszeitzone ausgefüllt. Prüfe den Wert vor dem Speichern. Beim Bearbeiten eines Datensatzes bleiben gespeicherte Datumswerte erhalten.

In einem eigenen Formular kannst du:

- Titel, Beschreibung, Titelbild, Beschriftung der Senden-Schaltfläche und Erfolgsmeldung festlegen;
- Eingaben anordnen und erklären, was jede Antwort bedeutet;
- festlegen, dass eine kompatible Zahlen-, Dauer-, Datums- oder Datum-Uhrzeit-Eingabe vor, nach, gleich oder ungleich einer anderen Eingabe sein muss;
- verborgene Werte anwenden, die die absendende Person nicht ändern kann, zum Beispiel einen festen Anfragestatus;
- konfigurierten Relationsfeldern erlauben, verknüpfte Datensätze direkt zu erstellen;
- nach erfolgreichem Absenden weiterleiten;
- Eingaben mit dem Schalter **Aktiv** pausieren, ohne das Formular zu löschen.

Eine angemeldete Person mit Zugriff **Bearbeiten** auf die Base kann ein Formular absenden. Eine enger begrenzte angemeldete Zielgruppe kann nur über eine Grids App absenden, die das Formular ausdrücklich enthält. Das öffentliche Token bleibt der eigene Weg für anonyme Eingaben.

Aktiviere **Öffentlich** nur, wenn du anonyme Eingaben willst. Die eindeutige URL eines öffentlichen Formulars akzeptiert nur die konfigurierten Felder des Formulars und wendet immer seine verborgenen Werte an.

:::warning Das Ausschalten des öffentlichen Zugriffs macht den Link ungültig
Schaltest du den öffentlichen Zugriff aus, funktioniert der vorhandene Link nicht mehr. Schaltest du ihn wieder ein, erstellt Grids einen neuen Link.
:::

Prüfe vor dem Teilen ungültige Eingaben, Pflichtfelder, das Erstellen verknüpfter Datensätze, den Erfolgstext und Weiterleitungen.

Eine feldübergreifende Validierung gehört ins Formular, wenn zwei Antworten übereinstimmen müssen, bevor Grids einen Datensatz erstellt. Lege zum Beispiel fest, dass **Startdatum** am oder vor dem **Fälligkeitsdatum** liegt. Der Browser erklärt eine verletzte Regel an ihrem Feld, und der Server prüft dieselbe Regel erneut. Nutze stattdessen einen Workflow, wenn die Validierung von anderen Datensätzen, der aktuellen Kapazität, dem Zugriff oder gleichzeitig veränderlichen Auswirkungen abhängt.

## Ein Formular in einer Grids App wiederverwenden {icon="app-window"}

Eine Grids App kann ein vorhandenes aktives Formular als Block zeigen. Das Formular behält seine Eingaben und seine Validierung. Die App kann:

- feste Relationswerte aus deklarierten Seitenparametern ergänzen;
- die aktuell angemeldete Person einem Principal-Feld zuweisen;
- nach erfolgreichem Absenden eine andere Seite öffnen.

Anzeigen und Absenden prüfen die veröffentlichte Capability und `availableWhen`. Inaktive oder nicht deklarierte Formulare bleiben nicht verfügbar.

Wähle **Datensatz dieser Seite bearbeiten** für ein Formular auf einer passenden Datensatzseite. Personen können dann einen bestehenden Entwurf zusammen mit seinen konfigurierten verknüpften Eingaben ändern. Erstellen bleibt der Standard. Öffentliche Links und globale Formulare der Seitenleiste erstellen immer. Das Bearbeiten bestehender verknüpfter Datensätze erfordert exklusive Verknüpfungen zu diesem übergeordneten Datensatz in derselben Base. Das Entfernen einer verknüpften Zeile löst die Verknüpfung und löscht nichts. Finalisierte Datensätze bleiben schreibgeschützt.

Das Speichern prüft Versionen und speichert verknüpfte Änderungen gemeinsam. Versuche es nach einem Verbindungsfehler im offenen Dialog erneut. Lade nach einem Versionskonflikt neu und prüfe die Daten vor dem Speichern. Die [API-Referenz](/app/grids/help/grids-custom-app-api) beschreibt Versionen, Idempotenzschlüssel, Payloads und Grenzen für CLI und API.

## Formulare über CLI oder API konfigurieren {icon="code"}

Die Formular-`config` verwendet diese Schlüssel. Öffentliche APIs akzeptieren öffentliche Feld-IDs, keine internen UUIDs.

| Schlüssel | Bedeutung |
| --- | --- |
| `title`, `description` | Optionaler Text über den Eingaben |
| `fields` | Geordnete Einträge für Eingaben und verborgene Werte; jedes Feld nur einmal |
| `computedFields` | Bis 20 schreibgeschützte Zusammenfassungen: `{fieldId, label?, helpText?, width?}`; Beschriftung bis 200, Hinweis bis 2.000 Zeichen |
| `validations` | Bis 20 feldübergreifende Regeln, siehe unten |
| `submitLabel`, `successMessage` | Optionaler Aktions- und Erfolgstext |
| `redirectUrl` | Optionales Ziel nach erfolgreicher Übermittlung; null bedeutet keine Weiterleitung |
| `titleImage` | Optionale Bild-Data-URL, höchstens 1.000.000 Zeichen |

Ein sichtbarer Eintrag lautet `{kind:"user_input", fieldId, label?, helpText?, required?, defaultValue?, width?, inlineCreate?, relationFilter?}`. Ein verborgener Eintrag lautet `{kind:"form_value", fieldId, value}`. Der Server setzt diesen festen Wert und vertraut dafür keinen mitgesendeten Daten.

Eine Regel lautet `{leftFieldId, operator, rightFieldId, message, errorFieldId?}`. Die Operatoren sind `eq`, `neq`, `lt`, `lte`, `gt` und `gte`. Die Meldung hat 1–240 Zeichen. Vergleiche kompatible Zahlen-, Dauer- oder Datumseingaben. `errorFieldId` bestimmt das Feld, das den Fehler zeigt. Für zwei Relationsfelder verlangt `anyPresent` mindestens eine Auswahl in einem der beiden Felder. Der Formulareditor bietet diese Regel an. Browser und Server zeigen dieselbe konfigurierte Meldung.

### Die Auswahl eines Relationsfelds filtern

Für ein Relationsfeld akzeptiert `relationFilter` den vorhandenen Filterbaum für Datensätze, beschränkt auf Felder seiner Zieltabelle. Kombiniere zum Beispiel `{fieldId:"PUBLIC",op:"=",value:true}` und `{fieldId:"STATUS",op:"is",value:"available"}` unter `{op:"AND",filters:[...]}`. Ersetze diese Beispiel-IDs durch die öffentlichen IDs der Zielfelder.

Konfiguriere Auswahlfilter über die API oder eine Vorlage. Der Formulareditor behält sie, hat aber keinen Filtereditor. Ein gefiltertes Feld braucht eine gespeicherte Zieltabelle in derselben Base und kann `inlineCreate` nicht aktivieren. Seine Auswahl liefert nur passende Bezeichnungen. Beim Absenden prüft Grids jeden ausgewählten Datensatz unter einer Sperre erneut. Eine Auswahl, die gelöscht, vom Filter ausgeschlossen oder nicht mehr verfügbar ist, lehnt die ganze Übermittlung ab. Eine Auswahl reserviert nichts. Nutze für eine Reservierung oder Übergabe einen Workflow.

Der Filter gilt in einer veröffentlichten Grids App, im angemeldeten Base-Formular und im Formular mit aktivem öffentlichem Token. Ein öffentliches Token zeigt deshalb die Anzeigebezeichnungen der passenden Datensätze.

:::warning Ein öffentliches Token zeigt passende Bezeichnungen
Aktiviere öffentlichen Zugriff nur, wenn alle mit dem Link diese Bezeichnungen sehen dürfen.
:::

Der vorhandene Zugriff auf das Formular reicht aus. Grids gibt keinen Zugriff auf die Zieltabelle. Änderst du den Filter oder die Konfiguration eines Felds, auf das er verweist, musst du eine betroffene Grids App erneut veröffentlichen. Eine Vorschau ohne autorisierte Suche deaktiviert die gefilterte Auswahl.

Gefilterte Auswahlen verwenden `GET /api/grids/forms/:formId/relations/:fieldId/lookup` mit Zugriff **Bearbeiten** auf die Base oder `/api/grids/forms/public/:token/relations/:fieldId/lookup` mit einem aktiven öffentlichen Token. Die Parameter sind `_search` (bis 200 Zeichen), `_limit` (1–50, Standard 10) und `_exclude` (kommagetrennte öffentliche Datensatz-IDs, höchstens 1.000). Die Antwort ist `{items:[{id,label}]}`. Grids Apps verwenden ihren vorhandenen veröffentlichten Formular-Endpunkt.

### Verknüpfte Datensätze direkt erstellen

Bei einem geeigneten Relationsfeld wählt `inlineCreate: {enabled:true, fields:[...]}` die Eingaben der Zieltabelle. Jeder Eintrag hat `fieldId` und optional `label`, `helpText`, `width`, `required` und `defaultValue`. Die direkte Erstellung ist eine Ebene tief. Sie kann keine weiteren Relationen verschachteln, keine Dateifelder hochladen und keine System- oder berechneten Werte annehmen.

### Standardwerte sicher verwenden

Formularstandards schlagen Anfangsantworten vor. Standards für Spalten von Objektlisten schlagen Werte für neu hinzugefügte Zellen vor. Beides ist keine Zugriffsregel und ersetzt keine verborgenen Werte. Setze sichere Erleichterungen wie Menge 1. Erfinde keinen Preis, kein Bankkonto, keine Zahlungsbestätigung und keine Genehmigung.

Gespeicherte Feldstandards und alle skalaren Optionen beschreibt [Feldkonfiguration nachschlagen](/app/grids/help/grids-field-configuration). Payloads veröffentlichter Apps, optimistische Versionen und die Zuweisung der aktuellen Person beschreibt die [Custom-App-API-Referenz](/app/grids/help/grids-custom-app-api).
