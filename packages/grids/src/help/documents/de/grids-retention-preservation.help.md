---
id: grids-retention-preservation
title: Aufbewahrung und Erhaltung
icon: ti ti-archive
description: Lege eine technische Mindestaufbewahrung fest, erhalte eine Base oder Tabelle oder vernichte freigegebene, nicht mehr referenzierte Dateiinhalte.
order: 148
---
Eine Mindestaufbewahrung ist ein optionales technisches Minimum für Datensätze im Papierkorb und neu nicht mehr referenzierte Dateien einer Base.

:::warning Eine Frist ist keine rechtliche Entscheidung
Eine Mindestaufbewahrung löscht nichts und plant keine Bereinigung. Sie entscheidet nicht, ob eine Vernichtung angemessen ist, und stellt keine Rechtskonformität her.
:::

Du brauchst Zugriff **Verwalten** auf die Base. Grids Apps, Workflows, API-Clients und die CLI können diese Zugriffsprüfung nicht umgehen.

## Die Mindestaufbewahrung festlegen {icon="calendar-time"}

:::steps
1. Öffne **Base-Einstellungen → Aufbewahrung**.
2. Gib unter **Mindestaufbewahrung in Tagen** einen Wert von 1 bis 36.500 ein.
3. Prüfe die aktuelle **Aufbewahrungsvorschau**.
4. Wähle **Datensätze prüfen**, um die vollständige Liste seitenweise zu prüfen.
5. Wähle **Dateien prüfen**, um alle derzeit nicht referenzierten Dateien zu durchsuchen und zu filtern.
6. Wähle **Änderungen speichern**.
:::

Die **Aufbewahrungsvorschau** trennt drei Gruppen: Datensätze und nicht referenzierte Dateien, die die vorgeschlagene Frist noch aufbewahrt, Elemente, die die Frist erreicht haben, und unabhängig geschützte Nachweise.

In **Datensätze prüfen** öffnet **Im Papierkorb öffnen** die bestehende Papierkorbansicht der Tabelle, um Datensätze wiederherzustellen oder andere Datensatzaktionen auszuführen. In **Dateien prüfen** kannst du unterstützte Formate als Vorschau öffnen oder die exakt gespeicherten Bytes herunterladen.

Bestehende Bases haben standardmäßig keine Mindestaufbewahrung. Ihr Verhalten ändert sich deshalb nicht. Die Frist beginnt, wenn jemand einen Datensatz in den Papierkorb verschiebt. Stellt jemand den Datensatz wieder her und verschiebt ihn später erneut, beginnt eine neue Frist ab dem neuen Zeitpunkt.

Du kannst dieselbe Einstellung der Base mit der Cloud CLI prüfen und ändern. Verwende die sechsstellige ID der Base oder ihren exakten Namen:

```bash
cld grids bases retention 8yMtTb --json
cld grids bases retention preview 8yMtTb --days 30 --json
cld grids bases retention records list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention files list 8yMtTb --days 30 --status retained --page 1 --per-page 25 --json
cld grids bases retention set 8yMtTb --days 30 --json
```

Das Verkürzen einer bestehenden Frist erfordert `--yes`. Das Entfernen erfordert immer `--yes`:

```bash
cld grids bases retention set 8yMtTb --days 14 --yes --json
cld grids bases retention remove 8yMtTb --yes --json
```

Die CLI ruft dieselbe API auf wie die Base-Einstellungen. Diese API erfordert Zugriff **Verwalten**. Ein Skript, Workflow, eine Grids App oder ein direkter API-Client kann weder die Frist noch ihre Zugriffsprüfung umgehen.

Die Vorschau verwendet einen angegebenen Beobachtungszeitpunkt und liefert begrenzte Beispiele. **Mindestaufbewahrung erreicht** bedeutet nur, dass die konfigurierte Anzahl von Tagen vergangen ist. Es bedeutet weder, dass Grids den Datensatz oder die Datei gelöscht hat, noch dass eine Löschung erlaubt ist.

**Datensätze prüfen** und `bases retention records list` suchen nach Datensatz-ID, Tabellen-ID oder Tabellenname. Sie filtern die aktuelle Menge im Papierkorb auf dem Server. Finalisierte Datensätze sind als unabhängig geschützt gekennzeichnet. Die Prüfung wiederholt keine Papierkorbaktionen. Nutze **Im Papierkorb öffnen**, um einen Datensatz über die normale Tabellenansicht zu prüfen oder wiederherzustellen.

## Die Aufbewahrung von Dateien verstehen {icon="paperclip"}

