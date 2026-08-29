---
id: grids-forms
title: Formulare
icon: ti ti-forms
description: Gezielte und validierte Abläufe zur Dateneingabe erstellen.
order: 130
---
Formulare vereinfachen das Hinzufügen von Datensätzen zu einer Basis. Sie bündeln Bezeichnungen, Hinweise, Pflichtfelder, Standardwerte und die Behandlung von Relationen in einem wiederverwendbaren Eingabeablauf.

Formulare ersetzen keine Tabellen. Sie validieren Datensätze und schreiben sie in eine Tabelle. Nutze eine Grids App, wenn eine Aufgabe mehrere Seiten, Daten, Anweisungen und Aktionen rund um ein oder mehrere Formulare benötigt.

## Ein gezieltes Formular erstellen {icon="forms"}

Jede Tabelle besitzt ein virtuelles Standardformular, das auf ihren Feldern basiert. Erstelle ein eigenes Formular, wenn Personen andere Bezeichnungen, Hilfetexte, Pflichtfelder, Standardwerte, eine kleinere Feldauswahl oder einen kontrollierten öffentlichen Link benötigen.

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

Teste ein Formular mit unvollständigen und ungültigen Eingaben, bevor du es teilst. Prüfe, ob Pflichtfelder, das Erstellen verknüpfter Datensätze, Erfolgstext und Weiterleitung ohne Kenntnisse über die Tabelle verständlich sind.

Die feldübergreifende Validierung gehört in das Formular, wenn zwei Antworten übereinstimmen müssen, bevor ein Datensatz erstellt werden darf. Lege zum Beispiel fest, dass **Startdatum** am oder vor dem **Fälligkeitsdatum** liegen muss. Der Browser erklärt eine verletzte Regel am zugehörigen Feld; der Server prüft dieselbe Regel erneut. Nutze stattdessen einen Workflow, wenn die Validierung von anderen Datensätzen, der aktuellen Kapazität, Berechtigungen oder nebenläufig veränderlichen Auswirkungen abhängt.

## Ein Formular in einer Grids App wiederverwenden {icon="app-window"}

Eine Grids App kann ein vorhandenes aktives Formular als Block darstellen. Das Formular bleibt für seine Eingaben und Validierung verantwortlich. Die App kann feste Relationswerte aus deklarierten Seitenparametern ergänzen, die aktuell angemeldete Person einem Principal-Eingabefeld zuweisen und nach erfolgreichem Absenden zu einer anderen Seite wechseln.

Nutze diese Zusammensetzung, wenn Personen vor der Eingabe Kontext benötigen, wiederholt weitere Einträge hinzufügen oder nach dem Erstellen eine Detailseite öffnen sollen. Halte das Formular eigenständig nutzbar und lege die Navigation über mehrere Seiten in der Grids App fest.

Die veröffentlichte Capability und die optionale `availableWhen`-Abfrage des Formularblocks werden sowohl beim Darstellen als auch beim Absenden der App geprüft. Der App-Zugriff macht ein inaktives oder nicht deklariertes Formular nicht zu einem beschreibbaren Endpunkt.
