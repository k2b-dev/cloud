---
id: grids-retention-preservation
title: Aufbewahrung und Erhaltung
icon: ti ti-archive
description: Technische Mindestaufbewahrung festlegen, eine Basis oder Tabelle erhalten und zulässige, nicht mehr referenzierte Dateidaten vernichten.
order: 148
---
Eine Mindestaufbewahrung ist ein optionales technisches Minimum für Datensätze im Papierkorb und neu nicht mehr referenzierte Dateien einer Basis. Sie löscht nichts, plant keine Bereinigung, entscheidet nicht über die Angemessenheit einer Vernichtung und stellt keine Rechtskonformität her.

Du benötigst **Verwalten**-Zugriff auf die Basis. Custom Apps, Workflows, API-Clients und die CLI können diese Berechtigungsprüfung nicht umgehen.

## Mindestaufbewahrung festlegen {icon="calendar-time"}

1. Öffne die Einstellungen der Basis und wähle **Aufbewahrung**.
2. Gib für **Mindestaufbewahrung in Tagen** einen Wert zwischen 1 und 36.500 ein.
3. Prüfe die aktuelle **Aufbewahrungsvorschau**. Sie unterscheidet Datensätze und nicht referenzierte Dateien, die durch den vorgeschlagenen Mindestzeitraum weiterhin aufbewahrt werden, Elemente, die ihn erreicht haben, und unabhängig geschützte Belege.
4. Wähle **Datensätze prüfen**, um die vollständige, seitenweise Liste zu prüfen. **Im Papierkorb öffnen** übergibt Wiederherstellung und Datensatzaktionen an die bestehende Papierkorbansicht der Tabelle.
5. Wähle **Dateien prüfen**, um alle derzeit nicht referenzierten Dateien zu durchsuchen und zu filtern. Unterstützte Formate kannst du als schreibgeschützte Vorschau öffnen oder die exakten gespeicherten Bytes herunterladen.
6. Wähle **Änderungen speichern**.

Bestehende Basen besitzen standardmäßig keine Mindestaufbewahrung. Ihr Verhalten ändert sich deshalb nicht. Die Frist beginnt, wenn ein Datensatz in den Papierkorb verschoben wird. Nach einer Wiederherstellung und einem späteren erneuten Verschieben beginnt sie mit dem neuen Papierkorbzeitpunkt von vorn.

Du kannst dieselbe Basiseinstellung mit der Cloud CLI prüfen und verwalten. Nutze eine Basis-ID aus sechs Zeichen oder den exakten Namen:

```bash
cld grids bases retention 8yMtTb --json
cld grids bases retention preview 8yMtTb --days 30 --json
cld grids bases retention records list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention files list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention set 8yMtTb --days 30 --json
```

Das Verkürzen eines vorhandenen Mindestzeitraums erfordert `--yes`. Das Entfernen erfordert immer `--yes`:

```bash
cld grids bases retention set 8yMtTb --days 14 --yes --json
cld grids bases retention remove 8yMtTb --yes --json
```

Die CLI ruft dieselbe nur mit Verwaltungsrechten zugängliche API wie die Basiseinstellungen auf. Ein Skript, Workflow, eine Custom App oder ein direkter API-Client kann weder den Mindestzeitraum noch seine Berechtigungsprüfung umgehen.

Die Vorschau verwendet einen angegebenen Beobachtungszeitpunkt und gibt begrenzte Beispiele zurück. **Mindestzeitraum erreicht** bedeutet nur, dass die konfigurierte Anzahl von Tagen verstrichen ist. Es bedeutet weder, dass Grids den Datensatz oder die Datei gelöscht hat, noch dass eine Löschung erlaubt ist.

**Datensätze prüfen** und `bases retention records list` durchsuchen Datensatz-ID, Tabellen-ID oder Tabellenname und filtern die aktuelle Papierkorbmenge auf dem Server. Finalisierte Datensätze werden als unabhängig geschützt gekennzeichnet. Die Prüfung dupliziert keine Papierkorbaktionen: Nutze **Im Papierkorb öffnen**, um einen Datensatz über die normale Tabellenansicht zu prüfen oder wiederherzustellen.