Verliert ein Anhang seine letzte aktuelle oder geschützte Referenz, bereinigt Grids normalerweise seine gespeicherten Bytes. Solange eine Mindestaufbewahrung aktiv ist, behält Grids neu nicht referenzierte Bytes, bis dieselbe Mindestdauer vergangen ist.

Die Übersicht zeigt, wie viele nicht referenzierte Dateien Grids bis zu einem späteren Zeitpunkt aufbewahrt, wie viele die Frist erreicht haben und ihre gesamte gespeicherte Größe. **Dateien prüfen** öffnet die vollständige aktuelle Liste der Kandidaten. Sie bietet eine serverseitige Suche nach Dateiname oder Datei-ID, einen Filter für den Fristenstatus und Seitennavigation. Unterstützte Formate kannst du schreibgeschützt ansehen. Jede aufgeführte Datei kannst du herunterladen. Die Liste verwendet die vorgeschlagene Anzahl von Tagen, auch aus einem noch nicht gespeicherten Entwurf.

Die CLI verwendet dieselbe Grenze für Liste und Download. Sie erfordert Zugriff **Verwalten**:

```bash
cld grids bases retention files list 8yMtTb --days 30 --search invoice --status all --json
cld grids bases retention files download 8yMtTb HeUB3M --out ./retained-file.bin
```

Aktuelle Anhänge, der dauerhafte Verlauf und unveränderliche Dokumente schützen ihre Dateien selbst. Diese Dateien erscheinen nicht als nicht referenzierte Kandidaten.

Das Ersetzen oder Entfernen eines Anhangs kann einen Kandidaten erzeugen. Ein neuer Schutz entfernt ihn aus der Liste. Endet später der letzte Schutz, beginnt seine Aufbewahrungsfrist erneut. Prüfung und Download bleiben in diesem Aufbewahrungsbereich, der Zugriff **Verwalten** erfordert. Die normale Datensatz-API kann eine nicht referenzierte Datei weiterhin nicht ausgeben.

## Die Mindestaufbewahrung ändern oder entfernen {icon="edit"}

Ein höherer Wert bewahrt betroffene Datensätze im Papierkorb und nicht referenzierte Dateien länger auf. Eine kürzere oder entfernte Frist kann eine künftige kontrollierte Vernichtung früher ermöglichen. Deshalb fragt Grids nach einer Bestätigung. Keine der beiden Änderungen löscht sofort etwas.

Revisionen des dauerhaften Verlaufs, finalisierte Datensätze, unveränderliche Dokumente, Nummernvergaben, geschützte Dateien, Aufbewahrungssperren und die eigentliche kontrollierte Vernichtung behalten ihre eigenen Regeln für den Lebenszyklus.

## Freigegebene nicht referenzierte Dateien vernichten {icon="trash-x"}

Die kontrollierte Dateivernichtung entfernt die gespeicherten Bytes neu nicht referenzierter Dateien dauerhaft, nachdem die Mindestaufbewahrung der Base erreicht ist. Sie umfasst nie Datensätze, Datensätze im Papierkorb, Dokumente, Nachweispakete, den dauerhaften Verlauf oder indirekte Referenzen, die ein anderer Eigentümer schützt.

Du brauchst Zugriff **Verwalten** und eine aktive Mindestaufbewahrung. Öffne **Base-Einstellungen → Kontrollierte Vernichtung**. Die Vorschau zeigt die aktuell freigegebene Gesamtmenge. Sie trennt Dateien, die noch aufbewahrt werden, die eine Aufbewahrungssperre blockiert oder die sich nicht sicher vernichten lassen. Ein Lauf enthält höchstens 100 exakte Dateikandidaten.

:::danger Eine Vernichtung lässt sich nicht rückgängig machen
Vernichtete Dateiinhalte lassen sich nicht wiederherstellen.
:::

:::steps
1. Wähle **Freigegebene Dateien vernichten**.
2. Lies die unumkehrbare Folge.
3. Gib den exakten Namen der Base ein.
4. Wähle **Vernichtung starten**.
:::

Grids reiht einen dauerhaften Lauf ein und prüft jede Datei unmittelbar vor dem Löschen erneut. Haben sich Mindestaufbewahrung, Referenzen, Ursprungstabelle oder Aufbewahrungssperren einer Datei geändert, überspringt Grids diese Datei. Der Lauf kann deshalb als **Teilweise abgeschlossen** enden. Er schwächt nie eine Sperre ab und löscht nie eine neu referenzierte Datei.

