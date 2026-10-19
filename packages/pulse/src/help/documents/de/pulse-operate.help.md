---
id: pulse-operate
title: Basis betreiben
icon: ti ti-lifebuoy
description: Prüfe Quellen, Aufbewahrung und Zugriff, sende Daten per HTTP-Ingest und behebe Probleme.
order: 140
---
Nutze diese Seite, um Quellen und Zugriff zu prüfen und Daten zu senden.

## Datenspeicher verbinden (Cloud-Admins) {icon="database"}

Öffne **Administration → Pulse → Datenspeicher**. Der Betreiber stellt eine
eigene ClickHouse-Instanz ab Version 26.9 bereit. Wähle das Dienst-Passwort,
hole das **Einrichtungs-Skript** und lass es einmal vom ClickHouse-Admin
ausführen. Trage dann Adresse, Dienst-Zugang und Passwort ein und wähle
**Prüfen und verbinden**. Pulse speichert erst nach erfolgreicher Prüfung.
Eine fehlgeschlagene Prüfung nennt den Grund und die Korrektur; die
gespeicherte Verbindung bleibt dann unverändert.

Derselbe Ablauf steht über `cld pulse admin store` bereit. Übergib Passwörter
nur mit `--password-file` oder `--password-stdin`. Ohne Verbindung bleibt nur
die Pulse-Verwaltung verfügbar.

## Basis regelmäßig prüfen {icon="route"}

:::reference
- **Quellenstatus:** **Quellen** zeigen die letzten Aktualisierungen, Dauer, Fehler, empfangenen Daten und gegebenenfalls die Nutzung von API-Schlüsseln.
- **Zugriff:** Der Zugriff auf eine Basis legt fest, wer sie ansehen, bearbeiten oder verwalten kann.
- **Aufbewahrung:** Pulse kann detaillierte Daten, langfristige Zusammenfassungen und geschützte Ereignisfelder unterschiedlich lange aufbewahren. Geschützte Felder können vor dem übrigen Ereignis ablaufen.
- **Daten löschen:** **Telemetriedaten löschen** verwirft die erfassten Daten.
- **Lange destruktive Vorgänge:** Das Leeren oder Löschen einer großen Basis kann nach deiner Bestätigung einige Zeit dauern. Eine angenommene Anfrage bedeutet, dass der Vorgang begonnen hat, nicht dass alle Daten bereits verschwunden sind.
:::

## Daten per HTTP-Datenaufnahme senden {icon="point"}

:::reference
- **Schreibfehler:** Ungültige Anfragen speichern keine Messwerte. Bei einem Speicherausfall antwortet Pulse mit 503 und einer Wartezeit. Ohne Schlüssel kann der Batch bereits teilweise gespeichert sein. Sende einen `Idempotency-Key` ab dem ersten Versuch und wiederhole denselben Batch mit diesem Schlüssel.
- **Zeitstempel:** Metriken, Ereignisse und Zustände dürfen höchstens fünf Minuten in der Zukunft liegen. Metrikwerte müssen außerdem innerhalb der Rohdatenaufbewahrung liegen.
- **API-Schlüssel gehören zu einer Quelle:** Pulse ordnet empfangene Signale der Quelle zu, der der API-Schlüssel gehört. Ein mit den Daten gesendeter Quellenwert ändert diese Zuordnung nicht.
- **Sicher wiederholbare Anfragen:** Sende denselben `Idempotency-Key`, wenn du einen Batch erneut sendest. Pulse gibt mindestens 24 Stunden lang das ursprüngliche Ergebnis zurück und lehnt die Wiederverwendung mit anderem Inhalt ab.
- **Metrikvarianten überschaubar halten:** Eine Metrik kann in einer Basis bis zu 10.000 Varianten haben. Lege Anfrage-IDs, Sitzungen, vollständige URLs, IP-Adressen und andere eindeutige Werte in Ereignissen ab, nicht in Metrikdimensionen.
:::

## Häufige Probleme beheben {icon="lifebuoy"}

:::reference
- **Eine Metrikquelle wird abgelehnt:** Pulse ruft standardmäßig nur öffentliche Endpunkte ab. Ein Cloud-Admin kann Host, Host:Port oder CIDR für diese Base unter Verwaltung → Pulse → Interne Ziele freigeben. Versuche den Abruf danach erneut.
- **Es erscheinen keine Daten:** Prüfe zuerst die Quelle.
- **Eine Metrik hat zu viele Varianten:** Prüfe ihre Dimensionen. Behalte stabile Gruppierungsmerkmale. Verschiebe eindeutige Identitäten oder Ereignisdetails in die Identitätsfelder, Attribute, vertraulichen Felder oder die Payload eines Ereignisses.
:::

## Eine Base wiederherstellen {icon="database"}

Eine neue Base richtet ihre eigene Datenbank ein und nimmt erst im Zustand
„Aktiv“ Änderungen an. Das Leeren behält Quellen, Tokens und Zugriff. Das Löschen widerruft Tokens und den Lesezugriff. Eine
Base, die gelöscht wird, bleibt auf deiner Pulse-Übersicht, bis sie weg ist. Nach
einem Fehler setzt **Erneut versuchen** den Vorgang fort. Cloud-Admins sehen
Zustand, Profil, Grenzen und gemessenen Speicher unter Verwaltung → Pulse →
Bases, ohne Messdaten-Inhalte.

Kürzere Aufbewahrung braucht eine Bestätigung mit Stichtag, Zeilen und geschätzten
Bytes. Bei sensiblen Feldern zählt Pulse die Felder, die geleert werden; die
Zeilen bleiben. Rohdaten erlauben standardmäßig 1–730 Tage (per Richtlinie bis 3.650),
Stundenwerte 1–3.650 Tage und sensible Felder 1–8.760 Stunden. Sensible Felder
verfallen per Spalten-TTL bei ClickHouse-Merges; aktuelle Zustände verfallen nicht.

Fehlende Datenbanken oder abweichende Prüfpunkte sperren Messdaten-Schreibzugriffe.
Solange die Sperre gilt, kannst du die Base nicht leeren. Nach passenden Sicherungen wählt ein Cloud-Admin **Erneut prüfen**. **Leer neu
anlegen** verwirft Messdaten. Ohne Verbindung bleibt die Pulse-Verwaltung
verfügbar; andere Cloud-Apps arbeiten weiter.

**Stundenwerte hängen hinterher** unter Administration → Pulse → Bases bedeutet,
dass Stundenberechnung oder Versiegelung verzögert sind. Rohdatenpartitionen
bleiben bis zur Versiegelung ihrer Stunden erhalten. Prüfe die Jobs für
Stundenwerte und Aufbewahrung, bevor du Daten leerst.