## Aufbewahrung von Dateien verstehen {icon="paperclip"}

Wenn ein Anhang seine letzte aktuelle oder geschützte Referenz verliert, bereinigt Grids normalerweise seine gespeicherten Bytes. Bei aktiver Mindestaufbewahrung behält Grids neu nicht referenzierte Bytes stattdessen, bis derselbe Mindestzeitraum verstrichen ist.

Das Verzeichnis zeigt, wie viele nicht referenzierte Dateien bis zu einem späteren Zeitpunkt aufbewahrt werden, wie viele den Mindestzeitraum erreicht haben und ihre gesamte gespeicherte Größe. **Dateien prüfen** öffnet die vollständige aktuelle Kandidatenliste mit serverseitiger Suche nach Dateiname oder Datei-ID, einem Filter für den Status der Mindestaufbewahrung und Seitennavigation. Unterstützte Formate lassen sich schreibgeschützt anzeigen; jede aufgeführte Datei kann heruntergeladen werden. Die Liste verwendet die vorgeschlagene Anzahl von Tagen, einschließlich eines noch nicht gespeicherten Entwurfs.

Die CLI verwendet dieselbe nur mit Verwaltungsrechten zugängliche Grenze für Listen und Downloads:

```bash
cld grids bases retention files list 8yMtTb --days 30 --search invoice --status all --json
cld grids bases retention files download 8yMtTb HeUB3M --out ./retained-file.bin
```

Aktuelle Anhänge und durch Durable History oder unveränderliche Dokumente aufbewahrte Dateien werden von diesen Eigentümern geschützt und nicht als nicht referenzierte Kandidaten aufgeführt.

Das Ersetzen oder Entfernen eines Anhangs kann einen Kandidaten erzeugen. Ein neuer Schutz entfernt ihn aus der Liste. Wenn der letzte Schutz später freigegeben wird, beginnt seine Aufbewahrungsfrist erneut. Prüfung und Download bleiben innerhalb dieser nur mit Verwaltungsrechten zugänglichen Aufbewahrungsoberfläche; die normale Datensatz-API kann eine nicht referenzierte Datei weiterhin nicht ausgeben.

## Mindestaufbewahrung ändern oder entfernen {icon="edit"}

Eine Erhöhung bewahrt betroffene Datensätze im Papierkorb und nicht referenzierte Dateien länger auf. Das Verkürzen oder Entfernen kann eine zukünftige kontrollierte Vernichtung früher ermöglichen. Deshalb verlangt Grids eine Bestätigung. Keine der beiden Aktionen löscht sofort Daten.

Revisionen von Durable History, finalisierte Datensätze, unveränderliche Dokumente, Nummernvergaben, geschützte Dateien, Erhaltungssperren und die tatsächliche kontrollierte Vernichtung behalten ihre getrennten Lebenszyklusverträge.

## Berechtigte nicht referenzierte Dateien vernichten {icon="trash-x"}

Die kontrollierte Dateivernichtung entfernt gespeicherte Bytes neu nicht referenzierter Dateien dauerhaft, nachdem die Mindestaufbewahrung der Basis erreicht wurde. Sie umfasst niemals Datensätze, Datensätze im Papierkorb, Dokumente, Beweisexporte, Durable History oder indirekte Referenzen, die ein anderer Eigentümer zugesichert hat.

Du benötigst **Verwalten**-Zugriff und eine aktive Mindestaufbewahrung. Öffne **Basiseinstellungen → Kontrollierte Vernichtung**. Die Vorschau zeigt die derzeit berechtigte Gesamtmenge und trennt Dateien, die noch aufbewahrt werden, durch eine Erhaltungssperre blockiert sind oder nicht sicher vernichtet werden können. Eine Ausführung enthält höchstens 100 exakte Dateikandidaten.

Wähle **Berechtigte Dateien vernichten**, lies die unumkehrbaren Folgen und gib den exakten Namen der Basis ein. Grids reiht eine dauerhafte Ausführung ein und prüft jede Datei unmittelbar vor der Löschung erneut. Wenn sich ihre Mindestaufbewahrung, Referenzen, Ursprungstabelle oder Erhaltungssperren geändert haben, wird diese Datei übersprungen. Die Ausführung kann deshalb als **teilweise** enden, ohne eine Sperre abzuschwächen oder eine neu referenzierte Datei zu löschen.