Die Liste der letzten Läufe zeigt die Anzahl vernichteter, übersprungener und fehlgeschlagener Dateien. **Ausstehende Arbeit abbrechen** stoppt die Dateien, die Grids noch nicht verarbeitet hat. Bereits vernichtete Bytes bleiben vernichtet. Aktualisiere die Vorschau, um einen weiteren begrenzten Durchgang zu starten.

Die Cloud CLI verwendet dieselbe Vorschau und denselben Lauf. Beide erfordern Zugriff **Verwalten**:

```bash
cld grids bases destruction preview 8yMtTb --json
cld grids bases destruction run 8yMtTb --confirm "Example Base" --json
cld grids bases destruction status 8yMtTb RUN001 --json
cld grids bases destruction cancel 8yMtTb RUN001 --yes --json
```

`run` ruft immer eine neue Vorschau ab und wählt nur diese begrenzte Menge. Der Befehl lehnt einen leeren Durchgang ab und ebenso einen `--confirm`-Wert, der nicht exakt dem Namen der Base entspricht. Einen eingereihten Lauf kannst du sofort abbrechen. Ein bereits gestarteter Lauf beendet seine verbleibende Arbeit an der nächsten sicheren Grenze.

## Eine Base oder eine Tabelle erhalten {icon="lock"}

Eine Aufbewahrungssperre blockiert künftige kontrollierte Vernichtung in ihrem Bereich. Eine Sperre der Base gilt für alle Tabellen. Eine Tabellensperre gilt nur für die gewählte Tabelle. Sie blockiert auch die Vernichtung der übergeordneten Base, damit niemand die Tabellensperre umgehen kann.

Eine Sperre fixiert keine Datensätze, stoppt keine normalen Bearbeitungen, gibt keinen Zugriff, ändert die Finalisierung nicht und läuft nicht automatisch ab. Sie entscheidet nicht, ob die Base eine rechtliche Anforderung erfüllt.

Du brauchst Zugriff **Verwalten**.

:::steps
1. Öffne **Base-Einstellungen → Aufbewahrungssperren**.
2. Wähle **Sperre erstellen**.
3. Wähle **Gesamte Base** oder **Eine Tabelle**.
4. Suche bei einer Tabelle nach ihr. Die Suche läuft auf dem Server und zeigt die aktiven Tabellen dieser Base.
5. Gib einen Grund ein, der anderen Personen mit Zugriff **Verwalten** erklärt, warum die Sperre besteht.
6. Erstelle die Sperre.
:::

Die Liste aktiver Sperren zeigt Bereich, öffentliche ID, erstellende Person, Erstellungszeitpunkt und Grund.

Mehrere Sperren können gleichzeitig aktiv sein. Das Aufheben einer Sperre erfordert einen neuen Grund und lässt alle anderen Sperren aktiv. Das Aufheben der letzten Sperre entfernt nur diese Blockade. Es löscht nichts und startet keine Bereinigung.

Durchsuche aktive Sperren nach Begründung, Tabellenname, erstellender Person oder Sperren-ID. Die Liste ist seitenweise aufgeteilt, damit jeder Treffer erreichbar bleibt. Schlägt das Erstellen oder Aufheben einer Sperre fehl, behält der Dialog deine Begründung und zeigt den Fehler. Du kannst es dann erneut versuchen.

Die Cloud CLI verwendet dieselbe API. Sie erfordert Zugriff **Verwalten**:

```bash
cld grids bases preservation-holds list 8yMtTb --status active --json
cld grids bases preservation-holds list 8yMtTb --search "Invoice dispute" --page 1 --json
cld grids bases preservation-holds create 8yMtTb --reason "Annual review" --json
cld grids bases preservation-holds create 8yMtTb --scope table --table Invoices --reason "Invoice dispute" --json
cld grids bases preservation-holds list 8yMtTb --scope table --table Invoices --status active --json
cld grids bases preservation-holds release 8yMtTb HOLD01 --reason "Review completed" --yes --json
```

`create` verwendet standardmäßig `--scope base`. Nutze `--status released` oder `--status all`, um ältere Sperren zu prüfen. Nutze `--scope base|table|all`, um die Liste einzugrenzen. Ein exakter Tabellenname ermittelt eine aktive Tabelle. Ihre sechsstellige öffentliche ID filtert den Sperrverlauf auch dann, wenn die Tabelle nicht mehr aktiv ist. Tabellensuche, Filterung und Seitennavigation laufen auf dem Server. Ein Workflow, eine Grids App, ein direkter API-Client oder eine Hintergrundaktion kann eine aktive Sperre über keinen anderen Weg aufheben oder umgehen.
