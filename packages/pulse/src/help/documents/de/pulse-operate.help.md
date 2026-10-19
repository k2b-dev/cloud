---
id: pulse-operate
title: Basis betreiben
icon: ti ti-lifebuoy
description: Prüfe Quellenstatus, Aufbewahrung, Zugriff und öffentliche Ansichten, sende Daten per HTTP-Datenaufnahme und behebe häufige Probleme.
order: 140
---
Nutze diese Seite, wenn Daten fehlen, wenn sich der Zugriff ändern muss oder wenn eine öffentliche Ansicht nur ein Dashboard zeigen soll.

## Datenspeicher verbinden (Cloud-Admins) {icon="database"}

Öffne **Administration → Pulse → Datenspeicher**. Der Betreiber stellt eine
eigene ClickHouse-Instanz ab Version 26.9 bereit. Wähle das Dienst-Passwort,
hole das **Einrichtungs-Skript** und lass es einmal vom ClickHouse-Admin
ausführen. Trage dann Adresse, Dienst-Zugang und Passwort ein und wähle
**Prüfen und verbinden**. Pulse speichert erst nach erfolgreicher Prüfung.
Eine fehlgeschlagene Prüfung nennt den Grund und die Korrektur; die
gespeicherte Verbindung bleibt dann unverändert.

Derselbe Ablauf steht über `cld pulse admin store` bereit. Übergib Passwörter
nur mit `--password-file` oder `--password-stdin`. Bestehende Funktionen laufen
in dieser Version auch ohne Verbindung weiter; spätere Versionen benötigen sie.

## Basis regelmäßig prüfen {icon="route"}

:::reference
- **Quellenstatus:** **Quellen** zeigen die letzten Aktualisierungen, Dauer, Fehler, empfangenen Daten und gegebenenfalls die Nutzung von API-Schlüsseln.
- **Zugriff:** Der Zugriff auf eine Basis legt fest, wer sie ansehen, bearbeiten oder verwalten kann. Öffentliche Dashboards sind davon getrennte Leseansichten hinter einem Link.
- **Öffentliche Ansichten:** Alle Personen mit dem öffentlichen Link können das Dashboard und seine Ergebnisse sehen. Die Browser der Basis, Quelleneinstellungen, gespeicherten Abfragen und API-Schlüssel sehen sie nicht. Wähle sinnvolle Standardwerte, weil Personen in öffentlichen Ansichten die Steuerelemente nicht bearbeiten können.
- **Aufbewahrung:** Pulse kann detaillierte Daten, langfristige Zusammenfassungen und geschützte Ereignisfelder unterschiedlich lange aufbewahren. Geschützte Felder können vor dem übrigen Ereignis ablaufen.
- **Daten löschen:** **Telemetriedaten löschen** verwirft die erfassten Daten. Basis, Quellen, API-Schlüssel, Zugriff, Dashboards, gespeicherte Abfragen und Einstellungen bleiben erhalten.
- **Lange destruktive Vorgänge:** Das Leeren oder Löschen einer großen Basis kann nach deiner Bestätigung einige Zeit dauern. Eine angenommene Anfrage bedeutet, dass der Vorgang begonnen hat, nicht dass alle Daten bereits verschwunden sind.
:::

## Daten per HTTP-Datenaufnahme senden {icon="point"}

:::reference
- **Anfragen werden vollständig oder gar nicht angenommen:** Pulse lehnt eine Anfrage ab, die es nicht vollständig annehmen kann, statt nur einen Teil ihrer Daten zu speichern. Teile eine abgelehnte große Anfrage auf und wiederhole jeden Teil einzeln.
- **API-Schlüssel gehören zu einer Quelle:** Pulse ordnet empfangene Signale der Quelle zu, der der API-Schlüssel gehört. Ein mit den Daten gesendeter Quellenwert ändert diese Zuordnung nicht.
- **Sicher wiederholbare Anfragen:** Sende denselben `Idempotency-Key`, wenn du einen Batch erneut sendest. Pulse gibt mindestens 24 Stunden lang das ursprüngliche Ergebnis zurück und lehnt die Wiederverwendung mit anderem Inhalt ab.
- **Metrikvarianten überschaubar halten:** Eine Metrik kann in einer Basis bis zu 10.000 Varianten haben. Lege Anfrage-IDs, Sitzungen, vollständige URLs, IP-Adressen und andere eindeutige Werte in Ereignissen ab, nicht in Metrikdimensionen.
:::

## Häufige Probleme beheben {icon="lifebuoy"}

:::reference
- **Eine Metrikquelle wird abgelehnt:** Pulse ruft standardmäßig nur öffentliche Endpunkte ab. Ein Betreiber kann das interne Ziel mit `PULSE_SCRAPE_ALLOWED_TARGETS` freigeben. Versuche den Abruf danach erneut.
- **Es erscheinen keine Daten:** Prüfe zuerst die Quelle. Sie muss eine erfolgreiche Aktualisierung melden, bevor Ressourcen, Signale oder Dashboards Daten anzeigen können.
- **Eine Abfrage liefert zu viele Treffer:** Öffne das **Inventar** oder die Signalseite. Ergänze dann Filter für `source`, `resource`, `resource_type` oder `where`.
- **Ein Diagramm ist leer:** Prüfe Zeitraum und Aggregation. Zähler brauchen meist `rate` oder `increase`. Messwerte brauchen meist `avg` oder `latest`.
- **Zeilen wirken dupliziert:** Öffne die Ressourcen- oder Signalseite. Wiederholte Zeilen sind meist Varianten mit unterschiedlichen Ressourcen oder Dimensionen.
- **Eine Metrik hat zu viele Varianten:** Prüfe ihre Dimensionen. Behalte stabile Gruppierungsmerkmale. Verschiebe eindeutige Identitäten oder Ereignisdetails in die Identitätsfelder, Attribute, vertraulichen Felder oder die Payload eines Ereignisses.
:::