Die Liste der letzten Ausführungen zeigt die Anzahl vernichteter, übersprungener und fehlgeschlagener Dateien. **Verbleibende abbrechen** hält noch nicht verarbeitete Dateien an; bereits vernichtete Bytes können nicht wiederhergestellt werden. Aktualisiere die Vorschau, um einen weiteren begrenzten Batch zu starten.

Die Cloud CLI verwendet dieselbe nur mit Verwaltungsrechten zugängliche Vorschau und verantwortliche Ausführung:

```bash
cld grids bases destruction preview 8yMtTb --json
cld grids bases destruction run 8yMtTb --confirm "Example Base" --json
cld grids bases destruction status 8yMtTb RUN001 --json
cld grids bases destruction cancel 8yMtTb RUN001 --yes --json
```

`run` ruft immer eine neue Vorschau ab und wählt nur diese begrenzte Menge aus. Der Befehl verweigert einen leeren Batch oder einen `--confirm`-Wert, der nicht exakt dem Namen der Basis entspricht. Eine eingereihte Ausführung kann sofort abgebrochen werden; eine laufende Ausführung beendet ihre verbleibende Arbeit an der nächsten sicheren Grenze.

## Eine Basis oder eine Tabelle erhalten {icon="lock"}

Eine Erhaltungssperre blockiert zukünftige kontrollierte Vernichtung in ihrem gewählten Bereich. Eine Basissperre gilt für alle Tabellen. Eine Tabellensperre gilt nur für die gewählte Tabelle und blockiert auch die Vernichtung ihrer übergeordneten Basis, damit die Tabellensperre nicht umgangen werden kann. Sperren fixieren keine Datensätze, stoppen keine normalen Bearbeitungen, gewähren keinen Zugriff, ändern die Finalisierung nicht, laufen nicht automatisch ab und entscheiden nicht, ob die Basis eine rechtliche Anforderung erfüllt.

Du benötigst **Verwalten**-Zugriff. Öffne **Basiseinstellungen → Erhaltungssperren** und wähle **Sperre erstellen**. Wähle **Gesamte Basis** oder **Eine Tabelle**. Die Tabellensuche läuft auf dem Server und listet aktive Tabellen dieser Basis auf. Gib einen Grund an, der anderen Personen mit Verwaltungsrechten erklärt, warum die Sperre besteht. Die Liste aktiver Sperren zeigt Bereich, öffentliche ID, erstellende Person, Erstellungszeitpunkt und Grund.

Mehrere Sperren können gleichzeitig aktiv sein. Das Freigeben einer Sperre erfordert einen neuen Grund und lässt alle anderen Sperren aktiv. Das Freigeben der letzten Sperre entfernt nur diese Blockade. Es löscht nichts und startet keine Bereinigung.

Die Cloud CLI verwendet dieselbe nur mit Verwaltungsrechten zugängliche API:

```bash
cld grids bases preservation-holds list 8yMtTb --status active --json
cld grids bases preservation-holds create 8yMtTb --reason "Annual review" --json
cld grids bases preservation-holds create 8yMtTb --scope table --table Invoices --reason "Invoice dispute" --json
cld grids bases preservation-holds list 8yMtTb --scope table --table Invoices --status active --json
cld grids bases preservation-holds release 8yMtTb HOLD01 --reason "Review completed" --yes --json
```

`create` verwendet standardmäßig `--scope base`. Nutze `--status released` oder `--status all`, um ältere Sperren zu prüfen, und `--scope base|table|all`, um die Liste einzugrenzen. Ein exakter Tabellenname löst eine aktive Tabelle auf; ihre öffentliche ID aus sechs Zeichen kann den Sperrverlauf weiterhin filtern, wenn die Tabelle nicht mehr aktiv ist. Tabellensuche, Filterung und Seitennavigation laufen auf dem Server. Ein Workflow, eine Custom App, ein direkter API-Client oder eine Hintergrundaktion kann eine aktive Sperre weder über einen anderen Weg freigeben noch umgehen.
