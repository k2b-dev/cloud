---
id: pulse-operate
title: Betrieb
icon: ti ti-lifebuoy
description: Quellenstatus, Aufbewahrung, Zugriff, öffentliche Anzeigen und häufige Probleme.
order: 140
---
Nutze diese Seite, wenn Daten fehlen, Zugriffsrechte geändert werden müssen oder eine öffentliche Anzeige nur ein bestimmtes Dashboard zeigen soll.

## Regelmäßige Prüfungen {icon="route"}

:::reference
- **Quellenstatus:** Quellen zeigen die letzten Aktualisierungen, Dauer, Fehler, empfangenen Daten und gegebenenfalls die Nutzung von API-Schlüsseln.
- **Aufbewahrung und Daten löschen:** Für detaillierte Daten, langfristige Zusammenfassungen und geschützte Ereignisfelder können unterschiedliche Aufbewahrungszeiträume gelten. Geschützte Felder können vor dem übrigen Ereignis ablaufen. Mit Alle Daten löschen bleiben Basis, Quellen, API-Schlüssel, Zugriffsrechte, Dashboards, gespeicherte Abfragen und Einstellungen erhalten, während die erfassten Daten gelöscht werden.
- **Zugriff:** Basisberechtigungen legen fest, wer eine Basis ansehen, bearbeiten oder verwalten darf. Öffentliche Dashboards sind davon getrennte, linkbasierte Leseansichten.
- **Öffentliche Anzeigen:** Alle Personen mit dem öffentlichen Link können das Dashboard und seine Ergebnisse sehen, aber nicht die Browser der Basis, Quelleneinstellungen, gespeicherten Abfragen oder API-Schlüssel. Verwende sinnvolle Standardwerte, weil Personen in öffentlichen Ansichten die Steuerelemente nicht bearbeiten können.
- **Lange destruktive Vorgänge:** Das Leeren oder Löschen einer großen Basis kann nach der Bestätigung einige Zeit dauern. Eine angenommene Anfrage bedeutet, dass der Vorgang begonnen hat, nicht dass alle Daten bereits verschwunden sind.
:::

## Daten per HTTP-Ingest senden {icon="point"}

:::reference
- **Anfragen werden vollständig oder gar nicht angenommen:** Pulse verwirft eine Anfrage, die es nicht vollständig annehmen kann, statt nur einen Teil ihrer Daten zu speichern. Teile eine abgelehnte große Anfrage auf und wiederhole jeden Teil einzeln.
- **API-Schlüssel gehören zu einer Quelle:** Pulse ordnet empfangene Signale der Quelle zu, der der API-Schlüssel gehört. Ein mit den Daten gesendeter Quellenwert ändert diese Zuordnung nicht.
- **Sicher wiederholbare Anfragen:** Sende denselben `Idempotency-Key`, wenn du einen Batch erneut sendest. Pulse gibt mindestens 24 Stunden lang das ursprüngliche Ergebnis zurück und lehnt die Wiederverwendung mit anderem Inhalt ab.
- **Metrikvarianten überschaubar halten:** Eine Metrik kann in einer Basis bis zu 10.000 Varianten haben. Lege Anfrage-IDs, Sitzungen, vollständige URLs, IP-Adressen und andere eindeutige Werte in Ereignissen statt in Metrikdimensionen ab.
:::

## Häufige Probleme {icon="lifebuoy"}

:::reference
- **Es erscheinen keine Daten:** Prüfe zuerst die Quelle. Sie muss eine erfolgreiche Aktualisierung melden, bevor Ressourcen, Signale oder Dashboards Daten anzeigen können.
- **Eine Abfrage liefert zu viele Treffer:** Öffne das Inventar oder die Signalseite und ergänze dann Filter für `source`, `entity`, `entity_type` oder `where`.
- **Ein Diagramm ist leer:** Prüfe Zeitraum und Aggregation. Zähler benötigen meist `rate` oder `increase`, Messwerte meist `avg` oder `latest`.
- **Zeilen wirken dupliziert:** Öffne die Ressourcen- oder Signalseite. Wiederholte Zeilen sind meist Varianten mit unterschiedlichen Ressourcen oder Dimensionen.
- **Eine Metrik hat zu viele Varianten:** Prüfe ihre Dimensionen. Behalte stabile Gruppierungsmerkmale und verschiebe eindeutige Identitäten oder Ereignisdetails in Identitätsfelder, Attribute, vertrauliche Felder oder die Payload eines Ereignisses.
:::
